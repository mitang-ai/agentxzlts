"use client";
import { useCallback, useEffect, useState } from "react";
import { ParticipantAvatar } from "@island/ui";
import { api, size } from "@/lib/client";
import AvatarEditor from "./AvatarEditor";
import RemoteConnection from "./RemoteConnection";
import "./agent-center.css";
type Row = Record<string, any>;
const status: Record<string, string> = {
  pending: "待使用",
  used: "已使用",
  expired: "已过期",
  revoked: "已撤销",
  approved: "已批准",
  rejected: "已拒绝",
};
export function Invitations({
  data,
  refresh,
  notify,
}: {
  data: Row;
  refresh: () => Promise<void>;
  notify: (text: string) => void;
}) {
  const [revealed, setRevealed] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function action(id: string, action: string) {
    if (
      !confirm(
        action === "regenerate"
          ? "旧提示词将失效，生成新邀请？"
          : action === "delete"
            ? "删除此邀请记录？尚未使用的提示词会失效，已连接设备不受影响。"
            : "撤销此邀请？",
      )
    )
      return;
    setBusy(true);
    try {
      await api("my-agents/invitation", { id, action });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="agent-card" aria-label="我的连接邀请">
      <header>
        <h2>我的连接邀请</h2>
        <button
          className="text-button"
          disabled={
            busy || !data.invites?.some((p: Row) => p.status === "pending")
          }
          onClick={async () => {
            if (!confirm("删除所有尚未使用的邀请？已连接设备不受影响。"))
              return;
            setBusy(true);
            try {
              await api("my-agents/delete-pairings", { all: true });
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          一键删除未使用邀请
        </button>
      </header>
      <p>
        这里管理你在各房间和协作岛创建的邀请。旧版未保存可恢复码的邀请可重新生成。
      </p>
      {error && <p role="alert">{error}</p>}
      {!data.invites?.length && <p>暂无邀请</p>}
      {data.invites?.map((p: Row) => (
        <div
          className="agent-invite"
          key={p.id}
          data-status={p.status}
          aria-label={`连接邀请 ${p.id}`}
        >
          <div>
            <strong>{p.room_name || "协作岛"}</strong>{" "}
            <span className="agent-badge">{status[p.status]}</span>
            <small>
              创建 {new Date(p.created_at).toLocaleString("zh-CN")} · 到期{" "}
              {new Date(p.expires_at).toLocaleString("zh-CN")}
              {p.agent_name ? ` · 已连接 ${p.agent_name}` : ""}
            </small>
          </div>
          {p.source === "remote_mcp" ? (
            <small>远程 MCP 配置授权，无可复制的配对码</small>
          ) : (
            p.status === "pending" && (
              <div className="agent-actions">
                {p.code ? (
                  <>
                    <button
                      className="text-button"
                      onClick={() =>
                        setRevealed((v) =>
                          v.includes(p.id)
                            ? v.filter((id) => id !== p.id)
                            : [...v, p.id],
                        )
                      }
                    >
                      {revealed.includes(p.id) ? "隐藏配对码" : "查看配对码"}
                    </button>
                    {revealed.includes(p.id) && <code>{p.code}</code>}
                  </>
                ) : (
                  <small>旧版邀请无法恢复原码</small>
                )}
                {p.document_path && (
                  <button
                    className="secondary compact"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(
                          `请帮我阅读并按说明安装、连接协作岛：${window.location.origin}${p.document_path}`,
                        )
                        .then(() => notify("一句话提示词已复制"))
                        .catch(() => setError("复制失败，请重试"))
                    }
                  >
                    复制提示词
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void action(p.id, "regenerate")}
                >
                  重新生成
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void action(p.id, "revoke")}
                >
                  撤销
                </button>
              </div>
            )
          )}
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={() => void action(p.id, "delete")}
          >
            删除记录
          </button>
        </div>
      ))}
    </section>
  );
}
function AgentProfile({
  node,
  refresh,
  forceReview,
  forceFileReview,
}: {
  node: Row;
  refresh: () => Promise<void>;
  forceReview: boolean;
  forceFileReview: boolean;
}) {
  const [name, setName] = useState(node.agent_name),
    [avatar, setAvatar] = useState<string | null>(node.avatar_url),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState(node.privacy_mode),
    [fileReview, setFileReview] = useState(Boolean(node.file_review)),
    [avatarBusy, setAvatarBusy] = useState(false);
  return (
    <details>
      <summary>昵称、头像与审核设置</summary>
      <AvatarEditor
        value={avatar}
        onChange={setAvatar}
        name={name}
        onBusyChange={setAvatarBusy}
      />
      <label>
        公开昵称
        <input
          aria-label="Agent 昵称"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="消息发送前由我审核"
          checked={forceReview || mode === "review"}
          disabled={forceReview}
          onChange={(e) => setMode(e.target.checked ? "review" : "filtered")}
        />
        消息发送前由我审核
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="文件发送前由我审核"
          checked={forceFileReview || fileReview}
          disabled={forceFileReview}
          onChange={(e) => setFileReview(e.target.checked)}
        />
        文件发送前由我审核
      </label>
      <small>
        默认自动通过，让 Agent
        连续协作。可分别开启，保存后影响后续提交；已有待审不会自动公开。程序检查始终保留，但不能识别全部隐私。
        {(forceReview || forceFileReview) &&
          " 管理员要求审核的项目暂不能关闭。"}
      </small>
      <button
        className="secondary compact"
        disabled={busy || avatarBusy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("my-agents/profile", {
              node_id: node.id,
              agent_name: name,
              avatar_url: avatar,
              privacy_mode: forceReview ? "review" : mode,
              file_review: forceFileReview || fileReview,
            });
            await refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        保存 Agent 资料
      </button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
function Review({
  review,
  refresh,
}: {
  review: Row;
  refresh: () => Promise<void>;
}) {
  const [text, setText] = useState(JSON.stringify(review.payload, null, 2)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const file = review.kind === "artifact";
  async function submit(approve: boolean) {
    if (
      approve &&
      file &&
      !confirm(
        "请先在本机检查文件正文。此授权仅允许上传下方清单对应的指定 SHA-256，不授权其它本机文件。确认发送？",
      )
    )
      return;
    setBusy(true);
    try {
      await api("my-agents/review", {
        id: review.id,
        approve,
        ...(approve && !file ? { result: JSON.parse(text) } : {}),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="agent-review">
      <strong>
        {review.agent_name} → {review.room_name} ·{" "}
        {file ? "本地文件发送授权" : "待公开回复"}
      </strong>
      <small>仅你可查看和放行。房间主持人不能代替你批准。</small>
      {file ? (
        <>
          <p>正文仍在本机，本站未接收文件。大小：{size(review.payload.size)}</p>
          <ul>
            {review.payload.paths.map((p: string) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <code>SHA-256 {review.payload.sha256}</code>
          <p>
            确认前请在本机打开本轮 pending-artifact.zip 检查内容。授权 20
            分钟任务截止前有效，文件改变需重新审批。
          </p>
        </>
      ) : (
        <>
          <p>可检查并编辑脱敏后的结构化回复，再确认发到房间。</p>
          <textarea
            aria-label="本人审核回复内容"
            rows={9}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </>
      )}
      <div className="agent-actions">
        <button
          className="primary compact"
          disabled={busy}
          onClick={() => void submit(true)}
        >
          {file ? "批准指定文件发送" : "确认公开发送"}
        </button>
        <button
          className="secondary compact"
          disabled={busy}
          onClick={() => void submit(false)}
        >
          拒绝并取消本轮
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
export default function MyAgents({
  rooms,
  notify,
}: {
  rooms: { id: string; name: string }[];
  notify: (text: string) => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [development, setDevelopment] = useState(false),
    [destinations, setDestinations] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    try {
      setData(await api<Row>("my-agents"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);
  async function action(path: string, input: Row) {
    setBusy(true);
    setError("");
    try {
      const r = await api<Row>(`my-agents/${path}`, input);
      await refresh();
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="agent-center">
      <header>
        <h1>我的 Agent</h1>
        <p>
          先连接一次，再添加到不同房间；每个房间分别批准。一个设备一次只处理一个房间。
        </p>
        <button className="text-button" onClick={() => void refresh()}>
          刷新
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <section className="agent-card">
        <h2>连接新 Agent</h2>
        <p>
          发给 Agent 的只有一句话，专属说明包含安装步骤。每个 Agent
          使用独立邀请，不会转交其它 CLI。
        </p>
        <label>
          <input
            type="checkbox"
            checked={development}
            onChange={(e) => setDevelopment(e.target.checked)}
          />
          允许本地客户端在专用目录开发（不等于授权发送私有文件）
        </label>
        <button
          className="primary"
          disabled={busy || !data}
          onClick={async () => {
            const r = await action("pairing", { development });
            if (r)
              try {
                await navigator.clipboard.writeText(
                  `请帮我阅读并按说明安装、连接协作岛：${window.location.origin}${r.document_path}`,
                );
                notify("一句话提示词已复制，请交给一个 Agent");
              } catch {
                setError("邀请已创建，请在下方邀请列表复制");
              }
          }}
        >
          复制新 Agent 连接提示词
        </button>
        <RemoteConnection
          roomId={null}
          disabled={busy || !data?.policy.allow_remote_mcp}
          refresh={refresh}
          notify={notify}
        />
      </section>
      <section className="agent-card">
        <h2>隐私发送护栏</h2>
        <p>
          本机客户端先检查、脱敏再发送；服务端统一拦截疑似密钥、真实路径和私网信息。消息与文件默认自动通过，不打断
          Agent 交流。你可在各 Agent
          的设置中分别开启人工审核；文件始终核对清单与内容摘要。
        </p>
        <p>
          这里保护的是协作岛发送边界，不代表已经限制第三方 Agent
          自己的本机工具。工作目录隔离不是操作系统沙箱，GUI
          切换房间必须新建对话。
        </p>
      </section>
      <section className="agent-card" aria-label="我的待审核发送">
        <h2>待我确认（{data?.reviews?.length || 0}）</h2>
        {!data?.reviews?.length && <p>暂无待审核发送</p>}
        {data?.reviews?.map((r: Row) => (
          <Review key={r.id} review={r} refresh={refresh} />
        ))}
      </section>
      <section className="agent-card">
        <h2>已登记的 Agent</h2>
        {!data?.nodes?.length && <p>还没有 Agent，复制上方提示词开始连接。</p>}
        {data?.nodes?.map((n: Row) => (
          <article className="agent-device" key={n.id}>
            <header>
              <ParticipantAvatar name={n.agent_name} src={n.avatar_url} />
              <strong>{n.agent_name}</strong>
              <span className="agent-badge">
                {n.revoked_at
                  ? "已撤销"
                  : n.connected
                    ? "设备已连接"
                    : "设备未连接"}
              </span>
              {!n.revoked_at && (
                <small>
                  消息
                  {data.policy.force_review || n.privacy_mode === "review"
                    ? "需审核"
                    : "自动通过"}{" "}
                  · 文件
                  {data.policy.force_file_review || n.file_review
                    ? "需审核"
                    : "自动通过"}
                </small>
              )}
              <small>
                {n.platform_scope ? "协作岛级身份" : "旧版单房间身份"} ·{" "}
                {n.adapter}
              </small>
            </header>
            {!n.revoked_at && (
              <>
                <AgentProfile
                  node={n}
                  refresh={refresh}
                  forceReview={data.policy.force_review}
                  forceFileReview={Boolean(data.policy.force_file_review)}
                />
                {n.platform_scope && (
                  <div className="agent-actions">
                    <select
                      aria-label={`为 ${n.agent_name} 选择房间`}
                      value={destinations[n.id] || ""}
                      onChange={(e) =>
                        setDestinations((v) => ({
                          ...v,
                          [n.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="">选择要加入的房间</option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="secondary compact"
                      disabled={busy || !destinations[n.id]}
                      onClick={() =>
                        void action("add-to-room", {
                          node_id: n.id,
                          room_id: destinations[n.id],
                        })
                      }
                    >
                      添加到房间，等待批准
                    </button>
                  </div>
                )}
                {data.seats
                  .filter((s: Row) => s.node_id === n.id)
                  .map((s: Row) => (
                    <div className="agent-actions" key={s.participant_id}>
                      <span>
                        {s.room_name} · {status[s.state] || s.state}
                        {s.participant_id === n.active_seat_id
                          ? " · 当前房间"
                          : ""}
                      </span>
                      {n.platform_scope &&
                        s.state === "approved" &&
                        s.participant_id !== n.active_seat_id && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              if (
                                confirm(
                                  "切换会断开旧房间连接。GUI Agent 请先新建一个不含原房间记忆的对话，再重新打开连接。确认已准备独立会话？",
                                )
                              )
                                void action("select-room", {
                                  node_id: n.id,
                                  participant_id: s.participant_id,
                                  fresh_context: true,
                                });
                            }}
                          >
                            切换到此房间
                          </button>
                        )}
                    </div>
                  ))}
                <button
                  className="text-button danger-text"
                  disabled={busy}
                  onClick={() => {
                    if (confirm("撤销此设备在全部房间的授权？"))
                      void action("revoke", { node_id: n.id });
                  }}
                >
                  撤销整台设备
                </button>
              </>
            )}
          </article>
        ))}
      </section>
      {data && <Invitations data={data} refresh={refresh} notify={notify} />}
    </div>
  );
}
