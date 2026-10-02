import { agents } from "@/lib/agents";
import { generateUser } from "@/lib/admin-user-create";
import { AgentError } from "@island/agents";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  pool,
  AppError,
  validContent,
  loadFile,
  removeFile,
} from "@/lib/server";
import { adminIdentity, checkIp, requestIp, recordMetric } from "@/lib/control";
import {
  actionSchemas,
  reasonSchema,
  settingSchemas,
} from "@/lib/admin-policy";
import {
  adminList,
  overview,
  filters,
  userDetail,
  roomDetail,
  operationData,
  securityData,
  systemData,
  toCSV,
} from "@/lib/admin-data";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const errors: Record<string, string> = {
  ADMIN_REQUIRED: "需要网站管理员权限",
  ADMIN_FORBIDDEN: "当前角色无权执行此操作",
  REASON_REQUIRED: "请填写至少 3 个字的操作原因",
  CONFIRM_REQUIRED: "请确认此操作及目标对象",
  LAST_SUPER_ADMIN: "必须保留至少一名超级管理员",
  INVALID_TARGET: "目标不存在或状态无效",
  TRANSFER_BEFORE_LEAVING: "请先转移主持人再移出该成员",
  INVALID_ASSIGNEE: "负责人必须为当前房间成员",
};
async function body(req: NextRequest) {
  const bytes = await bounded(req, 65536);
  try {
    return JSON.parse(bytes.toString());
  } catch {
    throw new AppError(400, "请求格式无效");
  }
}
async function bounded(req: NextRequest, max: number) {
  const reader = req.body?.getReader();
  if (!reader) throw new AppError(400, "请求为空");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new AppError(413, "请求超出大小限制");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const started = performance.now(),
    trace = randomUUID();
  let userId: string | null = null;
  let attempted: { action: string; data: Record<string, unknown> } | null =
    null;
  const response = async (r: Response) => {
    r.headers.set("X-Trace-ID", trace);
    r.headers.set("Cache-Control", "no-store");
    await recordMetric(
      req,
      r.status,
      started,
      trace,
      userId,
      Number(r.headers.get("content-length") || 0),
    );
    return r;
  };
  try {
    await checkIp(req);
    const { path } = await ctx.params;
    let module = path[0];
    if (module === "command" || module === "brand") module = "overview";
    const user = await adminIdentity(
      module === "settings" || module === "feature-flags"
        ? "operations"
        : module,
    );
    userId = user.id;
    const isWrite = req.method !== "GET";
    if (isWrite) {
      if (req.headers.get("x-island-request") !== "1")
        throw new AppError(403, "请求校验失败");
      const origin = req.headers.get("origin");
      if (
        origin &&
        origin !== (process.env.APP_ORIGIN || "http://localhost:3000")
      )
        throw new AppError(403, "请求来源无效");
    }
    if (path[0] === "agents" && path[1] === "policy") {
      return response(
        NextResponse.json(
          await agents.adminPolicy(
            user.id,
            isWrite ? await body(req) : undefined,
          ),
        ),
      );
    }
    if (path[0] === "agents" && path[1] === "revoke" && req.method === "POST") {
      const input = z
        .object({
          node_id: z.uuid(),
          reason: z.string().trim().min(3).max(2000),
          confirm: z.literal(true),
        })
        .parse(await body(req));
      return response(
        NextResponse.json(
          await agents.adminRevoke(user.id, input.node_id, input.reason),
        ),
      );
    }
    if (
      path[0] === "users" &&
      path[1] === "generate" &&
      req.method === "POST"
    ) {
      return response(
        NextResponse.json(
          await generateUser(pool, user.id, await body(req), {
            ip: requestIp(req),
            trace,
          }),
        ),
      );
    }
    if (path[0] === "brand" && req.method === "POST") {
      if (user.role !== "super")
        throw new AppError(403, "仅超级管理员可以上传品牌资源");
      const raw = await bounded(req, 2 * 1048576 + 100000);
      const form = await new Response(new Uint8Array(raw), {
        headers: { "Content-Type": req.headers.get("content-type") || "" },
      }).formData();
      const file = form.get("file");
      const reason = reasonSchema.parse({ reason: form.get("reason") }).reason;
      if (
        !(file instanceof File) ||
        file.size > 2 * 1048576 ||
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/x-icon",
          "image/vnd.microsoft.icon",
        ].includes(file.type)
      )
        throw new AppError(400, "品牌图片支持 PNG/JPG/WebP/ICO，最大 2MB");
      const bytes = Buffer.from(await file.arrayBuffer());
      const ico = bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
      if (file.type.includes("icon") ? !ico : !validContent(bytes, file.type))
        throw new AppError(400, "图片内容与类型不一致");
      const id = randomUUID();
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query(
          "insert into brand_assets(id,mime_type,bytes) values($1,$2,$3)",
          [id, file.type, bytes],
        );
        await db.query(
          "insert into admin_audit_logs(admin_id,action,target_type,target_id,reason,ip,trace_id) values($1,'brand_asset','brand',$2,$3,$4,$5)",
          [user.id, id, reason, requestIp(req), trace],
        );
        await db.query("commit");
      } catch (e) {
        await db.query("rollback");
        throw e;
      } finally {
        db.release();
      }
      return response(NextResponse.json({ url: `/api/brand/${id}` }));
    }
    if (
      path[0] === "files" &&
      path[1] &&
      path[2] === "download" &&
      req.method === "GET"
    ) {
      const reason = reasonSchema.parse({
        reason: req.nextUrl.searchParams.get("reason"),
      }).reason;
      const db = await pool.connect();
      let result;
      try {
        await db.query("begin");
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
          user.id,
        ]);
        result = (
          await db.query("select island_admin_command($1,$2,$3) result", [
            "file_view",
            JSON.stringify({
              id: z.uuid().parse(path[1]),
              reason,
              confirm: true,
            }),
            JSON.stringify({ ip: requestIp(req), trace_id: trace }),
          ])
        ).rows[0].result;
        await db.query("commit");
      } catch (e) {
        await db.query("rollback");
        throw e;
      } finally {
        db.release();
      }
      const file = result.data,
        bytes = await loadFile(file.storage_path);
      return response(
        new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "Content-Length": String(bytes.length),
            "X-Content-Type-Options": "nosniff",
          },
        }),
      );
    }
    if (isWrite) {
      let input = await body(req),
        action: string;
      if (path[0] === "command") {
        action = z.string().parse(input.action);
        input = input.data;
      } else if (path[0] === "settings") {
        action = "settings";
        input = { ...input, key: path[1] };
      } else if (path[0] === "feature-flags") {
        action = "feature_flag";
        input = { ...input, key: path[1] };
      } else {
        const map: Record<string, string> = {
          "users/restrict": "restrict_user",
          "users/revoke-sessions": "revoke_sessions",
          "rooms/freeze": "room_status",
          "rooms/transfer-host": "transfer_host",
          "reports/resolve": "resolve_report",
          "files/quarantine": "file_status",
          "invites/revoke": "invite_update",
        };
        action = map[`${path[0]}/${path[2]}`];
        input = { ...input, id: path[1] };
        if (path[2] === "freeze") input.status = "frozen";
        if (path[2] === "quarantine") input.status = "quarantined";
        if (path[2] === "revoke") input.revoke = true;
      }
      const base = reasonSchema.parse(input);
      let data: Record<string, unknown>;
      if (action === "settings") {
        const key = z
          .enum(["brand", "information", "analytics", "operations"])
          .parse(input.key);
        data = { key, value: settingSchemas[key].parse(input.value), ...base };
      } else {
        const schema = actionSchemas[action as keyof typeof actionSchemas];
        if (!schema) throw new AppError(400, "管理操作无效");
        data = { ...schema.parse(input), ...base };
      }
      if (action === "ip_rule" && requestIp(req)) {
        const blocked = (
          await pool.query("select $1::inet <<= $2::cidr blocked", [
            requestIp(req),
            data.network,
          ])
        ).rows[0].blocked;
        if (blocked)
          throw new AppError(400, "不能限制当前管理来源，请保留恢复入口");
      }
      attempted = { action, data };
      const db = await pool.connect();
      let result;
      try {
        await db.query("begin");
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
          user.id,
        ]);
        result = (
          await db.query("select island_admin_command($1,$2,$3) result", [
            action,
            JSON.stringify(data),
            JSON.stringify({ ip: requestIp(req), trace_id: trace }),
          ])
        ).rows[0].result;
        await db.query("commit");
      } catch (e) {
        await db.query("rollback");
        throw e;
      } finally {
        db.release();
      }
      if (action === "orphan_cleanup") {
        const jobs = (
          await pool.query(
            "select path from storage_cleanup_jobs order by created_at limit 1000",
          )
        ).rows;
        let pending = 0;
        for (const job of jobs) {
          try {
            await removeFile(job.path);
          } catch (e) {
            pending++;
            await pool.query(
              "update storage_cleanup_jobs set last_error=$2 where path=$1",
              [job.path, (e as Error).message.slice(0, 300)],
            );
          }
        }
        result.pending_cleanup = pending;
      }
      if (action === "content_view") {
        const m = result.data;
        const context = (
          await pool.query(
            "select m.*,p.display_name sender_name from messages m left join participants p on p.id=m.sender_participant_id where m.room_id=$1 and m.created_at between $2::timestamptz-interval '2 minutes' and $2::timestamptz+interval '2 minutes' order by m.created_at limit 10",
            [m.room_id, m.created_at],
          )
        ).rows;
        result.context = context;
      }
      return response(NextResponse.json(result));
    }
    if (path[0] === "overview") {
      const result = await overview(filters(req.nextUrl));
      if (req.nextUrl.searchParams.get("format") === "csv") {
        await pool.query(
          "insert into admin_audit_logs(admin_id,action,target_type,reason,trace_id,ip) values($1,'export','overview','导出运营趋势统计',$2,$3)",
          [user.id, trace, requestIp(req)],
        );
        return response(
          new Response(toCSV(result.trends), {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="overview.csv"',
            },
          }),
        );
      }
      return response(NextResponse.json(result));
    }
    if (path[0] === "users" && path[1])
      return response(NextResponse.json(await userDetail(path[1])));
    if (path[0] === "rooms" && path[1])
      return response(NextResponse.json(await roomDetail(path[1])));
    if (path[0] === "operations")
      return response(NextResponse.json(await operationData()));
    if (path[0] === "system")
      return response(NextResponse.json(await systemData()));
    if (path[0] === "security")
      return response(NextResponse.json(await securityData(user)));
    const f = filters(req.nextUrl),
      data = await adminList(path[0], f);
    if (req.nextUrl.searchParams.get("format") === "csv") {
      if (
        !["users", "rooms", "audit", "events", "files", "invites"].includes(
          path[0],
        )
      )
        throw new AppError(400, "此模块不支持导出");
      await pool.query(
        "insert into admin_audit_logs(admin_id,action,target_type,reason,trace_id,ip) values($1,'export',$2,'管理员导出当前筛选结果',$3,$4)",
        [user.id, path[0], trace, requestIp(req)],
      );
      return response(
        new Response(toCSV(data.items), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${path[0]}.csv"`,
          },
        }),
      );
    }
    return response(NextResponse.json(data));
  } catch (e) {
    const code = Object.keys(errors).find((k) =>
      (e as Error).message?.includes(k),
    );
    const status =
      e instanceof AppError || e instanceof AgentError
        ? e.status
        : e instanceof z.ZodError
          ? 400
          : code
            ? 403
            : ["22P02", "23514", "23503", "23505"].includes(
                  (e as { code: string }).code,
                )
              ? 400
              : 500;
    if (attempted && userId)
      await pool
        .query(
          "insert into admin_audit_logs(admin_id,action,target_type,target_id,reason,result,ip,trace_id) values($1,$2,'attempt',$3,$4,'failed',$5,$6)",
          [
            userId,
            attempted.action,
            String(attempted.data.id || attempted.data.key || ""),
            attempted.data.reason,
            requestIp(req),
            trace,
          ],
        )
        .catch(() => {});
    if (status === 500)
      console.error("Admin API error", trace, (e as Error).message);
    return response(
      NextResponse.json(
        {
          error:
            e instanceof AppError || e instanceof AgentError
              ? e.message
              : code
                ? errors[code]
                : status === 400
                  ? "输入信息无效，请检查字段"
                  : "服务暂时不可用",
          trace_id: trace,
          details: e instanceof z.ZodError ? e.issues : undefined,
        },
        { status },
      ),
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
