import { NextRequest, NextResponse } from "next/server";
import { repositoryRoot } from "@island/runtime";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountSchema,
  roomSchema,
  validateFile,
  safeFileName,
} from "@island/protocol";
import {
  AppError,
  pool,
  identity,
  setSession,
  userQuery,
  command,
  ensureRoom,
  passwordHash,
  verifyPassword,
  hash,
  storeFile,
  loadFile,
  removeFile,
  validContent,
} from "@/lib/server";
import { subscribe } from "@/lib/realtime";
import { agents } from "@/lib/agents";
import { AgentError } from "@island/agents";
import { nodeClientBundle } from "@island/agents/client-bundle";
import { scanFile } from "@/lib/scanner";
import {
  publicSite,
  settings,
  capabilities,
  checkIp,
  requestIp,
  loginEvent,
  recordMetric,
} from "@/lib/control";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = z.uuid();
const messages: Record<string, string> = {
  FORBIDDEN: "你没有执行此操作的权限",
  HOST_REQUIRED: "只有主持人可以执行此操作",
  TRANSFER_BEFORE_LEAVING: "请先转移主持人再离开房间",
  INVALID_INVITE: "邀请已失效或过期",
  INVITE_EXHAUSTED: "邀请使用次数已达到上限",
  INVALID_TARGET: "请选择有效成员",
  INVALID_ASSIGNEE: "负责人必须是当前房间成员",
  INVALID_ATTACHMENT: "附件无效",
  ACCOUNT_BANNED: "账号已被封禁",
  MAINTENANCE: "网站正在维护",
  ROOM_FROZEN: "房间已冻结，当前只读",
  ROOM_DISABLED: "当前不可创建房间",
  POST_DISABLED: "当前账号被限制发言",
  TASK_DISABLED: "任务功能暂不可用",
  UPLOAD_DISABLED: "当前不可上传文件",
  STORAGE_LIMIT: "文件大小或房间容量超过限制",
  FILE_TYPE_DISABLED: "此文件类型未开放上传",
  FILE_UNAVAILABLE: "文件已被隔离或删除",
  RATE_LIMITED: "操作太频繁，请稍后再试",
};
const loginLimits = new Map<string, { count: number; expires: number }>();
function limit(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "local";
  const current = loginLimits.get(ip);
  if (!current || current.expires < Date.now()) {
    loginLimits.set(ip, { count: 1, expires: Date.now() + 60000 });
    return;
  }
  if (++current.count > 30) throw new AppError(429, "登录尝试过多，请稍后再试");
  if (loginLimits.size > 10000)
    for (const [key, val] of loginLimits)
      if (val.expires < Date.now()) loginLimits.delete(key);
}
async function readBody(req: NextRequest, max: number) {
  const reader = req.body?.getReader();
  if (!reader) throw new AppError(400, "请求内容为空");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new AppError(413, "请求内容超出大小限制");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req: NextRequest) {
  const bytes = await readBody(
    req,
    /\/rooms\/[^/]+\/agents\//.test(req.nextUrl.pathname) ? 1024 * 1024 : 65536,
  );
  try {
    return JSON.parse(bytes.toString());
  } catch {
    throw new AppError(400, "请求内容格式无效");
  }
}
async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  try {
    await checkIp(req);
    const { path } = await ctx.params;
    const key = path.join("/");
    const mutating = req.method === "POST";
    if (mutating) {
      const origin = req.headers.get("origin");
      const expected = process.env.APP_ORIGIN || "http://localhost:3000";
      if (origin && origin !== expected)
        throw new AppError(403, "请求来源无效");
      if (req.headers.get("x-island-request") !== "1")
        throw new AppError(403, "请求校验失败");
    }
    if (key === "site") {
      const after = z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.nextUrl.searchParams.get("after") || 0);
      return NextResponse.json(await publicSite(after), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path[0] === "brand" && path[1] && !mutating) {
      const asset = (
        await pool.query(
          "select mime_type,bytes from brand_assets where id=$1",
          [uuid.parse(path[1])],
        )
      ).rows[0];
      if (!asset) throw new AppError(404, "品牌资源不存在");
      return new Response(new Uint8Array(asset.bytes), {
        headers: {
          "Content-Type": asset.mime_type,
          "Cache-Control": "public,max-age=31536000,immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (key === "health") {
      await pool.query("select 1");
      const installation = await pool.query(
        "select id from app_installation where singleton",
      );
      return NextResponse.json({
        ok: true,
        installation_id: installation.rows[0]?.id || null,
        instance_key: hash(repositoryRoot()).slice(0, 24),
      });
    }
    if (key === "auth/register" || key === "auth/login") {
      if (!mutating) throw new AppError(405, "请求方式无效");
      limit(req);
      const input = accountSchema.parse(await jsonBody(req));
      const email = input.email.toLowerCase();
      let id: string;
      if (key === "auth/register") {
        const ops = (await settings()).operations;
        if (!ops.registration || ops.maintenance)
          throw new AppError(
            403,
            ops.maintenance ? "网站正在维护" : "网站暂未开放注册",
          );
        if (!input.display_name) throw new AppError(400, "请输入昵称");
        const db = await pool.connect();
        try {
          await db.query("begin");
          await db.query("select pg_advisory_xact_lock_shared(91820261001)");
          const current = (
            await db.query(
              "select value from site_settings where key='operations'",
            )
          ).rows[0].value;
          if (!current.registration || current.maintenance)
            throw new AppError(403, "网站暂未开放注册");
          id = randomUUID();
          await db.query(
            "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
            [id, email, JSON.stringify({ display_name: input.display_name })],
          );
          await db.query("insert into auth.local_credentials values($1,$2)", [
            id,
            passwordHash(input.password),
          ]);
          await db.query("commit");
        } catch (e) {
          await db.query("rollback");
          if ((e as { code: string }).code === "23505")
            throw new AppError(409, "该邮箱已注册");
          throw e;
        } finally {
          db.release();
        }
      } else {
        const { rows } = await pool.query(
          "select u.id,c.password_hash from auth.users u join auth.local_credentials c on c.user_id=u.id where email=$1",
          [email],
        );
        if (!rows[0]) {
          await loginEvent(req, email, false);
          passwordHash(input.password);
          throw new AppError(401, "邮箱或密码错误");
        }
        if (!verifyPassword(input.password, rows[0].password_hash)) {
          await loginEvent(req, email, false, rows[0].id);
          throw new AppError(401, "邮箱或密码错误");
        }
        const st = (
          await pool.query("select effective_status($1) status", [rows[0].id])
        ).rows[0].status;
        if (st === "banned") {
          await loginEvent(req, email, false, rows[0].id);
          throw new AppError(403, "账号已被封禁");
        }
        id = rows[0].id;
      }
      await setSession(id, {
        ip: requestIp(req),
        userAgent: req.headers.get("user-agent") || "",
      });
      await loginEvent(req, email, true, id);
      return NextResponse.json({ user: await identity() });
    }
    const user = await identity();
    if (key === "auth/me") return NextResponse.json({ user });
    if (key !== "auth/logout") {
      const ops = (await settings()).operations;
      if (
        ops.maintenance &&
        !(
          await pool.query("select 1 from admin_members where user_id=$1", [
            user.id,
          ])
        ).rowCount
      )
        throw new AppError(503, ops.maintenance_message);
    }
    if (key === "auth/logout" && mutating) {
      const jar = await cookies();
      const token = jar.get("island_session")?.value;
      if (token)
        await pool.query(
          "delete from auth.local_sessions where token_hash=$1",
          [hash(token)],
        );
      jar.delete("island_session");
      return NextResponse.json({ ok: true });
    }
    if (key === "rooms" && !mutating) {
      const rooms = await userQuery(
        user,
        async (db) =>
          (
            await db.query(
              `select r.*,
   (select max(m.created_at) from messages m where m.room_id=r.id) last_message_at,
   (select coalesce(nullif(m.content,''),'已撤回') from messages m where m.room_id=r.id order by created_at desc,id desc limit 1) last_message,
   (select count(*)::int from events e join messages m on m.id=e.entity_id where e.room_id=r.id and e.id>p.last_read_event_id and e.type='message.created' and m.sender_participant_id<>p.id) unread_count
   from rooms r join participants p on p.room_id=r.id and p.user_id=$1 and p.status='active' order by coalesce((select max(m.created_at) from messages m where m.room_id=r.id),r.created_at) desc,r.updated_at desc`,
              [user.id],
            )
          ).rows,
      );
      return NextResponse.json({ rooms });
    }
    if (key === "tasks" && !mutating) {
      const tasks = await userQuery(
        user,
        async (db) =>
          (
            await db.query(
              `select t.*,r.name room_name,r.icon room_icon,coalesce((select jsonb_agg(jsonb_build_object('participant_id',a.participant_id)) from task_assignees a where a.task_id=t.id),'[]') task_assignees from tasks t join rooms r on r.id=t.room_id where flag_enabled('tasks',auth.uid(),t.room_id) and exists(select 1 from task_assignees a join participants p on p.id=a.participant_id where a.task_id=t.id and p.user_id=$1) order by t.created_at desc`,
              [user.id],
            )
          ).rows,
      );
      return NextResponse.json({ tasks });
    }
    if (key === "command" && mutating) {
      const body = z
        .object({
          command: z.string(),
          data: z.record(z.string(), z.unknown()),
        })
        .parse(await jsonBody(req));
      const allowed = [
        "report",
        "create_room",
        "join_invite",
        "update_room",
        "invite",
        "revoke_invite",
        "transfer_host",
        "remove_member",
        "leave_room",
        "delete_room",
        "message",
        "delete_message",
        "react",
        "create_task",
        "update_task",
        "read",
        "presence",
        "profile",
      ];
      if (!allowed.includes(body.command)) throw new AppError(400, "操作无效");
      if (["create_room", "update_room"].includes(body.command))
        roomSchema.parse(body.data);
      if (body.command === "message")
        z.object({
          content: z.string().trim().min(1).max(8000),
          client_message_id: z.uuid(),
          mentioned_participant_ids: z.array(z.uuid()).max(100).optional(),
        }).parse(body.data);
      if (body.command === "profile") {
        z.object({
          display_name: z.string().trim().min(1).max(40),
          avatar_url: z
            .union([
              z.literal(""),
              z.url().refine((s) => s.startsWith("https://")),
            ])
            .optional(),
        }).parse(body.data);
      }
      const cleanup =
        body.command === "delete_room"
          ? await userQuery(
              user,
              async (db) =>
                (
                  await db.query(
                    "select storage_path from files where room_id=$1",
                    [body.data.room_id],
                  )
                ).rows,
            )
          : [];
      if (body.command === "report")
        z.object({
          room_id: z.uuid(),
          target_id: z.uuid(),
          target_type: z.enum(["message", "file", "user", "room"]),
          reason: z.string().trim().min(3).max(2000),
        }).parse(body.data);
      const result = await command(user, body.command, body.data);
      for (const f of cleanup)
        await removeFile(f.storage_path).catch(() =>
          console.error("Object cleanup pending", f.storage_path),
        );
      return NextResponse.json(result);
    }
    if (path[0] === "rooms" && path[1]) {
      const roomId = uuid.parse(path[1]);
      await ensureRoom(user, roomId);
      if (path[2] === "agents") {
        if (!mutating) {
          if (path[3] === "client")
            return new Response(
              new Uint8Array(await nodeClientBundle(repositoryRoot())),
              {
                headers: {
                  "Content-Type": "application/zip",
                  "Content-Disposition":
                    "attachment; filename=island-node-client.zip",
                  "Cache-Control": "private,no-store",
                },
              },
            );
          if (path[3] === "merge-preview")
            return NextResponse.json(
              await agents.mergePreview(
                user.id,
                roomId,
                uuid.parse(req.nextUrl.searchParams.get("session_id")),
              ),
            );
          return NextResponse.json(await agents.state(user.id, roomId));
        }
        const input = await jsonBody(req);
        const action = path[3];
        let result;
        if (action === "pairing")
          result = await agents.createPairing(user.id, roomId);
        else if (action === "revoke-pairing")
          result = await agents.revokePairing(
            user.id,
            roomId,
            input.pairing_id,
          );
        else if (
          ["approve", "reject", "revoke", "mute", "host"].includes(action)
        )
          result = await agents.seatAction(user.id, roomId, action, input);
        else if (action === "brief")
          result = await agents.publishBrief(user.id, roomId, input);
        else if (action === "acknowledge")
          result = await agents.acknowledge(user.id, roomId, input.brief_id);
        else if (action === "start")
          result = await agents.startSession(user.id, roomId, input);
        else if (
          ["stop", "pause", "resume", "plan", "approve-plan"].includes(action)
        )
          result = await agents.sessionAction(user.id, roomId, action, input);
        else if (action === "review")
          result = await agents.reviewArtifact(user.id, roomId, input);
        else if (action === "retry-work")
          result = await agents.retryWork(user.id, roomId, input.task_id);
        else if (action === "merge")
          result = await agents.merge(user.id, roomId, input);
        else throw new AppError(400, "Agent 操作无效");
        return NextResponse.json(result);
      }
      if (path[2] === "events") {
        const after = z.coerce
          .number()
          .int()
          .min(0)
          .parse(req.nextUrl.searchParams.get("after") || 0);
        if (req.nextUrl.searchParams.get("stream") !== "1") {
          const events = await userQuery(
            user,
            async (db) =>
              (
                await db.query(
                  "select * from events where room_id=$1 and id>$2 order by id limit 500",
                  [roomId, after],
                )
              ).rows,
          );
          return NextResponse.json({ events });
        }
        const streamId = randomUUID();
        await pool.query(
          "insert into realtime_connections(id,user_id,room_id) values($1,$2,$3)",
          [streamId, user.id, roomId],
        );
        await pool.query(
          "insert into realtime_stream_log(id,user_id,room_id,recovered_cursor) values($1,$2,$3,$4)",
          [streamId, user.id, roomId, after > 0],
        );
        const sessionToken =
          (await cookies()).get("island_session")?.value || "";
        const encoder = new TextEncoder();
        let cursor = after;
        let ended = false;
        let busy = false;
        let again = false;
        let close = () => {};
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown, id?: number) => {
              if (!ended)
                controller.enqueue(
                  encoder.encode(
                    `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
            };
            const sync = async () => {
              if (ended) return;
              if (busy) {
                again = true;
                return;
              }
              busy = true;
              try {
                const session = await pool.query(
                  "select 1 from auth.local_sessions where token_hash=$1 and user_id=$2 and expires_at>now()",
                  [hash(sessionToken), user.id],
                );
                if (!session.rowCount) {
                  send("expired", {});
                  close();
                  return;
                }
                await pool.query(
                  "update realtime_connections set last_seen_at=now() where id=$1",
                  [streamId],
                );
                await ensureRoom(user, roomId);
                let batch;
                do {
                  batch = await userQuery(
                    user,
                    async (db) =>
                      (
                        await db.query(
                          "select * from events where room_id=$1 and id>$2 order by id limit 500",
                          [roomId, cursor],
                        )
                      ).rows,
                  );
                  for (const event of batch) {
                    cursor = Number(event.id);
                    send("island", event, cursor);
                  }
                } while (batch.length === 500 && !ended);
                send("synced", { cursor });
              } catch (error) {
                if (error instanceof AppError && error.status === 403)
                  send("revoked", {});
                else send("retrying", {});
                close();
              } finally {
                busy = false;
                if (again) {
                  again = false;
                  void sync();
                }
              }
            };
            const unsubscribe = await subscribe(roomId, () => void sync());
            const timer = setInterval(() => void sync(), 5000);
            const lifetime = setTimeout(
              () => {
                send("refresh", {});
                close();
              },
              25 * 60 * 1000,
            );
            close = () => {
              if (ended) return;
              ended = true;
              clearInterval(timer);
              clearTimeout(lifetime);
              unsubscribe();
              void pool
                .query(
                  "update realtime_stream_log set closed_at=now() where id=$1",
                  [streamId],
                )
                .catch(() => {});
              void pool
                .query("delete from realtime_connections where id=$1", [
                  streamId,
                ])
                .catch(() => {});
              req.signal.removeEventListener("abort", close);
              try {
                controller.close();
              } catch {}
            };
            req.signal.addEventListener("abort", close, { once: true });
            if (req.signal.aborted) {
              close();
              return;
            }
            send("ready", {});
            await sync();
          },
          cancel() {
            close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }
      if (path[2] === "invites") {
        const invites = await userQuery(
          user,
          async (db) =>
            (
              await db.query(
                "select id,expires_at,max_uses,used_count,revoked_at from room_invites where room_id=$1 order by created_at desc",
                [roomId],
              )
            ).rows,
        );
        return NextResponse.json({ invites });
      }
      if (path[2] === "files" && mutating) {
        const ops = (await settings()).operations;
        const caps = await capabilities(user, roomId);
        if (!caps.uploads) throw new AppError(403, "当前不可上传文件");
        const room = (
          await pool.query("select status from rooms where id=$1", [roomId])
        ).rows[0];
        if (room.status !== "active") throw new AppError(403, "房间当前只读");
        const maxSize = ops.max_file_mb * 1048576;
        if (Number(req.headers.get("content-length") || 0) > maxSize + 100000)
          throw new AppError(413, `文件不能超过 ${ops.max_file_mb}MB`);
        const raw = await readBody(req, maxSize + 100000);
        const form = await new Response(new Uint8Array(raw), {
          headers: { "Content-Type": req.headers.get("content-type") || "" },
        }).formData();
        const file = form.get("file");
        if (
          !(file instanceof File) ||
          !validateFile(file.name, file.type, file.size, maxSize)
        )
          throw new AppError(
            400,
            `文件格式或大小无效（最大 ${ops.max_file_mb}MB）`,
          );
        if (
          !ops.allowed_extensions.includes(
            file.name.split(".").pop()?.toLowerCase(),
          )
        )
          throw new AppError(400, "此文件类型未开放上传");
        const bytes = Buffer.from(await file.arrayBuffer());
        if (!validContent(bytes, file.type))
          throw new AppError(400, "文件内容与类型不一致");
        const scan = await scanFile(bytes, file.type);
        if (scan.status === "rejected")
          throw new AppError(400, "文件未通过安全检查");
        const id = randomUUID();
        const storage_path = `${roomId}/${id}`;
        await storeFile(storage_path, bytes, file.type);
        try {
          await command(user, "register_file", {
            id,
            room_id: roomId,
            name: safeFileName(file.name),
            size: file.size,
            mime_type: file.type,
            storage_path,
          });
        } catch (e) {
          await removeFile(storage_path);
          throw e;
        }
        return NextResponse.json({ id });
      }
      if (path.length === 2) {
        const before = req.nextUrl.searchParams.get("before")?.split("|");
        if (
          before &&
          (before.length !== 2 ||
            !z.iso.datetime({ offset: true }).safeParse(before[0]).success ||
            !uuid.safeParse(before[1]).success)
        )
          throw new AppError(400, "历史记录游标无效");
        const state = await userQuery(
          user,
          async (db) => {
            const room = (
              await db.query("select * from rooms where id=$1", [roomId])
            ).rows[0];
            const participants = (
              await db.query(
                "select * from participants where room_id=$1 order by joined_at",
                [roomId],
              )
            ).rows;
            const messages = (
              await db.query(
                `select m.*,to_char(m.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,(select to_jsonb(q) from messages q where q.id=m.reply_to_message_id) reply_context,coalesce((select jsonb_agg(jsonb_build_object('emoji',x.emoji,'participant_id',x.participant_id)) from message_reactions x where x.message_id=m.id),'[]') reactions from messages m where room_id=$1 ${before ? "and (created_at,id)<($2::timestamptz,$3::uuid)" : ""} order by m.created_at desc,m.id desc limit 101`,
                before ? [roomId, before[0], before[1]] : [roomId],
              )
            ).rows;
            const tasks = (
              await db.query(
                "select t.*,(select to_jsonb(q) from messages q where q.id=t.source_message_id) source_message,coalesce((select jsonb_agg(jsonb_build_object('participant_id',a.participant_id)) from task_assignees a where a.task_id=t.id),'[]') task_assignees,coalesce((select jsonb_agg(jsonb_build_object('file_id',f.file_id)) from task_files f where f.task_id=t.id),'[]') task_files from tasks t where room_id=$1 order by created_at desc",
                [roomId],
              )
            ).rows;
            const files = (
              await db.query(
                "select * from files where room_id=$1 order by created_at desc",
                [roomId],
              )
            ).rows;
            const cursor = Number(
              (
                await db.query(
                  "select coalesce(max(id),0) cursor from events where room_id=$1",
                  [roomId],
                )
              ).rows[0].cursor,
            );
            return {
              room,
              participants,
              messages: messages.slice(0, 100).reverse(),
              tasks,
              files,
              cursor,
              has_more: messages.length > 100,
            };
          },
          true,
        );
        return NextResponse.json({
          ...state,
          capabilities: await capabilities(user, roomId),
        });
      }
    }
    if (path[0] === "files" && path[1]) {
      const id = uuid.parse(path[1]);
      const file = await userQuery(
        user,
        async (db) =>
          (await db.query("select * from files where id=$1", [id])).rows[0],
      );
      if (!file) throw new AppError(403, "你没有访问此文件的权限");
      if (file.status !== "normal")
        throw new AppError(
          403,
          file.status === "quarantined" ? "文件已被隔离" : "文件已被删除",
        );
      const bytes = await loadFile(file.storage_path);
      const preview =
        req.nextUrl.searchParams.get("preview") === "1" &&
        file.mime_type.startsWith("image/");
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": preview ? file.mime_type : "application/octet-stream",
          "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    throw new AppError(404, "页面不存在");
  } catch (e) {
    if (e instanceof z.ZodError)
      return NextResponse.json(
        {
          error: "请输入有效信息",
          details: e.issues.map((i) => i.path.join(".")),
        },
        { status: 400 },
      );
    if (e instanceof AppError || e instanceof AgentError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    const err = e as { message: string; code: string };
    const code = Object.keys(messages).find((k) => err.message?.includes(k));
    if (code)
      return NextResponse.json(
        { error: messages[code] },
        { status: code === "RATE_LIMITED" ? 429 : 403 },
      );
    if (["22P02", "23502", "23503", "23514"].includes(err.code))
      return NextResponse.json(
        { error: "输入信息无效，请检查后重试" },
        { status: 400 },
      );
    console.error("API failure", err.message);
    return NextResponse.json(
      { error: "服务暂时不可用，请稍后重试" },
      { status: 500 },
    );
  }
}
async function measured(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const start = performance.now(),
    trace = randomUUID();
  const res = await handle(req, ctx);
  res.headers.set("X-Trace-ID", trace);
  const userId = (await identity().catch(() => null))?.id || null;
  await recordMetric(
    req,
    res.status,
    start,
    trace,
    userId,
    Number(res.headers.get("content-length") || 0),
  );
  return res;
}
export const GET = measured;
export const POST = measured;
