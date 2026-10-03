import { it, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-ignore Executable service.
import { AgentService } from "../packages/agents/service.mjs";
import { createStorage } from "../packages/runtime/storage.mjs";

it("人类更新资料与自己的 Agent 回传并发，房间锁与限流锁顺序一致，不死锁不丢回复", async () => {
  const database = new URL(process.env.DATABASE_URL!);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname);
  const pool = new Pool({ connectionString: database.toString() });
  const user = randomUUID();
  const root = await mkdtemp(resolve(tmpdir(), "island-profile-lock-"));
  const service = new AgentService(
    pool,
    createStorage(pool, { STORAGE_DIR: root }),
  );
  const original = (
    await pool.query(
      "select pg_get_functiondef('island_actor_command(uuid,text,jsonb)'::regprocedure) definition",
    )
  ).rows[0].definition;
  const anchor =
    "update participants set display_name=trim(data->>'display_name'),avatar_url=nullif(data->>'avatar_url','') where user_id=u;";
  expect(original).toContain(anchor);
  // 只在隔离测试 DB 为本次调用加闸门：停在真实 profile/participant 更新之后、emit 之前。
  const patched = original.replace(
    anchor,
    anchor +
      "\nif current_setting('island.test_profile_gate',true)='on' then perform pg_advisory_xact_lock(91820261003);end if;",
  );
  const gate = await pool.connect(),
    a = await pool.connect(),
    b = await pool.connect();
  let room: string | undefined,
    released = false;
  const outcomes: Promise<any>[] = [];
  async function begin(db: any, gated = false) {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    if (gated)
      await db.query("select set_config('island.test_profile_gate','on',true)");
    return (await db.query("select pg_backend_pid() pid")).rows[0].pid;
  }
  async function waiting(pid: number) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (
        (
          await pool.query(
            "select wait_event_type from pg_stat_activity where pid=$1",
            [pid],
          )
        ).rows[0]?.wait_event_type === "Lock"
      )
        return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("隔离 SQL 竞态闸门未到达，不把未触发的测试算作通过。");
  }
  async function call(db: any, command: string, data: any) {
    try {
      await db.query("select island_command($1,$2) result", [
        command,
        JSON.stringify(data),
      ]);
      await db.query("commit");
      return { command, ok: true };
    } catch (e: any) {
      await db.query("rollback");
      return {
        command,
        ok: false,
        code: e.code,
        detail: e.detail,
        where: e.where,
      };
    }
  }
  try {
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        user,
        user + "@profile-lock.invalid",
        JSON.stringify({ display_name: "并发资料验收" }),
      ],
    );
    await begin(a);
    room = (
      await a.query("select island_command('create_room',$1) result", [
        JSON.stringify({ name: "资料与心跳隔离房间" }),
      ])
    ).rows[0].result.id;
    await a.query("commit");
    const invitation = await service.createPairing(user);
    const node = await service.pair({
      code: invitation.code,
      node_name: "并发回传设备",
      agent_name: "并发回传助手",
      adapter: "cli",
      fingerprint: randomUUID(),
      capabilities: { egress_v2: true },
    });
    const seat = await service.addAgentToRoom(user, room, node.node_id);
    await service.seatAction(user, room, "approve", {
      participant_id: seat.participant_id,
    });
    const connection = await service.connect(node.token);
    await begin(a);
    await a.query("select island_command('message',$1)", [
      JSON.stringify({
        room_id: room,
        content: "请进行一次并发回传",
        client_message_id: randomUUID(),
        mentioned_participant_ids: [seat.participant_id],
      }),
    ]);
    await a.query("commit");
    const job = await service.claim(node.token, connection.session_id);
    const controlled = new AgentService(
      {
        async connect() {
          return {
            query: (sql: string, args: any[]) => b.query(sql, args),
            release() {},
          };
        },
      },
      service.storage,
    );
    await pool.query(patched);
    await gate.query("begin");
    await gate.query("select pg_advisory_xact_lock(91820261003)");
    const aid = await begin(a, true);
    outcomes.push(
      call(a, "profile", { display_name: "已更新资料", avatar_url: "" }),
    );
    await waiting(aid);
    const bid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
    outcomes.push(
      controlled
        .complete(
          node.token,
          job.id,
          job.lease,
          { message: "并发 Agent 最终回传" },
          connection.session_id,
        )
        .then(
          () => ({ command: "agent_complete", ok: true }),
          (e: any) => ({
            command: "agent_complete",
            ok: false,
            code: e.code,
            detail: e.detail,
            where: e.where,
          }),
        ),
    );
    await waiting(bid);
    await gate.query("rollback");
    released = true;
    const results = await Promise.all(outcomes);
    expect(results).toEqual([
      { command: "profile", ok: true },
      { command: "agent_complete", ok: true },
    ]);
    const state = (
      await pool.query(
        "select p.display_name,p.last_active_at from participants p where room_id=$1 and user_id=$2",
        [room, user],
      )
    ).rows[0];
    expect(state.display_name).toBe("已更新资料");
    expect(
      (
        await pool.query(
          "select 1 from messages where room_id=$1 and content=$2",
          [room, "并发 Agent 最终回传"],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    if (!released) await gate.query("rollback");
    await Promise.allSettled(outcomes);
    await pool.query(original);
    await a.query("rollback");
    await b.query("rollback");
    gate.release();
    a.release();
    b.release();
    if (room) await pool.query("delete from rooms where id=$1", [room]);
    await pool.query("delete from auth.users where id=$1", [user]);
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});

it("等待限流锁期间新增房间，资料更新整体回滚并允许用新快照重试", async () => {
  const database = new URL(process.env.DATABASE_URL!);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname);
  const pool = new Pool({ connectionString: database.toString() });
  const user = randomUUID(),
    rooms: string[] = [];
  const original = (
    await pool.query(
      "select pg_get_functiondef('island_actor_command(uuid,text,jsonb)'::regprocedure) definition",
    )
  ).rows[0].definition;
  expect(original).toContain("room_before_rate_limit_v1");
  const gate = await pool.connect(),
    profile = await pool.connect(),
    creator = await pool.connect();
  const anchor = "b:=floor(extract(epoch from now())/60);";
  let outcome: Promise<any> | undefined,
    released = false;
  async function begin(db: any, flag = false) {
    await db.query("begin");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      user,
    ]);
    if (flag)
      await db.query("select set_config('island.test_profile_gate','on',true)");
  }
  async function create() {
    await begin(creator);
    rooms.push(
      (
        await creator.query("select island_command('create_room',$1) result", [
          JSON.stringify({ name: "资料快照并发房间" }),
        ])
      ).rows[0].result.id,
    );
    await creator.query("commit");
  }
  try {
    await pool.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
      [
        user,
        user + "@profile-context.invalid",
        JSON.stringify({ display_name: "原始昵称" }),
      ],
    );
    await create();
    await pool.query(
      original.replace(
        anchor,
        "if command='profile' and current_setting('island.test_profile_gate',true)='on' then perform pg_advisory_xact_lock(91820261003);end if;\n" +
          anchor,
      ),
    );
    await gate.query("begin");
    await gate.query("select pg_advisory_xact_lock(91820261003)");
    await begin(profile, true);
    const pid = (await profile.query("select pg_backend_pid() pid")).rows[0]
      .pid;
    outcome = profile
      .query("select island_command('profile',$1)", [
        JSON.stringify({ display_name: "重试后昵称" }),
      ])
      .then(
        async () => {
          await profile.query("commit");
          return { ok: true };
        },
        async (e: any) => {
          await profile.query("rollback");
          return { code: e.code };
        },
      );
    const until = Date.now() + 5000;
    let locked = false;
    while (Date.now() < until) {
      if (
        (
          await pool.query(
            "select wait_event_type from pg_stat_activity where pid=$1",
            [pid],
          )
        ).rows[0]?.wait_event_type === "Lock"
      ) {
        locked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      locked,
      "必须在真实锁阶段新增房间，不能用未触发的竞态测试冒充成功",
    ).toBe(true);
    await create();
    await gate.query("rollback");
    released = true;
    expect(await outcome).toEqual({ code: "40001" });
    expect(
      (
        await pool.query("select display_name from profiles where id=$1", [
          user,
        ])
      ).rows[0].display_name,
    ).toBe("原始昵称");
    expect(
      (
        await pool.query(
          "select sum(count)::int n from command_limits where user_id=$1",
          [user],
        )
      ).rows[0].n,
    ).toBe(2);
    await begin(profile);
    await profile.query("select island_command('profile',$1)", [
      JSON.stringify({ display_name: "重试后昵称" }),
    ]);
    await profile.query("commit");
    expect(
      (
        await pool.query(
          "select display_name from participants where user_id=$1 order by room_id",
          [user],
        )
      ).rows.map((p: any) => p.display_name),
    ).toEqual(["重试后昵称", "重试后昵称"]);
    expect(
      (
        await pool.query(
          "select sum(count)::int n from command_limits where user_id=$1",
          [user],
        )
      ).rows[0].n,
    ).toBe(3);
  } finally {
    if (!released) await gate.query("rollback");
    await outcome;
    await pool.query(original);
    await profile.query("rollback");
    await creator.query("rollback");
    gate.release();
    profile.release();
    creator.release();
    for (const room of rooms)
      await pool.query("delete from rooms where id=$1", [room]);
    await pool.query("delete from auth.users where id=$1", [user]);
    await pool.end();
  }
});
