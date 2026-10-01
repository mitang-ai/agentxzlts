"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  House,
  Users,
  Box,
  FileText,
  Flag,
  Folder,
  Link,
  Settings,
  Shield,
  Activity,
  ClipboardList,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  RefreshCw,
  Download,
  Plus,
  LogOut,
  Menu,
  CheckCircle2,
  Database,
  MessageCircle,
  ListTodo,
  Globe,
  Bot,
} from "lucide-react";
import { api, ApiError, size } from "@/lib/client";
import { permissions, type AdminRole } from "@/lib/admin-policy";
import { SiteBrand } from "./SiteProvider";
import "./admin.css";
type Row = Record<string, any>;
type AdminUser = {
  id: string;
  display_name: string;
  email: string;
  role: AdminRole;
};
const nav = [
  { section: "overview", name: "概览", icon: House, group: "平台" },
  { section: "users", name: "用户", icon: Users, group: "平台" },
  { section: "rooms", name: "房间", icon: Box, group: "平台" },
  { section: "content", name: "内容", icon: FileText, group: "平台" },
  { section: "reports", name: "举报", icon: Flag, group: "平台" },
  { section: "files", name: "文件", icon: Folder, group: "平台" },
  { section: "invites", name: "邀请", icon: Link, group: "运营" },
  { section: "operations", name: "运营设置", icon: Settings, group: "运营" },
  { section: "system", name: "系统状态", icon: Activity, group: "系统" },
  { section: "agents", name: "Agent 联机", icon: Bot, group: "系统" },
  { section: "security", name: "安全与管理员", icon: Shield, group: "安全" },
  { section: "audit", name: "操作日志", icon: ClipboardList, group: "安全" },
];
const titles: Record<string, string> = Object.fromEntries(
  nav.map((n) => [n.section, n.name]),
);
const hints: Record<string, string> = {
  overview: "查看真实运营数据、风险提醒与最近管理动作。",
  users: "管理用户资料、使用情况、限制状态及登录会话。",
  rooms: "查询房间、成员与协作资源，处理异常房间。",
  content: "通过消息 ID 或房间 ID 定位内容；查看正文需要原因并记录审计。",
  reports: "审核用户举报，记录处理原因并同步前台状态。",
  files: "管理私有文件资源，隔离、恢复与查询容量。",
  invites: "管理邀请使用次数和有效期，不暴露可使用的邀请令牌。",
  operations: "配置网站品牌、信息、统计工具、公告和功能开关。",
  system: "观察真实数据库、实时事件、错误与存储状态。",
  agents: "查看远端设备、联机席位与任务授权，紧急撤销会即时停止该设备。",
  security: "管理登录会话、IP 限制及管理员角色。",
  audit: "查询管理操作、前后状态、处理原因与追踪标识。",
};
const labels: Record<string, string> = {
  neutral: "已关闭",
  normal: "正常",
  active: "正常",
  frozen: "冻结",
  deleted: "已删除",
  quarantined: "已隔离",
  limited_post: "限制发言",
  limited_room: "限制建房",
  limited_upload: "限制上传",
  banned: "封禁",
  pending: "待处理",
  processing: "处理中",
  resolved: "已处理",
  dismissed: "已驳回",
  revoked: "已撤销",
  expired: "已过期",
  exhausted: "次数用尽",
  super: "超级管理员",
  operations: "运营管理员",
  technical: "技术管理员",
  success: "成功",
  failed: "失败",
  unverified: "待验证",
  error: "异常",
  all: "所有用户",
  users: "指定用户",
  rooms: "指定房间",
  admins: "管理员测试",
  percentage: "百分比灰度",
  approve: "审核通过",
  dismiss: "驳回举报",
  delete_message: "删除消息",
  quarantine: "隔离文件",
  freeze: "冻结房间",
  warning: "警告用户",
  tasks: "任务",
  uploads: "文件上传",
  create_room: "创建房间",
  agents: "Agent 功能",
  connection_seat: "联机席位",
};
const stamp = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString("zh-CN", { hour12: false }) : "—";
const short = (v: unknown) => (v ? String(v).slice(0, 8) : "—");
const count = (v: unknown) => Number(v || 0).toLocaleString("zh-CN");
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`ad-badge ${["banned", "deleted", "error", "failed"].includes(value) ? "danger" : ["frozen", "limited_upload", "limited_post", "limited_room", "quarantined", "pending", "processing", "unverified"].includes(value) ? "warning" : ["normal", "active", "success", "resolved"].includes(value) ? "success" : "neutral"}`}
    >
      {labels[value] || value}
    </span>
  );
}
function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="ad-panel">
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
function Empty() {
  return (
    <div className="ad-empty">
      <ClipboardList size={28} />
      <p>暂无符合条件的记录</p>
    </div>
  );
}
function Metric({
  label,
  value,
  icon: Icon = Activity,
  note,
}: {
  label: string;
  value: ReactNode;
  icon?: typeof Activity;
  note?: string;
}) {
  return (
    <article className="ad-metric">
      <div>
        <span className="ad-icon">
          <Icon size={22} />
        </span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}
function Chart({
  data,
  field,
  color = "#2979ff",
}: {
  data: Row[];
  field: string;
  color?: string;
}) {
  const max = Math.max(1, ...data.map((d) => Number(d[field])));
  return (
    <div className="ad-chart">
      <svg viewBox="0 0 600 180" role="img" aria-label="每日趋势图">
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line
              x1="35"
              x2="595"
              y1={15 + i * 45}
              y2={15 + i * 45}
              stroke="#edf1f7"
            />
            <text x="0" y={20 + i * 45} fill="#8e99ac" fontSize="10">
              {Math.round(max * (1 - i / 3))}
            </text>
          </g>
        ))}
        {data.map((d, i) => (
          <rect
            key={d.day}
            x={38 + (i * 550) / Math.max(data.length, 1)}
            y={150 - (Number(d[field]) / max) * 130}
            width={Math.max(2, 550 / Math.max(data.length, 1) - 4)}
            height={(Number(d[field]) / max) * 130}
            rx="2"
            fill={color}
          >
            <title>
              {d.day}：{d[field]}
            </title>
          </rect>
        ))}
      </svg>
      <div className="ad-chart-axis">
        <span>{data[0]?.day || "暂无数据"}</span>
        <span>{data.at(-1)?.day || ""}</span>
      </div>
    </div>
  );
}
type Column = { title: string; key?: string; render?: (r: Row) => ReactNode };
function Table({ rows, columns }: { rows: Row[]; columns: Column[] }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="ad-table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || r.user_id || r.key || i}>
              {columns.map((c, j) => (
                <td key={j}>
                  {c.render ? c.render(r) : String(r[c.key!] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Fields({ row }: { row: Row }) {
  return (
    <dl className="ad-fields">
      {Object.entries(row)
        .filter(([, v]) => v !== null && typeof v !== "object")
        .map(([k, v]) => (
          <div key={k}>
            <dt>
              {(
                {
                  id: "ID",
                  email: "邮箱",
                  display_name: "昵称",
                  name: "名称",
                  status: "状态",
                  created_at: "创建时间",
                  last_active_at: "最后活跃",
                  room_id: "房间 ID",
                  user_id: "用户 ID",
                  reason: "原因",
                  target_id: "目标 ID",
                  target_type: "对象类型",
                  resolution: "处理说明",
                  handled_at: "处理时间",
                  mime_type: "文件类型",
                  size: "大小",
                  storage_path: "对象路径",
                  expires_at: "有效期",
                  max_uses: "使用上限",
                  used_count: "已使用",
                  trace_id: "Trace ID",
                  admin_name: "管理员",
                  action: "操作",
                  target_type_label: "对象",
                  ip: "IP",
                  restricted_until: "限制截止",
                  restriction_reason: "限制原因",
                } as Record<string, string>
              )[k] || k}
            </dt>
            <dd>
              {k.endsWith("_at") ? (
                stamp(v)
              ) : k === "status" ? (
                <Badge value={String(v)} />
              ) : (
                String(v)
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}
export default function AdminDashboard({
  user,
  section,
}: {
  user: AdminUser;
  section: string;
}) {
  const [eventDraft, setEventDraft] = useState<Record<string, string>>({
      room_id: "",
      actor_id: "",
      entity_id: "",
      event_type: "",
    }),
    [eventFilters, setEventFilters] = useState<Record<string, string>>({});
  const [data, setData] = useState<Row | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [drawer, setDrawer] = useState<{ type: string; data: Row } | null>(null),
    [modal, setModal] = useState<{
      action: string;
      data: Row;
      name: string;
    } | null>(null),
    [menu, setMenu] = useState(false),
    [systemTab, setSystemTab] = useState("health"),
    [systemRows, setSystemRows] = useState<Row[]>([]);
  const url = useCallback(
    (module = section) => {
      const p = new URLSearchParams({
        q: query,
        status,
        page: String(page),
        limit: "20",
      });
      if (module === "events")
        for (const [k, v] of Object.entries(eventFilters)) if (v) p.set(k, v);
      if (from) p.set("from", new Date(from + "T00:00:00").toISOString());
      if (to) p.set("to", new Date(to + "T23:59:59").toISOString());
      return `admin/${module}?${p}`;
    },
    [section, query, status, page, from, to, eventFilters],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api<Row>(url()));
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 401) location.reload();
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    const value = new URLSearchParams(location.search).get("q");
    if (value) {
      setQ(value);
      setQuery(value);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (section !== "system" || systemTab === "health") return;
    api<Row>(url(systemTab))
      .then((v) => setSystemRows(v.items))
      .catch((e) => setError(e.message));
  }, [section, systemTab, url, data]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!modal && !drawer && section !== "operations") void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh, modal, drawer, section]);
  const act = (action: string, row: Row, name?: string) =>
    setModal({
      action,
      data: row,
      name:
        name ||
        row.display_name ||
        row.name ||
        row.title ||
        row.id ||
        "网站配置",
    });
  async function detail(type: string, row: Row) {
    try {
      const value =
        type === "users" || type === "rooms"
          ? await api<Row>(`admin/${type}/${row.id}`)
          : row;
      setDrawer({ type, data: value });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function completed(result: Row) {
    setModal(null);
    setNotice(
      `已保存${result.audit_id ? ` · 审计 #${result.audit_id}` : ""}${result.pending_cleanup ? ` · ${result.pending_cleanup} 个对象等待重试清理` : ""}`,
    );
    await refresh();
    if (result.context) {
      setDrawer({ type: "message", data: result });
    } else if (drawer && (drawer.type === "users" || drawer.type === "rooms")) {
      const id = drawer.data.user?.id || drawer.data.room?.id;
      await detail(drawer.type, { id });
    }
  }
  const button = (
    text: string,
    action: string,
    r: Row,
    extra: Row = {},
    danger = false,
  ) => (
    <button
      className={`ad-text-button ${danger ? "danger" : ""}`}
      onClick={() => act(action, { ...r, ...extra })}
    >
      {text}
    </button>
  );
  const columns = (): Column[] => {
    if (section === "agents")
      return [
        {
          title: "Agent / 设备",
          render: (r) => (
            <div>
              <strong>{r.display_name}</strong>
              <small>
                {r.node_name} · {r.adapter}
              </small>
            </div>
          ),
        },
        {
          title: "房间 / 所属成员",
          render: (r) => (
            <div>
              {r.room_name}
              <small>{r.owner_name}</small>
            </div>
          ),
        },
        {
          title: "席位",
          render: (r) =>
            r.state === "approved"
              ? r.muted
                ? "已静音"
                : "已批准"
              : r.state === "pending"
                ? "待批准"
                : "已撤销",
        },
        {
          title: "设备连接",
          render: (r) =>
            r.last_seen_at &&
            Date.now() - new Date(r.last_seen_at).getTime() < 45000
              ? "在线"
              : "离线",
        },
        { title: "运行任务", render: (r) => r.active_turns },
        {
          title: "操作",
          render: (r) =>
            !r.revoked_at && (
              <button
                className="ad-text-button danger"
                onClick={async () => {
                  const reason = window.prompt(
                    "填写撤销此设备的具体原因（至少 3 个字）",
                  );
                  if (!reason || reason.trim().length < 3) return;
                  if (!window.confirm("确认撤销设备并停止在途任务？")) return;
                  try {
                    await api("admin/agents/revoke", {
                      node_id: r.node_id,
                      reason,
                      confirm: true,
                    });
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                撤销设备
              </button>
            ),
        },
      ];
    if (section === "users")
      return [
        {
          title: "用户",
          render: (r) => (
            <div className="ad-person">
              <span className="ad-avatar">{r.display_name.slice(0, 1)}</span>
              <span>
                <strong>{r.display_name}</strong>
                <small>{r.email}</small>
              </span>
            </div>
          ),
        },
        {
          title: "UID",
          render: (r) => <code title={r.id}>{short(r.id)}</code>,
        },
        { title: "注册时间", render: (r) => stamp(r.created_at) },
        { title: "最后活跃", render: (r) => stamp(r.last_active_at) },
        { title: "房间", key: "joined_rooms" },
        { title: "消息", key: "message_count" },
        { title: "状态", render: (r) => <Badge value={r.effective_status} /> },
        {
          title: "操作",
          render: (r) => (
            <div className="ad-actions">
              <button onClick={() => void detail("users", r)}>查看</button>
              {button("编辑", "edit_user", r)}
              {button(
                r.effective_status === "normal" ? "限制" : "解除",
                "restrict_user",
                r,
                { status: "normal" },
                true,
              )}
            </div>
          ),
        },
      ];
    if (section === "rooms")
      return [
        {
          title: "房间名称",
          render: (r) => (
            <strong>
              {r.icon} {r.name}
            </strong>
          ),
        },
        {
          title: "房间 ID",
          render: (r) => <code title={r.id}>{short(r.id)}</code>,
        },
        { title: "主持人", key: "host_name" },
        { title: "成员", key: "members" },
        { title: "消息", key: "message_count" },
        { title: "任务", key: "task_count" },
        { title: "文件用量", render: (r) => size(Number(r.storage_bytes)) },
        { title: "状态", render: (r) => <Badge value={r.status} /> },
        {
          title: "操作",
          render: (r) => (
            <div className="ad-actions">
              <button onClick={() => void detail("rooms", r)}>详情</button>
              {button(
                r.status === "active" ? "冻结" : "恢复",
                "room_status",
                r,
                { status: r.status === "active" ? "frozen" : "active" },
                true,
              )}
              {r.status !== "deleted" &&
                button("删除", "room_status", r, { status: "deleted" }, true)}
            </div>
          ),
        },
      ];
    if (section === "files")
      return [
        {
          title: "文件",
          render: (r) => (
            <span>
              <FileText size={15} /> {r.name}
            </span>
          ),
        },
        { title: "类型", key: "mime_type" },
        { title: "上传人", key: "uploader_name" },
        { title: "房间", key: "room_name" },
        { title: "大小", render: (r) => size(Number(r.size)) },
        { title: "时间", render: (r) => stamp(r.created_at) },
        { title: "状态", render: (r) => <Badge value={r.status} /> },
        {
          title: "操作",
          render: (r) => (
            <div className="ad-actions">
              <button onClick={() => void detail("file", r)}>详情</button>
              {button("审计下载", "file_view", r)}
              {button(
                r.status === "normal" ? "隔离" : "恢复",
                "file_status",
                r,
                { status: r.status === "normal" ? "quarantined" : "normal" },
                true,
              )}
              {button("删除", "file_status", r, { status: "deleted" }, true)}
            </div>
          ),
        },
      ];
    if (section === "invites")
      return [
        { title: "邀请房间", key: "room_name" },
        { title: "创建人", key: "creator_name" },
        { title: "指纹", key: "fingerprint" },
        { title: "使用次数", render: (r) => `${r.used_count} / ${r.max_uses}` },
        { title: "有效期", render: (r) => stamp(r.expires_at) },
        { title: "状态", render: (r) => <Badge value={r.status} /> },
        {
          title: "操作",
          render: (r) => (
            <div className="ad-actions">
              {button("撤销", "invite_update", r, { revoke: true }, true)}
              {button("调整有效期", "invite_update", r, { revoke: false })}
            </div>
          ),
        },
      ];
    if (section === "reports")
      return [
        {
          title: "举报原因",
          render: (r) => (
            <span className="ad-truncate" title={r.reason}>
              {r.reason}
            </span>
          ),
        },
        { title: "对象", key: "target_type" },
        { title: "举报人", key: "reporter_name" },
        { title: "房间", key: "room_name" },
        { title: "时间", render: (r) => stamp(r.created_at) },
        { title: "状态", render: (r) => <Badge value={r.status} /> },
        {
          title: "操作",
          render: (r) => (
            <div className="ad-actions">
              <button onClick={() => void detail("report", r)}>查看</button>
              {button("处理", "resolve_report", r)}
            </div>
          ),
        },
      ];
    if (section === "content")
      return [
        { title: "消息 ID", key: "id" },
        { title: "房间", key: "room_name" },
        { title: "发送者", key: "sender_name" },
        { title: "类型", key: "type" },
        { title: "时间", render: (r) => stamp(r.created_at) },
        {
          title: "操作",
          render: (r) => (
            <div className="ad-actions">
              {button("查看正文", "content_view", r)}
              {button("删除", "delete_message", r, {}, true)}
            </div>
          ),
        },
      ];
    return [
      { title: "时间", render: (r) => stamp(r.created_at) },
      { title: "管理员", key: "admin_name" },
      { title: "操作", key: "action" },
      {
        title: "目标",
        render: (r) => <code title={r.target_id}>{short(r.target_id)}</code>,
      },
      {
        title: "原因",
        render: (r) => <span className="ad-truncate">{r.reason}</span>,
      },
      { title: "结果", render: (r) => <Badge value={r.result} /> },
      { title: "IP", key: "ip" },
      {
        title: "操作",
        render: (r) => (
          <button
            className="ad-text-button"
            onClick={() => void detail("audit", r)}
          >
            查看详情
          </button>
        ),
      },
    ];
  };
  const role = user.role;
  return (
    <div className={`admin-app ${menu ? "menu-open" : ""}`}>
      <aside className="ad-sidebar">
        <a className="ad-brand" href="/admin">
          <SiteBrand />
          <small>管理后台</small>
        </a>
        <nav>
          {nav
            .filter((n) => permissions[n.section]?.includes(role))
            .map((n, i, all) => (
              <div key={n.section}>
                {(i === 0 || all[i - 1].group !== n.group) && (
                  <small className="ad-nav-group">{n.group}</small>
                )}
                <a
                  className={section === n.section ? "selected" : ""}
                  href={
                    n.section === "overview" ? "/admin" : `/admin/${n.section}`
                  }
                >
                  <n.icon size={18} />
                  {n.name}
                </a>
              </div>
            ))}
        </nav>
        <a className="ad-return" href="/">
          返回协作空间 <ChevronRight size={15} />
        </a>
      </aside>
      <div className="ad-workspace">
        <header className="ad-topbar">
          <button
            className="ad-mobile-menu"
            aria-label="展开导航"
            onClick={() => setMenu(!menu)}
          >
            <Menu size={20} />
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              location.href = `/admin/users?q=${encodeURIComponent(q)}`;
            }}
            className="ad-global-search"
          >
            <Search size={16} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索用户、房间或 ID…"
              aria-label="全局搜索"
            />
          </form>
          <span className="ad-admin">
            <span className="ad-avatar">{user.display_name.slice(0, 1)}</span>
            {user.display_name}
            <small>{labels[role]}</small>
          </span>
          <button
            aria-label="退出后台"
            title="退出登录"
            onClick={() =>
              void api("auth/logout", {}).then(() => location.reload())
            }
          >
            <LogOut size={17} />
          </button>
        </header>
        <main className="ad-main">
          <div className="ad-page-heading">
            <div>
              <h1>{titles[section] || "管理后台"}</h1>
              <p>{hints[section]}</p>
            </div>
            <button
              className="ad-button"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw size={15} />
              刷新
            </button>
          </div>
          {error && (
            <div role="alert" className="admin-error">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="ad-notice">
              <CheckCircle2 size={16} />
              {notice}
              <button onClick={() => setNotice("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {[
            "users",
            "rooms",
            "files",
            "invites",
            "reports",
            "content",
            "audit",
            "overview",
          ].includes(section) && (
            <form
              className="ad-filters"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(q);
                setPage(1);
              }}
            >
              {section !== "overview" && (
                <>
                  <div className="ad-search">
                    <Search size={17} />
                    <input
                      aria-label="搜索记录"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder={
                        section === "content"
                          ? "输入消息 ID 或房间 ID"
                          : "搜索名称、邮箱或 ID…"
                      }
                    />
                  </div>
                  <select
                    aria-label="状态筛选"
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">全部状态</option>
                    {(
                      {
                        users: [
                          "normal",
                          "limited_post",
                          "limited_room",
                          "limited_upload",
                          "banned",
                        ],
                        rooms: ["active", "frozen", "deleted"],
                        files: ["normal", "quarantined", "deleted"],
                        reports: [
                          "pending",
                          "processing",
                          "resolved",
                          "dismissed",
                        ],
                        invites: ["active", "revoked", "expired", "exhausted"],
                        audit: ["success", "failed"],
                      } as Record<string, string[]>
                    )[section]?.map((s) => (
                      <option value={s} key={s}>
                        {labels[s]}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <input
                type="date"
                aria-label="开始日期"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
              <span>至</span>
              <input
                type="date"
                aria-label="结束日期"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
              {section !== "overview" && (
                <button className="ad-button primary">查询</button>
              )}
              {[
                "overview",
                "users",
                "rooms",
                "files",
                "invites",
                "audit",
              ].includes(section) && (
                <a
                  className="ad-button"
                  href={`/api/${url()
                    .replace("limit=20", "limit=1000")
                    .replace(/page=\d+/, "page=1")}&format=csv`}
                >
                  <Download size={15} />
                  导出当前筛选
                </a>
              )}
            </form>
          )}
          {loading && !data ? (
            <div className="ad-empty">正在加载真实数据…</div>
          ) : (
            data && (
              <>
                {section === "overview" && (
                  <>
                    <div className="ad-metrics six">
                      <Metric
                        label="用户总数"
                        value={count(data.totals.users)}
                        icon={Users}
                      />
                      <Metric
                        label="今日活跃"
                        value={count(data.totals.active_users)}
                        icon={Activity}
                      />
                      <Metric
                        label="房间数"
                        value={count(data.totals.rooms)}
                        icon={House}
                      />
                      <Metric
                        label="消息数"
                        value={count(data.totals.messages)}
                        icon={MessageCircle}
                      />
                      <Metric
                        label="任务数"
                        value={count(data.totals.tasks)}
                        icon={ListTodo}
                      />
                      <Metric
                        label="文件用量"
                        value={size(Number(data.totals.storage))}
                        icon={FileText}
                      />
                    </div>
                    <div className="ad-grid two">
                      <Panel title="注册趋势">
                        <Chart data={data.trends} field="registrations" />
                      </Panel>
                      <Panel title="活跃房间">
                        <Chart
                          data={data.trends}
                          field="active_rooms"
                          color="#28b983"
                        />
                      </Panel>
                    </div>
                    <div className="ad-grid two">
                      <Panel title="产品激活漏斗">
                        <div className="ad-funnel">
                          {[
                            ["注册", "registered"],
                            ["加入房间", "joined"],
                            ["首条消息", "messaged"],
                            ["首个任务", "tasked"],
                          ].map(([label, key]) => (
                            <div key={key}>
                              <span>{label}</span>
                              <strong>{count(data.funnel[key])}</strong>
                              <div
                                style={{
                                  width: `${Math.max(3, (Number(data.funnel[key]) / Math.max(1, Number(data.funnel.registered))) * 100)}%`,
                                }}
                              />
                            </div>
                          ))}
                        </div>
                        <p className="ad-help">按所选窗口注册的用户统计。</p>
                      </Panel>
                      <Panel title="风险提醒">
                        <div className="ad-risk-summary">
                          <span>
                            <Flag />
                            待处理举报{" "}
                            <strong>{data.totals.pending_reports}</strong>
                          </span>
                          <span>
                            <Folder />
                            隔离文件{" "}
                            <strong>{data.totals.quarantined_files}</strong>
                          </span>
                          <span>
                            <Shield />近 24 小时失败登录{" "}
                            <strong>{data.totals.failed_logins}</strong>
                          </span>
                        </div>
                      </Panel>
                    </div>
                    <Panel title="异常房间">
                      <Table
                        rows={data.risks}
                        columns={[
                          { title: "房间", key: "name" },
                          { title: "每小时消息", key: "hourly_messages" },
                          { title: "待处理举报", key: "reports" },
                          { title: "每小时加入", key: "new_members" },
                          {
                            title: "每小时上传",
                            render: (r) => size(Number(r.hourly_bytes)),
                          },
                        ]}
                      />
                    </Panel>
                    <Panel
                      title="最近操作日志"
                      action={<a href="/admin/audit">查看更多</a>}
                    >
                      <Table
                        rows={data.audit}
                        columns={[
                          { title: "时间", render: (r) => stamp(r.created_at) },
                          { title: "管理员", key: "admin_name" },
                          { title: "操作", key: "action" },
                          { title: "原因", key: "reason" },
                          {
                            title: "结果",
                            render: (r) => <Badge value={r.result} />,
                          },
                        ]}
                      />
                    </Panel>
                    <p className="ad-help">{data.metric_definition}</p>
                  </>
                )}
                {[
                  "agents",
                  "users",
                  "rooms",
                  "files",
                  "invites",
                  "reports",
                  "content",
                  "audit",
                ].includes(section) && (
                  <Panel
                    title={`${titles[section]}列表 · ${count(data.total)} 条`}
                  >
                    <Table rows={data.items} columns={columns()} />
                    <div className="ad-pagination">
                      <span>每页 20 条</span>
                      <button
                        aria-label="上一页"
                        disabled={page === 1}
                        onClick={() => setPage(page - 1)}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <strong>{page}</strong>
                      <button
                        aria-label="下一页"
                        disabled={page * 20 >= data.total}
                        onClick={() => setPage(page + 1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </Panel>
                )}
                {section === "operations" && (
                  <Operations data={data} role={role} act={act} />
                )}
                {section === "system" && (
                  <>
                    <div className="ad-tabs">
                      {[
                        ["health", "服务状态"],
                        ["events", "Event 查询"],
                        ["errors", "错误记录"],
                      ].map(([key, name]) => (
                        <button
                          className={systemTab === key ? "active" : ""}
                          onClick={() => setSystemTab(key)}
                          key={key}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    {systemTab === "health" ? (
                      <>
                        <div className="ad-metrics">
                          {data.health.map((h: Row) => (
                            <Metric
                              label={h.name}
                              value={<Badge value={h.status} />}
                              note={h.detail}
                              key={h.name}
                              icon={h.name === "Database" ? Database : Activity}
                            />
                          ))}
                        </div>
                        <div className="ad-grid two">
                          <Panel title="实时通信">
                            <div className="ad-metrics two">
                              <Metric
                                label="当前 SSE 连接"
                                value={data.realtime.connections}
                              />
                              <Metric
                                label="活跃房间"
                                value={data.realtime.rooms}
                              />
                              <Metric
                                label="Event / 分钟"
                                value={data.realtime.events_per_minute}
                              />
                              <Metric
                                label="Presence"
                                value={data.realtime.presence}
                              />
                            </div>
                            <p className="ad-help">
                              近 24 小时流创建 {data.realtime.stream_opens_24h}{" "}
                              次，包含首次连接及重连；不是唯一用户数。
                            </p>
                          </Panel>
                          <Panel title="存储与容量">
                            <Fields
                              row={{
                                数据库: size(
                                  Number(data.capacity.database_bytes),
                                ),
                                文件: size(Number(data.capacity.stored_bytes)),
                                数据库连接: data.capacity.database_connections,
                                孤立对象: data.capacity.orphan_objects,
                                待重试清理: data.capacity.pending_cleanup,
                                过期会话: data.capacity.expired_sessions,
                                失效邀请: data.capacity.expired_invites,
                              }}
                            />
                            <p className="ad-help">{data.bandwidth}</p>
                            {data.backup ? (
                              <a
                                href={data.backup}
                                target="_blank"
                                rel="noreferrer"
                              >
                                查看基础设施备份状态
                              </a>
                            ) : (
                              <p className="ad-help">
                                备份状态未接入。请按部署文档配置备份与恢复。
                              </p>
                            )}
                            {role === "super" && (
                              <div className="ad-actions">
                                <button
                                  className="ad-button danger"
                                  onClick={() =>
                                    act(
                                      "cleanup",
                                      {},
                                      "过期 Session、邀请和历史遥测",
                                    )
                                  }
                                >
                                  清理过期数据
                                </button>
                                <button
                                  className="ad-button danger"
                                  onClick={() =>
                                    act(
                                      "orphan_cleanup",
                                      {},
                                      "超过 24 小时的无引用对象",
                                    )
                                  }
                                >
                                  清理孤立对象
                                </button>
                              </div>
                            )}
                          </Panel>
                        </div>
                        <div className="ad-metrics">
                          <Metric
                            label="24 小时 API 请求"
                            value={count(data.metrics.requests)}
                          />
                          <Metric
                            label="响应时间 P95"
                            value={`${data.metrics.p95} ms`}
                          />
                          <Metric
                            label="服务端错误"
                            value={data.metrics.errors}
                          />
                          <Metric
                            label="登录成功 / 失败"
                            value={`${data.auth.success} / ${data.auth.failed}`}
                          />
                        </div>
                        <Panel title="系统状态时间线">
                          <Table
                            rows={data.incidents}
                            columns={[
                              {
                                title: "时间",
                                render: (r) => stamp(r.created_at),
                              },
                              { title: "服务", key: "service" },
                              { title: "状态", key: "status" },
                              { title: "说明", key: "message" },
                            ]}
                          />
                        </Panel>
                      </>
                    ) : (
                      <>
                        <form
                          className="ad-filters"
                          onSubmit={(e) => {
                            e.preventDefault();
                            setQuery(q);
                            setEventFilters(eventDraft);
                            setPage(1);
                          }}
                        >
                          <input
                            aria-label="查询事件或错误"
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder={
                              systemTab === "events"
                                ? "Room / Actor / Entity ID 或事件类型"
                                : "接口路径或 Trace ID"
                            }
                          />
                          {systemTab === "events" &&
                            Object.entries({
                              room_id: "Room ID",
                              actor_id: "Actor ID",
                              entity_id: "Entity ID",
                              event_type: "事件类型",
                            }).map(([k, label]) => (
                              <input
                                key={k}
                                aria-label={label}
                                placeholder={label}
                                value={eventDraft[k]}
                                onChange={(e) =>
                                  setEventDraft((v) => ({
                                    ...v,
                                    [k]: e.target.value,
                                  }))
                                }
                              />
                            ))}
                          <input
                            type="date"
                            aria-label="事件开始日期"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                          />
                          <input
                            type="date"
                            aria-label="事件结束日期"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                          />
                          <button className="ad-button primary">查询</button>
                        </form>
                        <Panel
                          title={
                            systemTab === "events" ? "Event 查询" : "错误记录"
                          }
                        >
                          <Table
                            rows={systemRows}
                            columns={
                              systemTab === "events"
                                ? [
                                    {
                                      title: "时间",
                                      render: (r) => stamp(r.created_at),
                                    },
                                    { title: "事件类型", key: "type" },
                                    { title: "Room", key: "room_id" },
                                    { title: "Actor", key: "actor_name" },
                                    { title: "Entity", key: "entity_id" },
                                    {
                                      title: "操作",
                                      render: (r) => (
                                        <button
                                          className="ad-text-button"
                                          onClick={() =>
                                            void detail("event", r)
                                          }
                                        >
                                          详情
                                        </button>
                                      ),
                                    },
                                  ]
                                : [
                                    {
                                      title: "时间",
                                      render: (r) => stamp(r.created_at),
                                    },
                                    { title: "接口", key: "path" },
                                    { title: "状态码", key: "status" },
                                    { title: "耗时 ms", key: "duration_ms" },
                                    { title: "Trace ID", key: "trace_id" },
                                  ]
                            }
                          />
                          <div className="ad-pagination">
                            <button
                              disabled={page === 1}
                              onClick={() => setPage(page - 1)}
                            >
                              上一页
                            </button>
                            <span>{page}</span>
                            <button
                              disabled={systemRows.length < 20}
                              onClick={() => setPage(page + 1)}
                            >
                              下一页
                            </button>
                          </div>
                        </Panel>
                      </>
                    )}
                  </>
                )}
                {section === "security" && (
                  <>
                    <div className="ad-grid two">
                      <Panel title="登录与 Session">
                        <Table
                          rows={data.sessions}
                          columns={[
                            {
                              title: "用户",
                              render: (r) => (
                                <span>
                                  {r.display_name}
                                  <small>{r.email}</small>
                                </span>
                              ),
                            },
                            {
                              title: "设备",
                              render: (r) => (
                                <span
                                  className="ad-truncate"
                                  title={r.user_agent}
                                >
                                  {r.user_agent || "未知"}
                                </span>
                              ),
                            },
                            { title: "IP", key: "ip" },
                            {
                              title: "最近活跃",
                              render: (r) => stamp(r.last_active_at),
                            },
                            {
                              title: "操作",
                              render: (r) => (
                                <div className="ad-actions">
                                  {button(
                                    "强制下线",
                                    "revoke_sessions",
                                    {
                                      id: r.user_id,
                                      session_id: r.id,
                                      display_name: r.display_name,
                                    },
                                    {},
                                    true,
                                  )}
                                  {button(
                                    "全部下线",
                                    "revoke_sessions",
                                    {
                                      id: r.user_id,
                                      display_name: r.display_name,
                                    },
                                    {},
                                    true,
                                  )}
                                </div>
                              ),
                            },
                          ]}
                        />
                      </Panel>
                      <Panel
                        title="IP 限制"
                        action={
                          role === "super" && (
                            <button
                              className="ad-button"
                              onClick={() => act("ip_rule", {}, "新增 IP 限制")}
                            >
                              <Plus size={15} />
                              添加 IP
                            </button>
                          )
                        }
                      >
                        <Table
                          rows={data.ip_rules}
                          columns={[
                            { title: "网络", key: "network" },
                            { title: "原因", key: "reason" },
                            {
                              title: "到期",
                              render: (r) => stamp(r.expires_at),
                            },
                            {
                              title: "操作",
                              render: (r) =>
                                role === "super" &&
                                button("解除", "delete_ip_rule", r, {}, true),
                            },
                          ]}
                        />
                        <p className="ad-help">
                          {data.trust_proxy
                            ? "已启用受信代理来源解析；请确保代理覆盖来源请求头。"
                            : "未启用受信代理：不信任客户端伪造的 IP 请求头，IP 规则需部署 TRUST_PROXY=true 并由代理覆盖来源头后生效。"}
                        </p>
                      </Panel>
                    </div>
                    <Panel title="最近登录记录">
                      <Table
                        rows={data.logins}
                        columns={[
                          { title: "时间", render: (r) => stamp(r.created_at) },
                          {
                            title: "用户",
                            render: (r) => r.display_name || r.email,
                          },
                          { title: "来源", key: "ip" },
                          {
                            title: "结果",
                            render: (r) => (
                              <Badge value={r.success ? "success" : "failed"} />
                            ),
                          },
                          {
                            title: "设备",
                            render: (r) => (
                              <span className="ad-truncate">
                                {r.user_agent}
                              </span>
                            ),
                          },
                        ]}
                      />
                    </Panel>
                    {role === "super" && (
                      <Panel
                        title="管理员权限"
                        action={
                          <button
                            className="ad-button primary"
                            onClick={() =>
                              act("admin_member", {}, "授权管理员")
                            }
                          >
                            <Plus size={15} />
                            新增管理员
                          </button>
                        }
                      >
                        <Table
                          rows={data.admins}
                          columns={[
                            { title: "管理员", key: "display_name" },
                            { title: "邮箱", key: "email" },
                            {
                              title: "角色",
                              render: (r) => <Badge value={r.role} />,
                            },
                            {
                              title: "操作",
                              render: (r) => (
                                <div className="ad-actions">
                                  {button("修改角色", "admin_member", {
                                    id: r.user_id,
                                    role: r.role,
                                    display_name: r.display_name,
                                  })}
                                  {button(
                                    "撤销权限",
                                    "admin_member",
                                    {
                                      id: r.user_id,
                                      role: "remove",
                                      display_name: r.display_name,
                                    },
                                    {},
                                    true,
                                  )}
                                </div>
                              ),
                            },
                          ]}
                        />
                      </Panel>
                    )}
                    <p className="ad-help">{data.two_factor}</p>
                  </>
                )}
              </>
            )
          )}
        </main>
      </div>
      {modal && (
        <ActionDialog
          modal={modal}
          role={role}
          onClose={() => setModal(null)}
          onDone={completed}
        />
      )}
      {drawer && (
        <Dialog.Root open onOpenChange={(v) => !v && setDrawer(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="ad-overlay" />
            <Dialog.Content className="ad-drawer" aria-describedby={undefined}>
              <header>
                <Dialog.Title>
                  {
                    (
                      {
                        users: "用户详情",
                        rooms: "房间详情",
                        report: "举报详情",
                        message: "消息与上下文",
                        file: "文件详情",
                        audit: "操作审计",
                        event: "Event 详情",
                      } as Record<string, string>
                    )[drawer.type]
                  }
                </Dialog.Title>
                <Dialog.Close aria-label="关闭详情">
                  <X size={20} />
                </Dialog.Close>
              </header>
              {drawer.type === "users" ? (
                <>
                  <h2>
                    {drawer.data.user.display_name}{" "}
                    <Badge value={drawer.data.user.effective_status} />
                  </h2>
                  <Fields row={drawer.data.user} />
                  <Panel title="使用统计">
                    <Fields
                      row={{
                        加入房间: drawer.data.usage.joined_rooms,
                        创建房间: drawer.data.usage.created_rooms,
                        消息: drawer.data.usage.messages,
                        任务: drawer.data.usage.tasks,
                        文件用量: size(Number(drawer.data.usage.file_bytes)),
                      }}
                    />
                  </Panel>
                  <Panel title="最近行为">
                    <Table
                      rows={drawer.data.activity}
                      columns={[
                        { title: "事件", key: "type" },
                        { title: "时间", render: (r) => stamp(r.created_at) },
                      ]}
                    />
                  </Panel>
                  <Panel title="限制历史">
                    <Table
                      rows={drawer.data.restrictions}
                      columns={[
                        { title: "审计 ID", key: "id" },
                        { title: "原因", key: "reason" },
                        { title: "时间", render: (r) => stamp(r.created_at) },
                      ]}
                    />
                  </Panel>
                  <Panel title="活动 Session">
                    <Table
                      rows={drawer.data.sessions}
                      columns={[
                        {
                          title: "设备",
                          render: (r) => (
                            <span className="ad-truncate">{r.user_agent}</span>
                          ),
                        },
                        {
                          title: "活跃",
                          render: (r) => stamp(r.last_active_at),
                        },
                        {
                          title: "操作",
                          render: (r) =>
                            button(
                              "下线",
                              "revoke_sessions",
                              {
                                id: drawer.data.user.id,
                                session_id: r.id,
                                display_name: drawer.data.user.display_name,
                              },
                              {},
                              true,
                            ),
                        },
                      ]}
                    />
                  </Panel>
                  <div className="ad-actions">
                    {button("修改资料", "edit_user", drawer.data.user)}
                    {button("设置限制", "restrict_user", drawer.data.user)}
                  </div>
                </>
              ) : drawer.type === "rooms" ? (
                <>
                  <h2>
                    {drawer.data.room.icon} {drawer.data.room.name}
                  </h2>
                  <Fields row={drawer.data.room} />
                  <Panel title="成员">
                    <Table
                      rows={drawer.data.participants.filter(
                        (p: Row) => p.status === "active",
                      )}
                      columns={[
                        { title: "成员", key: "display_name" },
                        {
                          title: "身份",
                          render: (r) =>
                            drawer.data.room.host_participant_id === r.id
                              ? "主持人"
                              : "成员",
                        },
                        {
                          title: "操作",
                          render: (r) => (
                            <div className="ad-actions">
                              {drawer.data.room.host_participant_id !==
                                r.id && (
                                <>
                                  {button("转为主持人", "transfer_host", {
                                    id: drawer.data.room.id,
                                    participant_id: r.id,
                                    name: r.display_name,
                                  })}
                                  {button("移出", "remove_member", r, {}, true)}
                                </>
                              )}
                            </div>
                          ),
                        },
                      ]}
                    />
                  </Panel>
                  <Panel title="任务">
                    <Table
                      rows={drawer.data.tasks}
                      columns={[
                        { title: "任务", key: "title" },
                        { title: "状态", key: "status" },
                        {
                          title: "操作",
                          render: (r) =>
                            button("重新分配", "assign_task", {
                              ...r,
                              participant_options:
                                drawer.data.participants.filter(
                                  (p: Row) => p.status === "active",
                                ),
                            }),
                        },
                      ]}
                    />
                  </Panel>
                  <Panel title="文件">
                    <Table
                      rows={drawer.data.files}
                      columns={[
                        { title: "文件", key: "name" },
                        {
                          title: "状态",
                          render: (r) => <Badge value={r.status} />,
                        },
                      ]}
                    />
                  </Panel>
                </>
              ) : drawer.type === "report" ? (
                <>
                  <Fields row={drawer.data} />
                  <div className="ad-actions">
                    {drawer.data.target_type === "message" &&
                      button("查看举报正文", "content_view", {
                        id: drawer.data.target_id,
                      })}
                    {button("处理举报", "resolve_report", drawer.data)}
                  </div>
                </>
              ) : drawer.type === "message" ? (
                <>
                  <p className="ad-help">
                    本次查看已记录 Audit #{drawer.data.audit_id}
                  </p>
                  <Panel title="目标消息">
                    <Fields row={drawer.data.data} />
                  </Panel>
                  <Panel title="前后 2 分钟上下文（最多 10 条）">
                    {drawer.data.context.map((m: Row) => (
                      <div className="ad-context" key={m.id}>
                        <strong>{m.sender_name || "系统"}</strong>
                        <small>{stamp(m.created_at)}</small>
                        <p>
                          {m.deleted_at
                            ? "消息已删除"
                            : m.content || `[${m.type}]`}
                        </p>
                      </div>
                    ))}
                  </Panel>
                </>
              ) : (
                <>
                  <Fields row={drawer.data} />
                  {["before", "after", "payload"].map(
                    (k) =>
                      drawer.data[k] && (
                        <Panel key={k} title={k}>
                          <pre>{JSON.stringify(drawer.data[k], null, 2)}</pre>
                        </Panel>
                      ),
                  )}
                </>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}
function Operations({
  data,
  role,
  act,
}: {
  data: Row;
  role: AdminRole;
  act: (a: string, r: Row, n?: string) => void;
}) {
  const fields: Record<string, string> = {
    name: "网站名称",
    intro: "首页简介",
    title: "页面标题",
    description: "SEO 描述",
    icp: "备案号",
    footer: "页脚内容",
    email: "联系邮箱",
    phone: "联系电话",
    baidu_enabled: "百度统计",
    baidu_id: "百度站点 ID",
    ga_enabled: "Google Analytics 4",
    ga_id: "GA4 衡量 ID",
    umami_enabled: "Umami",
    umami_url: "Umami 服务地址",
    umami_id: "网站 ID",
    registration: "开放注册",
    invite_days: "邀请默认有效期（天）",
    max_file_mb: "单文件大小（MB）",
    room_storage_mb: "单房间容量（MB）",
    allowed_extensions: "允许的扩展名",
    announcements: "显示公告",
    maintenance: "维护模式",
    maintenance_message: "维护提示",
  };
  const groupNames: Record<string, string> = {
    brand: "网站品牌",
    information: "网站信息",
    analytics: "统计工具",
    operations: "运营策略",
  };
  return (
    <>
      <div className="ad-grid three operations-grid">
        {["brand", "information", "analytics", "operations"].map((key) => (
          <SettingsCard
            key={key}
            group={key}
            values={data.settings[key] as Row}
            title={groupNames[key]}
            fields={fields}
            disabled={role !== "super"}
            act={act}
          />
        ))}
        {role !== "operations" && (
          <Panel title="功能开关与灰度范围">
            <Table
              rows={data.flags}
              columns={[
                { title: "功能", render: (r) => labels[r.key] },
                {
                  title: "状态",
                  render: (r) => (
                    <Badge value={r.enabled ? "active" : "neutral"} />
                  ),
                },
                { title: "范围", render: (r) => labels[r.scope] },
                { title: "灰度比例", render: (r) => `${r.rollout}%` },
                { title: "指定对象", render: (r) => r.targets.length },
                {
                  title: "操作",
                  render: (r) => (
                    <button
                      className="ad-text-button"
                      onClick={() => act("feature_flag", r, labels[r.key])}
                    >
                      配置
                    </button>
                  ),
                },
              ]}
            />
          </Panel>
        )}
        {role !== "technical" && (
          <Panel
            title="公告管理"
            action={
              <button
                className="ad-button primary"
                onClick={() =>
                  act(
                    "announcement",
                    {
                      title: "",
                      content: "",
                      starts_at: new Date().toISOString(),
                      ends_at: "",
                      position: "all",
                      dismissible: true,
                      enabled: true,
                    },
                    "新建公告",
                  )
                }
              >
                <Plus size={15} />
                新建公告
              </button>
            }
          >
            <Table
              rows={data.announcements}
              columns={[
                { title: "标题", key: "title" },
                { title: "开始时间", render: (r) => stamp(r.starts_at) },
                { title: "结束时间", render: (r) => stamp(r.ends_at) },
                {
                  title: "状态",
                  render: (r) => (
                    <Badge
                      value={
                        !r.enabled
                          ? "neutral"
                          : r.ends_at && new Date(r.ends_at) < new Date()
                            ? "expired"
                            : "active"
                      }
                    />
                  ),
                },
                {
                  title: "操作",
                  render: (r) => (
                    <div className="ad-actions">
                      <button onClick={() => act("announcement", r)}>
                        编辑
                      </button>
                      <button
                        className="danger"
                        onClick={() => act("delete_announcement", r)}
                      >
                        删除
                      </button>
                    </div>
                  ),
                },
              ]}
            />
          </Panel>
        )}
      </div>
    </>
  );
}
function SettingsCard({
  group,
  values,
  title,
  fields,
  disabled,
  act,
}: {
  group: string;
  values: Row;
  title: string;
  fields: Record<string, string>;
  disabled: boolean;
  act: (a: string, r: Row, n?: string) => void;
}) {
  const normalize = (v: Row) => ({
    ...v,
    ...(v.allowed_extensions
      ? { allowed_extensions: v.allowed_extensions.join(", ") }
      : {}),
  });
  const fieldOrder: Record<string, string[]> = {
    brand: ["name", "logo", "favicon", "intro"],
    information: ["title", "description", "icp", "footer", "email", "phone"],
    analytics: [
      "baidu_enabled",
      "baidu_id",
      "ga_enabled",
      "ga_id",
      "umami_enabled",
      "umami_url",
      "umami_id",
    ],
    operations: [
      "registration",
      "invite_days",
      "max_file_mb",
      "room_storage_mb",
      "allowed_extensions",
      "announcements",
      "maintenance",
      "maintenance_message",
    ],
  };
  const [value, setValue] = useState(normalize(values)),
    [error, setError] = useState(""),
    [uploading, setUploading] = useState(false);
  useEffect(() => setValue(normalize(values)), [values]);
  return (
    <Panel title={title}>
      <form
        className="ad-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          act(
            "settings",
            {
              key: group,
              value: {
                ...value,
                ...(group === "operations"
                  ? {
                      allowed_extensions: String(value.allowed_extensions)
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    }
                  : {}),
              },
            },
            title,
          );
        }}
      >
        {Object.entries(value)
          .sort(
            ([a], [b]) =>
              fieldOrder[group].indexOf(a) - fieldOrder[group].indexOf(b),
          )
          .map(([key, v]) => (
            <label key={key}>
              {fields[key] ||
                ({ logo: "Logo 上传", favicon: "浏览器图标" } as Row)[key]}
              {key === "logo" || key === "favicon" ? (
                <div className="ad-brand-upload">
                  {v ? <img src={v} alt={key} /> : <Globe size={32} />}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/x-icon"
                    aria-label={`上传 ${key}`}
                    disabled={disabled || uploading}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setUploading(true);
                      setError("");
                      const form = new FormData();
                      form.set("file", file);
                      form.set("reason", `更新网站 ${key} 品牌资源`);
                      try {
                        const { url } = await api<{ url: string }>(
                          "admin/brand",
                          form,
                        );
                        setValue((v) => ({ ...v, [key]: url }));
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                  {v && (
                    <button
                      type="button"
                      className="ad-text-button"
                      disabled={disabled}
                      onClick={() => setValue((p) => ({ ...p, [key]: "" }))}
                    >
                      移除
                    </button>
                  )}
                </div>
              ) : typeof v === "boolean" ? (
                <input
                  className="ad-switch"
                  type="checkbox"
                  aria-label={fields[key]}
                  checked={v}
                  disabled={disabled}
                  onChange={(e) =>
                    setValue((p) => ({ ...p, [key]: e.target.checked }))
                  }
                />
              ) : [
                  "intro",
                  "description",
                  "footer",
                  "maintenance_message",
                  "allowed_extensions",
                ].includes(key) ? (
                <textarea
                  aria-label={fields[key]}
                  value={Array.isArray(v) ? v.join(", ") : v}
                  disabled={disabled}
                  onChange={(e) =>
                    setValue((p) => ({
                      ...p,
                      [key]: Array.isArray(v)
                        ? e.target.value
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean)
                        : e.target.value,
                    }))
                  }
                />
              ) : (
                <input
                  aria-label={fields[key]}
                  type={typeof v === "number" ? "number" : "text"}
                  value={v}
                  disabled={disabled}
                  onChange={(e) =>
                    setValue((p) => ({
                      ...p,
                      [key]:
                        typeof v === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    }))
                  }
                />
              )}
            </label>
          ))}
        {error && <p className="admin-error">{error}</p>}
        <button className="ad-button primary" disabled={disabled || uploading}>
          保存设置
        </button>
      </form>
    </Panel>
  );
}
function ActionDialog({
  modal,
  role,
  onClose,
  onDone,
}: {
  modal: { action: string; data: Row; name: string };
  role: AdminRole;
  onClose: () => void;
  onDone: (r: Row) => Promise<void>;
}) {
  const [values, setValues] = useState<Row>(modal.data),
    [reason, setReason] = useState(""),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const action = modal.action;
  const names: Record<string, string> = {
    restrict_user: "设置用户限制",
    edit_user: "编辑用户",
    room_status: "更新房间状态",
    transfer_host: "转移主持人",
    remove_member: "移出成员",
    assign_task: "重新分配任务",
    delete_message: "删除消息",
    content_view: "查看敏感正文",
    file_status: "更新文件状态",
    invite_update: "更新邀请",
    settings: "保存网站设置",
    feature_flag: "设置功能开关",
    announcement: "保存公告",
    delete_announcement: "删除公告",
    resolve_report: "处理举报",
    file_view: "审计访问私有文件",
    orphan_cleanup: "清理孤立对象",
    revoke_sessions: "撤销登录会话",
    admin_member: "管理管理员权限",
    ip_rule: "设置 IP 限制",
    delete_ip_rule: "解除 IP 限制",
    cleanup: "清理过期数据",
  };
  const field = (
    key: string,
    label: string,
    type = "text",
    opts?: string[],
  ) => (
    <label>
      {label}
      {opts ? (
        <select
          value={values[key] || opts[0]}
          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
        >
          {opts.map((s) => (
            <option key={s} value={s}>
              {labels[s] || s}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          aria-label={label}
          value={values[key] || ""}
          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
        />
      ) : (
        <input
          aria-label={label}
          type={type}
          value={
            type === "datetime-local" && values[key]
              ? new Date(
                  new Date(values[key]).getTime() -
                    new Date(values[key]).getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)
              : values[key] || ""
          }
          onChange={(e) =>
            setValues((v) => ({
              ...v,
              [key]:
                type === "number" ? Number(e.target.value) : e.target.value,
            }))
          }
        />
      )}
    </label>
  );
  return (
    <Dialog.Root open onOpenChange={(v) => !v && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="ad-overlay" />
        <Dialog.Content
          className="ad-modal"
          aria-describedby="ad-action-description"
        >
          <header>
            <Dialog.Title>{names[action]}</Dialog.Title>
            <Dialog.Close aria-label="关闭操作">
              <X size={20} />
            </Dialog.Close>
          </header>
          <p id="ad-action-description">
            操作对象：<strong>{modal.name}</strong>
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const data: Row = { ...values, reason, confirm };
                if (action === "restrict_user" && data.until)
                  data.until = new Date(data.until).toISOString();
                if (
                  action === "assign_task" &&
                  typeof data.assignee_ids === "string"
                )
                  data.assignee_ids = data.assignee_ids
                    .split(/[\s,]+/)
                    .filter(Boolean);
                if (
                  action === "feature_flag" &&
                  typeof data.targets === "string"
                )
                  data.targets = data.targets.split(/[\s,]+/).filter(Boolean);
                if (action === "announcement") {
                  data.starts_at = new Date(data.starts_at).toISOString();
                  if (data.ends_at)
                    data.ends_at = new Date(data.ends_at).toISOString();
                }
                if (action === "invite_update" && data.expires_at)
                  data.expires_at = new Date(data.expires_at).toISOString();
                if (action === "ip_rule" && data.expires_at)
                  data.expires_at = new Date(data.expires_at).toISOString();
                if (action === "resolve_report")
                  data.resolution_action = data.resolution_action || "approve";
                if (action === "admin_member")
                  data.role = data.role || "operations";
                if (action === "file_view") {
                  window.open(
                    `/api/admin/files/${values.id}/download?reason=${encodeURIComponent(reason)}`,
                    "_blank",
                    "noopener,noreferrer",
                  );
                  onClose();
                } else
                  await onDone(
                    await api<Row>("admin/command", { action, data }),
                  );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {action === "restrict_user" && (
              <>
                {field("status", "限制级别", "text", [
                  "normal",
                  "limited_post",
                  "limited_room",
                  "limited_upload",
                  "banned",
                ])}
                {field("until", "限制到期（留空为长期）", "datetime-local")}
              </>
            )}
            {action === "edit_user" && (
              <>
                {field("display_name", "昵称")}
                {field("avatar_url", "头像 HTTPS 链接")}
              </>
            )}
            {action === "room_status" && (
              <p>
                变更为：
                <Badge value={values.status} />
                {values.status === "deleted" &&
                  " · 软删除保留历史，可由管理员恢复。"}
              </p>
            )}
            {action === "file_status" && (
              <p>
                变更为：
                <Badge value={values.status} /> · 历史卡片保留，下载权限同步。
              </p>
            )}
            {action === "assign_task" && values.participant_options && (
              <fieldset>
                <legend>选择负责人</legend>
                {values.participant_options.map((p: Row) => (
                  <label className="ad-confirm" key={p.id}>
                    <input
                      type="checkbox"
                      checked={(Array.isArray(values.assignee_ids)
                        ? values.assignee_ids
                        : []
                      ).includes(p.id)}
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          assignee_ids: e.target.checked
                            ? [
                                ...(Array.isArray(v.assignee_ids)
                                  ? v.assignee_ids
                                  : []),
                                p.id,
                              ]
                            : (Array.isArray(v.assignee_ids)
                                ? v.assignee_ids
                                : []
                              ).filter((id: string) => id !== p.id),
                        }))
                      }
                    />
                    {p.display_name}
                  </label>
                ))}
              </fieldset>
            )}
            {action === "assign_task" && !values.participant_options && (
              <label>
                负责人 Participant ID（逗号分隔）
                <textarea
                  value={
                    Array.isArray(values.assignee_ids)
                      ? values.assignee_ids.join(", ")
                      : values.assignee_ids || ""
                  }
                  onChange={(e) =>
                    setValues((v) => ({ ...v, assignee_ids: e.target.value }))
                  }
                />
              </label>
            )}
            {action === "invite_update" && !values.revoke && (
              <>
                {field("expires_at", "邀请到期时间", "datetime-local")}
                {field("max_uses", "最大使用次数", "number")}
              </>
            )}
            {action === "feature_flag" && (
              <>
                <label>
                  启用
                  <input
                    type="checkbox"
                    className="ad-switch"
                    checked={values.enabled}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, enabled: e.target.checked }))
                    }
                  />
                </label>
                {field("scope", "灰度范围", "text", [
                  "all",
                  "users",
                  "rooms",
                  "admins",
                  "percentage",
                ])}
                <label>
                  指定对象 ID（逗号分隔）
                  <textarea
                    value={
                      Array.isArray(values.targets)
                        ? values.targets.join(", ")
                        : values.targets || ""
                    }
                    onChange={(e) =>
                      setValues((v) => ({ ...v, targets: e.target.value }))
                    }
                  />
                </label>
                {field("rollout", "灰度比例 0–100", "number")}
              </>
            )}
            {action === "announcement" && (
              <>
                {field("title", "公告标题")}
                {field("content", "公告内容", "textarea")}
                {field("starts_at", "开始时间", "datetime-local")}
                {field("ends_at", "结束时间（可选）", "datetime-local")}
                {field("position", "展示位置", "text", [
                  "all",
                  "public",
                  "app",
                ])}
                <label>
                  允许关闭
                  <input
                    type="checkbox"
                    className="ad-switch"
                    checked={values.dismissible}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        dismissible: e.target.checked,
                      }))
                    }
                  />
                </label>
                <label>
                  启用公告
                  <input
                    type="checkbox"
                    className="ad-switch"
                    checked={values.enabled}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, enabled: e.target.checked }))
                    }
                  />
                </label>
              </>
            )}
            {action === "resolve_report" &&
              field("resolution_action", "处理方式", "text", [
                "approve",
                "dismiss",
                "processing",
                ...(values.target_type === "message"
                  ? ["delete_message"]
                  : values.target_type === "file"
                    ? ["quarantine"]
                    : values.target_type === "room"
                      ? ["freeze"]
                      : []),
                "warning",
                "limited_post",
                "limited_upload",
                "limited_room",
                "banned",
              ])}
            {action === "admin_member" && (
              <>
                {!modal.data.id && field("id", "用户 UID")}
                {values.role === "remove" ? (
                  <p className="admin-error">撤销该用户的网站管理员权限</p>
                ) : (
                  field("role", "管理员角色", "text", [
                    "operations",
                    "technical",
                    "super",
                  ])
                )}
              </>
            )}
            {action === "ip_rule" && (
              <>
                {field("network", "IP 或 CIDR 网段")}
                {field("expires_at", "限制到期时间（可选）", "datetime-local")}
              </>
            )}
            {action === "settings" && (
              <p className="ad-help">
                保存 {values.key} 配置。修改后在线前台在 3 秒内同步。
              </p>
            )}
            <label>
              {action === "content_view" ? "查看原因" : "操作原因"}
              <textarea
                required
                minLength={3}
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="请填写明确原因，至少 3 个字"
              />
            </label>
            <label className="ad-confirm">
              <input
                type="checkbox"
                required
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              我确认对「{modal.name}」执行此操作
            </label>
            {error && (
              <div className="admin-error" role="alert">
                {error}
              </div>
            )}
            <footer>
              <button
                type="button"
                className="ad-button"
                onClick={onClose}
                disabled={busy}
              >
                取消
              </button>
              <button
                className={`ad-button ${["delete_message", "restrict_user", "room_status", "file_status", "revoke_sessions", "cleanup", "admin_member"].includes(action) ? "danger" : "primary"}`}
                disabled={busy || !confirm || reason.trim().length < 3}
              >
                {busy ? "提交中…" : "确认执行"}
              </button>
            </footer>
            <p className="ad-help">
              {labels[role]} · 所有操作由服务端验证并记录审计
            </p>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
