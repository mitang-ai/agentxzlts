import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres",
});
const [superId, ops, tech, member, other] = Array.from({ length: 5 }, () =>
  randomUUID(),
);
const users = [superId, ops, tech, member, other];
let room: string, host: string, message: string, file: string, report: string;
const traces: string[] = [];
let flags: any[], settings: any[];
async function asUser(u: string, sql: string, args: unknown[] = []) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [u]);
    await db.query("set local role authenticated");
    const rows = (await db.query(sql, args)).rows;
    await db.query("commit");
    return rows;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
const cmd = async (u: string, c: string, d: Record<string, unknown>) =>
  (
    await asUser(u, "select island_command($1,$2) result", [
      c,
      JSON.stringify(d),
    ])
  )[0].result;
const admin = async (u: string, a: string, d: Record<string, unknown>) => {
  const trace = randomUUID();
  traces.push(trace);
  return (
    await asUser(u, "select island_admin_command($1,$2,$3) result", [
      a,
      JSON.stringify({ reason: "数据库集成验收", confirm: true, ...d }),
      JSON.stringify({ trace_id: trace }),
    ])
  )[0].result;
};
beforeAll(async () => {
  flags = (await pool.query("select * from feature_flags")).rows;
  settings = (await pool.query("select * from site_settings")).rows;
  for (const u of users)
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        u,
        `${u}@admin-test.invalid`,
        JSON.stringify({ display_name: "后台测试" }),
      ],
    );
  await pool.query(
    "insert into admin_members(user_id,role) values($1,'super'),($2,'operations'),($3,'technical')",
    [superId, ops, tech],
  );
  room = (
    await cmd(member, "create_room", { name: "后台联动测试", icon: "🏝️" })
  ).id;
  host = (
    await pool.query(
      "select id from participants where room_id=$1 and user_id=$2",
      [room, member],
    )
  ).rows[0].id;
  const inv = await cmd(member, "invite", { room_id: room });
  await cmd(other, "join_invite", { token: inv.token });
  message = (
    await cmd(member, "message", {
      room_id: room,
      content: "消息内容不应复制到审计",
      client_message_id: randomUUID(),
    })
  ).id;
});
afterAll(async () => {
  for (const f of flags)
    await pool.query(
      "update feature_flags set enabled=$2,scope=$3,targets=$4,rollout=$5 where key=$1",
      [f.key, f.enabled, f.scope, f.targets, f.rollout],
    );
  for (const s of settings)
    await pool.query("update site_settings set value=$2 where key=$1", [
      s.key,
      s.value,
    ]);
  await pool.query("delete from reports where reporter_id=any($1)", [users]);
  await pool.query("delete from rooms where id=$1", [room]);
  await pool.query("delete from storage.objects where name like $1", [
    `${room}/%`,
  ]);
  await pool.query(
    "delete from admin_audit_logs where trace_id=any($1::uuid[])",
    [traces],
  );
  await pool.query(
    "delete from control_events where target_user_id=any($1) or entity_id=$2",
    [users, room],
  );
  await pool.query("delete from storage_cleanup_jobs where path like $1", [
    `${room}/%`,
  ]);
  await pool.query("delete from auth.users where id=any($1)", [users]);
  await pool.end();
});
describe.sequential("后台同源权限、事务与前台联动", () => {
  it("普通用户不能调用管理员命令或直读管理表，也不能绕过核心规则", async () => {
    await expect(
      admin(member, "restrict_user", { id: other, status: "banned" }),
    ).rejects.toThrow("ADMIN_REQUIRED");
    await expect(
      asUser(member, "select * from admin_members"),
    ).rejects.toThrow();
    await expect(
      asUser(member, "select island_core_command('message','{}')"),
    ).rejects.toThrow();
  });
  it("固定角色在数据库再次校验", async () => {
    await expect(
      admin(tech, "room_status", { id: room, status: "frozen" }),
    ).rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(
      admin(ops, "feature_flag", {
        key: "tasks",
        enabled: false,
        scope: "all",
        targets: [],
        rollout: 100,
      }),
    ).rejects.toThrow("ADMIN_FORBIDDEN");
    await expect(
      admin(ops, "settings", { key: "brand", value: { name: "测试" } }),
    ).rejects.toThrow("ADMIN_FORBIDDEN");
  });
  it("危险操作缺少确认或原因时拒绝且不写业务状态", async () => {
    await expect(
      admin(ops, "room_status", { id: room, status: "frozen", confirm: false }),
    ).rejects.toThrow("CONFIRM_REQUIRED");
    await expect(
      admin(ops, "room_status", { id: room, status: "frozen", reason: "" }),
    ).rejects.toThrow("REASON_REQUIRED");
    expect(
      (await pool.query("select status from rooms where id=$1", [room])).rows[0]
        .status,
    ).toBe("active");
  });
  it("冻结房间保留读取，所有用户写入均被拒绝；解除后恢复", async () => {
    await admin(ops, "room_status", { id: room, status: "frozen" });
    expect(
      (await asUser(other, "select * from rooms where id=$1", [room])).length,
    ).toBe(1);
    await expect(
      cmd(other, "message", {
        room_id: room,
        content: "绕过前台",
        client_message_id: randomUUID(),
      }),
    ).rejects.toThrow("ROOM_FROZEN");
    await expect(
      cmd(member, "create_task", { room_id: room, title: "冻结任务" }),
    ).rejects.toThrow("ROOM_FROZEN");
    await admin(ops, "room_status", { id: room, status: "active" });
  });
  it("上传隔离保留文件元数据并生成房间事件，支持恢复", async () => {
    file = randomUUID();
    await pool.query(
      "insert into storage.objects(bucket_id,name,metadata) values('room-files',$1,$2)",
      [
        `${room}/${file}`,
        JSON.stringify({ size: 100, mimetype: "text/plain" }),
      ],
    );
    await cmd(member, "register_file", {
      id: file,
      room_id: room,
      name: "test.txt",
      size: 100,
      mime_type: "text/plain",
      storage_path: `${room}/${file}`,
    });
    await admin(ops, "file_status", { id: file, status: "quarantined" });
    expect(
      (await asUser(other, "select status from files where id=$1", [file]))[0]
        .status,
    ).toBe("quarantined");
    expect(
      (
        await pool.query(
          "select 1 from events where room_id=$1 and type='file.updated'",
          [room],
        )
      ).rowCount,
    ).toBeGreaterThan(0);
    await admin(ops, "file_status", { id: file, status: "normal" });
  });
  it("细粒度限制同时保护发言、建房、上传", async () => {
    for (const [status, action, data, error] of [
      [
        "limited_post",
        "message",
        { content: "被限制", client_message_id: randomUUID() },
        "POST_DISABLED",
      ],
      [
        "limited_room",
        "create_room",
        { name: "被限制", icon: "🏝️" },
        "ROOM_DISABLED",
      ],
      [
        "limited_upload",
        "register_file",
        { id: randomUUID() },
        "UPLOAD_DISABLED",
      ],
    ] as const) {
      await admin(ops, "restrict_user", { id: other, status });
      await expect(
        cmd(other, action, { room_id: room, ...data }),
      ).rejects.toThrow(error);
    }
    await admin(ops, "restrict_user", { id: other, status: "normal" });
  });
  it("过期限制自动恢复；封禁撤销全部 Session 且数据库写入拒绝", async () => {
    await admin(ops, "restrict_user", {
      id: other,
      status: "limited_post",
      until: new Date(Date.now() - 1000).toISOString(),
    });
    expect(
      (await pool.query("select effective_status($1) s", [other])).rows[0].s,
    ).toBe("normal");
    await pool.query(
      "insert into auth.local_sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 day')",
      [randomUUID(), other],
    );
    await admin(ops, "restrict_user", { id: other, status: "banned" });
    expect(
      (
        await pool.query("select 1 from auth.local_sessions where user_id=$1", [
          other,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(
      cmd(other, "message", {
        room_id: room,
        content: "绕过封禁",
        client_message_id: randomUUID(),
      }),
    ).rejects.toThrow("ACCOUNT_BANNED");
    await admin(ops, "restrict_user", { id: other, status: "normal" });
  });
  it("任务开关禁用 API，指定用户/房间与百分比灰度确定且一致", async () => {
    await admin(tech, "feature_flag", {
      key: "tasks",
      enabled: false,
      scope: "all",
      targets: [],
      rollout: 100,
    });
    await expect(
      cmd(member, "create_task", { room_id: room, title: "关闭任务" }),
    ).rejects.toThrow("TASK_DISABLED");
    await admin(tech, "feature_flag", {
      key: "tasks",
      enabled: true,
      scope: "users",
      targets: [member],
      rollout: 100,
    });
    expect(
      (
        await pool.query(
          "select flag_enabled('tasks',$1,$3) a,flag_enabled('tasks',$2,$3) b",
          [member, other, room],
        )
      ).rows[0],
    ).toEqual({ a: true, b: false });
    await admin(tech, "feature_flag", {
      key: "tasks",
      enabled: true,
      scope: "rooms",
      targets: [room],
      rollout: 100,
    });
    expect(
      (await pool.query("select flag_enabled('tasks',$1,$2) a", [other, room]))
        .rows[0].a,
    ).toBe(true);
    await admin(tech, "feature_flag", {
      key: "tasks",
      enabled: true,
      scope: "percentage",
      targets: [],
      rollout: 0,
    });
    expect(
      (await pool.query("select flag_enabled('tasks',$1,$2) a", [other, room]))
        .rows[0].a,
    ).toBe(false);
    await admin(tech, "feature_flag", {
      key: "tasks",
      enabled: true,
      scope: "all",
      targets: [],
      rollout: 100,
    });
  });
  it("已实现的 Agent 与联机席位可以由技术管理员停用和重新启用", async () => {
    for (const enabled of [false, true]) {
      await admin(tech, "feature_flag", {
        key: "agents",
        enabled,
        scope: "all",
        targets: [],
        rollout: 100,
      });
      expect(
        (
          await pool.query("select flag_enabled('agents',$1,$2) enabled", [
            other,
            room,
          ])
        ).rows[0].enabled,
      ).toBe(enabled);
    }
  });
  it("用户举报验证房间资格；处置事务同时软删除消息、保留回复关联并记录审计", async () => {
    report = (
      await cmd(other, "report", {
        room_id: room,
        target_type: "message",
        target_id: message,
        reason: "集成测试举报内容",
      })
    ).id;
    await expect(
      cmd(superId, "report", {
        room_id: room,
        target_type: "message",
        target_id: message,
        reason: "无权限举报",
      }),
    ).rejects.toThrow("FORBIDDEN");
    const viewed = await admin(ops, "content_view", { id: message });
    expect(viewed.data.content).toBe("消息内容不应复制到审计");
    expect(
      JSON.stringify(
        (
          await pool.query(
            "select before,after from admin_audit_logs where id=$1",
            [viewed.audit_id],
          )
        ).rows,
      ),
    ).not.toContain("消息内容不应");
    await admin(ops, "resolve_report", {
      id: report,
      resolution_action: "delete_message",
    });
    expect(
      (
        await pool.query(
          "select content,deleted_at from messages where id=$1",
          [message],
        )
      ).rows[0].deleted_at,
    ).toBeTruthy();
    expect(
      (await pool.query("select status from reports where id=$1", [report]))
        .rows[0].status,
    ).toBe("resolved");
  });
  it("转移主持人以 Participant 为身份并产生同步事件", async () => {
    const participant = (
      await pool.query(
        "select id from participants where room_id=$1 and user_id=$2",
        [room, other],
      )
    ).rows[0].id;
    await admin(ops, "transfer_host", {
      id: room,
      participant_id: participant,
    });
    expect(
      (
        await asUser(
          member,
          "select host_participant_id from rooms where id=$1",
          [room],
        )
      )[0].host_participant_id,
    ).toBe(participant);
    await admin(ops, "transfer_host", { id: room, participant_id: host });
  });
  it("软删除房间不可读，恢复后原消息和成员仍关联", async () => {
    await admin(ops, "room_status", { id: room, status: "deleted" });
    expect(
      await asUser(member, "select * from rooms where id=$1", [room]),
    ).toEqual([]);
    await expect(
      cmd(member, "message", {
        room_id: room,
        content: "删除房间",
        client_message_id: randomUUID(),
      }),
    ).rejects.toThrow("FORBIDDEN");
    await admin(ops, "room_status", { id: room, status: "active" });
    expect(
      (await asUser(member, "select * from rooms where id=$1", [room])).length,
    ).toBe(1);
  });
  it("邀请撤销立即阻止加入且审计不含邀请 Token 哈希", async () => {
    const inv = await cmd(member, "invite", { room_id: room });
    const result = await admin(ops, "invite_update", {
      id: inv.id,
      revoke: true,
    });
    await expect(
      cmd(other, "join_invite", { token: inv.token }),
    ).rejects.toThrow("INVALID_INVITE");
    expect(JSON.stringify(result)).not.toContain("token_hash");
  });
  it("仅撤销指定 Session，其他 Session 保留", async () => {
    const sessions = (
      await pool.query(
        "insert into auth.local_sessions(token_hash,user_id,expires_at) values($1,$3,now()+interval '1 day'),($2,$3,now()+interval '1 day') returning id",
        [randomUUID(), randomUUID(), other],
      )
    ).rows;
    await admin(ops, "revoke_sessions", {
      id: other,
      session_id: sessions[0].id,
    });
    expect(
      (
        await pool.query("select 1 from auth.local_sessions where id=$1", [
          sessions[1].id,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("维护模式服务端拒绝普通用户，管理员可继续操作；全局事件持久化", async () => {
    const value = settings.find((s) => s.key === "operations").value;
    await admin(superId, "settings", {
      key: "operations",
      value: { ...value, maintenance: true },
    });
    await expect(
      cmd(member, "message", {
        room_id: room,
        content: "维护写入",
        client_message_id: randomUUID(),
      }),
    ).rejects.toThrow("MAINTENANCE");
    await admin(superId, "settings", { key: "operations", value });
    expect(
      (
        await pool.query(
          "select 1 from control_events where type='settings.updated'",
        )
      ).rowCount,
    ).toBeGreaterThan(0);
  });
  it("不能移除或封禁最后一位超级管理员", async () => {
    if (
      (
        await pool.query(
          "select count(*)::int n from admin_members where role='super'",
        )
      ).rows[0].n === 1
    ) {
      await expect(
        admin(superId, "admin_member", { id: superId, role: "remove" }),
      ).rejects.toThrow("LAST_SUPER_ADMIN");
      await expect(
        admin(superId, "restrict_user", { id: superId, status: "banned" }),
      ).rejects.toThrow("LAST_SUPER_ADMIN");
    }
  });
});
