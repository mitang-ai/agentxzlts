import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const users = [randomUUID(), randomUUID(), randomUUID()];
let room: string;
let host: string;
let member: string;
let invite: string;
let msg: string;
let task: string;
async function query(user: string, sql: string, args: unknown[] = []) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    await db.query("set local role authenticated");
    const result = await db.query(sql, args);
    await db.query("commit");
    return result.rows;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
const command = async (
  user: string,
  name: string,
  data: Record<string, unknown>,
) =>
  (
    await query(user, "select island_command($1,$2) result", [
      name,
      JSON.stringify(data),
    ])
  )[0].result;
beforeAll(async () => {
  for (const [i, id] of users.entries())
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        id,
        `${id}@test.invalid`,
        JSON.stringify({ display_name: `测试成员${i}` }),
      ],
    );
});
afterAll(async () => {
  if (room) await pool.query("delete from rooms where id=$1", [room]);
  await pool.query("delete from auth.users where id=any($1)", [users]);
  await pool.end();
});
describe.sequential("真实 PostgreSQL 事务、RLS 与 Event", () => {
  it("创建房间产生唯一主持人和完整事件", async () => {
    room = (
      await command(users[0], "create_room", { name: "集成测试", icon: "🏝️" })
    ).id;
    host = (
      await query(users[0], "select * from participants where room_id=$1", [
        room,
      ])
    )[0].id;
    expect(
      (await query(users[0], "select * from rooms where id=$1", [room]))[0]
        .host_participant_id,
    ).toBe(host);
    expect(
      (
        await query(
          users[0],
          "select type from events where room_id=$1 order by id",
          [room],
        )
      ).map((x) => x.type),
    ).toEqual(["room.created", "participant.joined"]);
  });
  it("非成员不能读取房间和事件、直接写表被拒绝", async () => {
    expect(
      await query(users[2], "select * from rooms where id=$1", [room]),
    ).toEqual([]);
    expect(
      await query(users[2], "select * from events where room_id=$1", [room]),
    ).toEqual([]);
    await expect(
      query(users[0], "update rooms set name='入侵' where id=$1", [room]),
    ).rejects.toThrow();
    await expect(
      command(users[2], "message", {
        room_id: room,
        content: "入侵",
        client_message_id: randomUUID(),
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("邀请只保存哈希、容量限制且重复加入不消耗次数", async () => {
    invite = (
      await command(users[0], "invite", {
        room_id: room,
        max_uses: 1,
        hours: 24,
      })
    ).token;
    const stored = (
      await pool.query("select * from room_invites where room_id=$1", [room])
    ).rows[0];
    expect(stored.token_hash).not.toBe(invite);
    expect(stored.token_hash).toHaveLength(64);
    await command(users[1], "join_invite", { token: invite });
    await command(users[1], "join_invite", { token: invite });
    expect(
      (
        await pool.query(
          "select used_count from room_invites where room_id=$1",
          [room],
        )
      ).rows[0].used_count,
    ).toBe(1);
    await expect(
      command(users[2], "join_invite", { token: invite }),
    ).rejects.toThrow("INVITE_EXHAUSTED");
    member = (
      await query(
        users[1],
        "select id from participants where user_id=$1 and room_id=$2",
        [users[1], room],
      )
    )[0].id;
  });
  it("重试发送同一消息只有一次写入和事件", async () => {
    const id = randomUUID();
    const data = {
      room_id: room,
      content: "为周末准备行程",
      client_message_id: id,
      mentioned_participant_ids: [member],
    };
    msg = (await command(users[0], "message", data)).id;
    expect((await command(users[0], "message", data)).id).toBe(msg);
    expect(
      (
        await query(
          users[0],
          "select * from messages where client_message_id=$1",
          [id],
        )
      ).length,
    ).toBe(1);
    expect(
      (await query(users[0], "select * from events where entity_id=$1", [msg]))
        .length,
    ).toBe(1);
  });
  it("聊天转任务、多人负责人和权限边界", async () => {
    task = (
      await command(users[1], "create_task", {
        room_id: room,
        title: "准备行程",
        source_message_id: msg,
        assignee_ids: [host, member],
      })
    ).id;
    expect(
      (
        await query(users[1], "select * from task_assignees where task_id=$1", [
          task,
        ])
      ).length,
    ).toBe(2);
    await command(users[1], "update_task", {
      room_id: room,
      task_id: task,
      status: "in_progress",
    });
    await expect(
      command(users[1], "update_task", {
        room_id: room,
        task_id: task,
        assignee_ids: [member],
      }),
    ).rejects.toThrow("HOST_REQUIRED");
    await command(users[0], "update_task", {
      room_id: room,
      task_id: task,
      status: "completed",
    });
    expect(
      (await query(users[1], "select * from tasks where id=$1", [task]))[0]
        .completed_at,
    ).toBeTruthy();
    expect(
      (
        await query(users[0], "select type from events where entity_id=$1", [
          task,
        ])
      ).map((x) => x.type),
    ).toContain("task.completed");
  });
  it("过期与撤销邀请不能加入", async () => {
    const expired = await command(users[0], "invite", {
      room_id: room,
      hours: 1,
      max_uses: 2,
    });
    await pool.query(
      "update room_invites set expires_at=now()-interval '1 second' where id=$1",
      [expired.id],
    );
    await expect(
      command(users[2], "join_invite", { token: expired.token }),
    ).rejects.toThrow("INVALID_INVITE");
    const revoked = await command(users[0], "invite", {
      room_id: room,
      hours: 1,
      max_uses: 2,
    });
    await command(users[0], "revoke_invite", {
      room_id: room,
      invite_id: revoked.id,
    });
    await expect(
      command(users[2], "join_invite", { token: revoked.token }),
    ).rejects.toThrow("INVALID_INVITE");
  });
  it("普通成员不能更新未分配给自己的任务", async () => {
    const own = (
      await command(users[1], "create_task", {
        room_id: room,
        title: "只分配给主持人",
        assignee_ids: [host],
      })
    ).id;
    await expect(
      command(users[1], "update_task", {
        room_id: room,
        task_id: own,
        status: "completed",
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("不能注册不存在或跨房间的存储对象", async () => {
    const id = randomUUID();
    await expect(
      command(users[1], "register_file", {
        id,
        room_id: room,
        name: "fake.txt",
        mime_type: "text/plain",
        size: 10,
        storage_path: `${room}/${id}`,
      }),
    ).rejects.toThrow("INVALID_ATTACHMENT");
  });
  it("并发主持人转移只允许一个操作获胜", async () => {
    const isolated = (
      await command(users[0], "create_room", {
        name: "事务并发验收",
        icon: "🌿",
      })
    ).id;
    try {
      const link = (
        await command(users[0], "invite", {
          room_id: isolated,
          max_uses: 2,
          hours: 1,
        })
      ).token;
      await command(users[1], "join_invite", { token: link });
      await command(users[2], "join_invite", { token: link });
      const people = await query(
        users[0],
        "select id,user_id from participants where room_id=$1",
        [isolated],
      );
      const results = await Promise.allSettled(
        [1, 2].map((i) =>
          command(users[0], "transfer_host", {
            room_id: isolated,
            participant_id: people.find((p) => p.user_id === users[i])!.id,
          }),
        ),
      );
      expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
      const hosts = await query(
        users[0],
        "select host_participant_id from rooms where id=$1",
        [isolated],
      );
      expect(hosts).toHaveLength(1);
      expect(
        people.filter((p) => p.id === hosts[0].host_participant_id),
      ).toHaveLength(1);
    } finally {
      await pool.query("delete from rooms where id=$1", [isolated]);
    }
  });
  it("主持人转移立即撤销旧权限，不能直接离开", async () => {
    await expect(
      command(users[0], "leave_room", { room_id: room }),
    ).rejects.toThrow("TRANSFER_BEFORE_LEAVING");
    await command(users[0], "transfer_host", {
      room_id: room,
      participant_id: member,
    });
    await expect(
      command(users[0], "invite", { room_id: room }),
    ).rejects.toThrow("HOST_REQUIRED");
    await command(users[1], "update_room", {
      room_id: room,
      name: "新主持人的房间",
      icon: "🌿",
    });
    expect(
      (
        await query(
          users[0],
          "select host_participant_id from rooms where id=$1",
          [room],
        )
      )[0].host_participant_id,
    ).toBe(member);
  });
  it("移除成员立即撤销读取权限，保留历史引用", async () => {
    await command(users[1], "remove_member", {
      room_id: room,
      participant_id: host,
    });
    expect(
      await query(users[0], "select * from messages where room_id=$1", [room]),
    ).toEqual([]);
    expect(
      (await query(users[1], "select * from messages where id=$1", [msg]))[0]
        .sender_participant_id,
    ).toBe(host);
  });
  it("Event Cursor 能按顺序补齐数据", async () => {
    const events = await query(
      users[1],
      "select * from events where room_id=$1 order by id",
      [room],
    );
    const cursor = events[2].id;
    const rest = await query(
      users[1],
      "select * from events where room_id=$1 and id>$2 order by id",
      [room, cursor],
    );
    expect(rest.map((x) => x.id)).toEqual(events.slice(3).map((x) => x.id));
  });
  it("跨房间引用和伪 Agent 创建被拒绝", async () => {
    const other = (
      await command(users[2], "create_room", { name: "隔离房间", icon: "📚" })
    ).id;
    try {
      await expect(
        command(users[2], "create_task", {
          room_id: other,
          title: "跨房间任务",
          source_message_id: msg,
        }),
      ).rejects.toThrow();
      await expect(
        command(users[2], "agent", { room_id: other }),
      ).rejects.toThrow("UNKNOWN_COMMAND");
    } finally {
      await command(users[2], "delete_room", { room_id: other });
    }
  });
});
