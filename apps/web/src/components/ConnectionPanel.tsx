"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Bot,
  Monitor,
  Trash2,
  Plus,
  Copy,
  Download,
  Crown,
  VolumeX,
  Volume2,
  Check,
  Pause,
  Play,
  Square,
  GitMerge,
  FileText,
  RefreshCw,
} from "lucide-react";
import { ParticipantAvatar } from "@island/ui";
import type { RoomState } from "@island/protocol";
import { api, size } from "@/lib/client";
import "./connections.css";
type Row = Record<string, any>;
function BriefFiles({
  title,
  ids,
  files,
  disabled,
  upload,
  remove,
}: {
  title: string;
  ids: string[];
  files: RoomState["files"];
  disabled: boolean;
  upload: (files: File[]) => Promise<void>;
  remove: (id: string) => void;
}) {
  return (
    <div className="brief-files">
      <label className="connection-upload">
        上传{title}文件
        <input
          type="file"
          multiple
          accept=".txt,.md,.docx,.pdf"
          aria-label={`上传${title}文件`}
          disabled={disabled}
          onChange={(event) => {
            const chosen = Array.from(event.target.files || []);
            event.target.value = "";
            void upload(chosen);
          }}
        />
      </label>
      <small>
        支持
        TXT、Markdown、Word（.docx）、PDF，可多选；上传文件后正文可不填。原文件随版本发送给
        Agent。
      </small>
      {ids.map((id) => (
        <div className="brief-file" key={id}>
          <a href={`/api/files/${id}`}>
            {files.find((file) => file.id === id)?.name || "已上传文档"}
          </a>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            aria-label={`移除${title}文件 ${files.find((file) => file.id === id)?.name || id}`}
            onClick={() => remove(id)}
          >
            移除
          </button>
        </div>
      ))}
    </div>
  );
}
function connectionPrompt(origin: string, pairing: Row, development: boolean) {
  return (
    [
      `请在你所在的设备自动安装并连接协作岛房间`,
      `本次安装标识为 ${pairing.id}，以当前操作系统用户的主目录为基准，固定使用 .island-node/clients/${pairing.id} 作为专用安装目录，同一条提示词重复执行必须复用此目录、配置和身份，不能创建第二份安装或新的席位`,
      `先确认接收此提示词的当前宿主产品，不能按本机安装的工具自动选择其它 Agent：Codex/Claude Code/OpenCode 仅能选择自己的 CLI；WorkBuddy 等支持 MCP 的 GUI Agent 必须选择 mcp 宿主直连；只有当前产品自己提供真实接口时才可选择 acp/cli/a2a/http，接口不明时停下报告，不允许回退到 Codex`,
      `首先检查此专用目录里的 ${JSON.stringify(`.data/connections/${pairing.id}/config.json`)}，在恢复前核对 adapter/host_name 是否确实对应当前宿主，旧配置指向其它 CLI 时必须停止本专用错误实例并报告需要新邀请重配，不得直接 start。若已正确配对，CLI 用已安装 Node.js 执行 packages/node/bin/island-node.mjs status --config 查看状态，已运行只报告现有连接，未运行用同一配置 start；mcp 模式则复用当前宿主已有的专用 mcpServers 配置，由该宿主启动 mcp 命令，不后台启动 start。不下载、不重装、不重新配对，配对码过期或已使用也不影响正确身份的恢复`,
      `仅在尚未安装时，向 ${origin}/api/agent-node/client 发送 POST 请求（Content-Type: application/json，请求体 ${JSON.stringify({ code: pairing.code })}）下载客户端 ZIP，无需网页登录，配对码只放请求体，解压到上述固定目录，已有运行中的安装不得覆盖`,
      `首次配置时在该目录运行 Windows 的 connect.cmd 或 Linux/macOS 的 bash connect.sh，启动程序会自动准备 Node.js 22+、npm 和客户端依赖`,
      `给启动程序传入 --non-interactive --server ${JSON.stringify(origin)} --code ${JSON.stringify(pairing.code)} --config ${JSON.stringify(`.data/connections/${pairing.id}/config.json`)} --adapter 当前宿主接入类型 --host 当前产品名称 --workspace 专用工作目录的绝对路径 --name 设备名称 --agent-name 你的昵称 ${development ? "--allow-development" : "--no-development"}，占位参数请填写真实值；mcp 模式首次配置会输出专用 mcpServers，请将它添加到当前宿主，必须由当前宿主启动该 MCP，不能另开 CLI 后台转发`,
      development
        ? `我授权你在上述专用工作目录下的隔离子目录开发，请检测并准备 Git，收到聊天室批准的任务后再执行开发`
        : `本次仅授权联机讨论，本机开发保持关闭`,
      `配对码有效至 ${new Date(pairing.expires_at).toISOString()} 且只能首次配对一次，客户端会阻止同一配置重复启动；首次连接成功后保持客户端在后台运行并保存进程号和日志，不得复制其他 Agent 的配置、凭据或工作目录，不得终止其他 Agent 的进程`,
      `MCP 宿主批准后使用 island_wait_task 有界等待点名，使用当前宿主自己处理并调用 island_complete_task 回传。MCP 不保证 GUI 在后台自动唤醒；没有任务时停止本轮等待并说明限制，不得无限轮询，不得调用 Codex/Claude 等其它 CLI 代答。旧配置若实际 adapter 与当前宿主不一致，停止本专用实例后报告需要新邀请重配，不复用错误席位`,
      `加入后等待人类管理者审批及点名，最后报告实际 adapter/宿主、连接状态、日志位置、重新启动和停止方法；若无法接入当前宿主、设备无法访问网站或配对码失效，请明确报告原因`,
    ].join("；") + "。"
  );
}
const stages: Record<string, string> = {
  discussing: "主持讨论",
  aligning: "对齐需求与分工",
  ready: "等待人类批准开发",
  developing: "各设备本地开发",
  review: "成果审阅与合并",
  completed: "协作已完成",
  paused: "已暂停，等待处理",
  stopped: "本轮已停止",
};
const turnNames: Record<string, string> = {
  host: "主持发言",
  speak: "点名发言",
  align: "确认文档",
  develop: "本地开发",
  mention: "回应人类点名",
};
const states: Record<string, string> = {
  queued: "等待设备",
  leased: "正在执行",
  completed: "已回传",
  failed: "执行失败",
  cancelled: "已停止",
  expired: "已超时",
};
export default function ConnectionPanel({
  state,
  onChanged,
  notify,
}: {
  state: RoomState;
  onChanged: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const roomId = state.room.id,
    [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pairing, setPairing] = useState<Row | null>(null),
    [siteOrigin, setSiteOrigin] = useState(""),
    [promptDevelopment, setPromptDevelopment] = useState(false),
    [requirements, setRequirements] = useState(""),
    [design, setDesign] = useState(""),
    [baseId, setBaseId] = useState(""),
    [docs, setDocs] = useState<string[]>([]),
    [requirementsFiles, setRequirementsFiles] = useState<string[]>([]),
    [designFiles, setDesignFiles] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [draft, setDraft] = useState<Row[]>([]),
    [approved, setApproved] = useState(false),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<Row | null>(null),
    [resolutions, setResolutions] = useState<Record<string, string>>({}),
    [mergeConfirmed, setMergeConfirmed] = useState(false);
  const copying = useRef(false);
  const removeInvitations = async (input: Row) => {
    if (
      !window.confirm(
        "删除后，此前复制但尚未使用的连接提示词将失效。已连接的 Agent 不受影响，确定删除吗？",
      )
    )
      return;
    const result = await request("delete-pairings", input);
    if (result) {
      if (pairing && result.deleted_ids.includes(pairing.id)) setPairing(null);
      notify("未使用的邀请码已删除，现在可以复制新提示词。");
    }
  };
  const refresh = useCallback(async () => {
    try {
      setData(await api<Row>(`rooms/${roomId}/agents`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [roomId]);
  useEffect(() => {
    setSiteOrigin(window.location.origin);
    setPairing(null);
    setPromptDevelopment(false);
  }, [roomId]);
  useEffect(() => {
    if (
      pairing &&
      (new Date(pairing.expires_at).getTime() <= Date.now() ||
        data?.pairings?.some(
          (row: Row) =>
            row.id === pairing.id && (row.used_at || row.revoked_at),
        ))
    )
      setPairing(null);
  }, [pairing, data?.pairings]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (data?.brief) {
      setRequirements(data.brief.requirements);
      setDesign(data.brief.design);
      setBaseId(data.brief.base_file_id || "");
      setDocs(data.brief.file_ids || []);
      setRequirementsFiles(data.brief.requirements_file_ids || []);
      setDesignFiles(data.brief.design_file_ids || []);
    }
  }, [data?.brief?.id]);
  useEffect(() => {
    setDraft(data?.session?.plan || []);
    setApproved(false);
    setPreview(null);
    setResolutions({});
    setMergeConfirmed(false);
  }, [data?.session?.id, data?.session?.plan_version]);
  const request = async (action: string, input: Row = {}) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<Row>(`rooms/${roomId}/agents/${action}`, input);
      await refresh();
      await onChanged();
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const person = (id: string) =>
    data?.seats.find((s: Row) => s.participant_id === id)?.display_name ||
    state.participants.find((p) => p.id === id)?.display_name ||
    "已离开的成员";
  const activeSeats = (data?.seats || []).filter(
    (s: Row) => s.state === "approved" && !s.muted,
  );
  const removableSeats = (data?.seats || []).filter((s: Row) =>
    ["rejected", "revoked"].includes(s.state),
  );
  const session = data?.session,
    brief = data?.brief,
    manager = Boolean(data?.manager);
  const running = session && !["completed", "stopped"].includes(session.stage);
  const editable =
    manager && (!session || !["developing", "review"].includes(session.stage));
  const uploadBase = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await api<{ id: string }>(`rooms/${roomId}/files`, form);
      setBaseId(result.id);
      await onChanged();
      notify("代码基线已上传，请发布需求与设计版本。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const uploadDocuments = async (
    files: File[],
    category: "requirements" | "design",
  ) => {
    if (!files.length || busy || !editable) return;
    const chosenIds = [
      ...new Set([...docs, ...requirementsFiles, ...designFiles]),
    ];
    if (chosenIds.length + files.length > 20) {
      setError("需求与设计最多关联 20 个文件，请先移除部分附件。");
      return;
    }
    if (files.some((file) => !/\.(txt|md|docx|pdf)$/i.test(file.name))) {
      setError("请选择 TXT、Markdown、Word（.docx）或 PDF 文档。");
      return;
    }
    setBusy(true);
    setError("");
    let uploaded = 0;
    try {
      for (const file of files) {
        const form = new FormData();
        // Windows 对 Markdown 等文件可能不提供 MIME；按已允许的扩展名补全。
        const mime = (
          {
            txt: "text/plain",
            md: "text/markdown",
            pdf: "application/pdf",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          } as Record<string, string>
        )[file.name.split(".").pop()!.toLowerCase()];
        form.append("file", new File([file], file.name, { type: mime }));
        const result = await api<{ id: string }>(`rooms/${roomId}/files`, form);
        const setFiles =
          category === "requirements" ? setRequirementsFiles : setDesignFiles;
        setFiles((current) => [...current, result.id]);
        uploaded++;
      }
      notify(`已上传 ${uploaded} 个文件，请发布需求与设计版本。`);
    } catch (e) {
      setError(
        `${(e as Error).message}${uploaded ? `；前 ${uploaded} 个文件已保留，可继续上传剩余文件。` : ""}`,
      );
    } finally {
      try {
        await onChanged();
      } catch (e) {
        setError((e as Error).message);
      }
      setBusy(false);
    }
  };
  const updatePlan = (index: number, key: string, value: any) =>
    setDraft(
      draft.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
    );
  const prompt =
    pairing && siteOrigin
      ? connectionPrompt(siteOrigin, pairing, promptDevelopment)
      : "";
  const copyText = async (text: string, success: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(success);
    } catch {
      notify("浏览器未允许自动复制，请选中下方文本手动复制。");
    }
  };
  const copyConnectionPrompt = async () => {
    if (copying.current || busy) return;
    copying.current = true;
    setBusy(true);
    setError("");
    try {
      const current = await api<Row>(`rooms/${roomId}/agents/pairing`, {});
      if (!current) return;
      setPairing(current);
      await copyText(
        connectionPrompt(window.location.origin, current, promptDevelopment),
        "新的连接提示词已复制，直接交给要连接的 Agent。",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      copying.current = false;
      setBusy(false);
    }
  };
  if (!data)
    return (
      <div className="connection-panel">
        <p role="status">{error || "正在读取联机席位…"}</p>
      </div>
    );
  return (
    <section className="connection-panel" aria-label="联机席位与 Agent 协作">
      <header className="connection-title">
        <div>
          <h2>联机席位</h2>
          <p>让不同设备上的 Agent 加入同一个房间，在各自本地完成工作。</p>
        </div>
        <button
          className="icon-button"
          aria-label="刷新联机席位"
          onClick={() => void refresh()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
      <div className="connection-guide">
        <Monitor size={21} />
        <div>
          <strong>连接自己的 Agent</strong>
          <p>
            复制一键连接提示词，交给另一台设备上的
            Agent，它会自行下载、安装并申请加入房间，随后等待人类管理者批准。
            每次复制都会生成独立连接，连接下一个 Agent 时再次点击复制即可。
          </p>
          <label className="connection-check">
            <input
              type="checkbox"
              checked={promptDevelopment}
              onChange={(event) => setPromptDevelopment(event.target.checked)}
            />
            允许此 Agent 在本机专用工作目录内开发（仍需批准聊天室任务）
          </label>
          {siteOrigin &&
            /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|$)/.test(
              siteOrigin,
            ) && (
              <p>
                当前地址仅供本机连接；异地设备请从可访问的 HTTPS
                网站打开本房间后复制提示词。
              </p>
            )}
          <div className="connection-actions">
            <button
              className="primary compact"
              disabled={busy || !state.capabilities?.agents}
              onClick={() => void copyConnectionPrompt()}
            >
              <Copy size={15} />
              复制一键连接提示词
            </button>
            <a
              className="secondary compact"
              href={`/api/rooms/${roomId}/agents/client`}
            >
              <Download size={15} />
              下载 Node 客户端
            </a>
          </div>
          {prompt && (
            <label>
              一键连接提示词
              <textarea
                aria-label="一键连接提示词"
                readOnly
                rows={6}
                value={prompt}
                onFocus={(event) => event.target.select()}
              />
              <small>
                每次复制自动生成新配对码，有效期 10 分钟。每份提示词只交给一个
                Agent；该 Agent 重连时使用它原来保存的提示词。
              </small>
            </label>
          )}
        </div>
      </div>
      {pairing && (
        <div className="connection-pair-code">
          <div>
            <strong>一次性配对码</strong>
            <small>
              有效至 {new Date(pairing.expires_at).toLocaleTimeString("zh-CN")}
              ，仅交给你要连接的设备。
            </small>
          </div>
          <code>{pairing.code}</code>
          <div className="connection-actions">
            <button
              className="secondary compact"
              onClick={() => void copyText(pairing.code, "配对码已复制")}
            >
              <Copy size={14} />
              复制配对码
            </button>
            <button
              className="text-button"
              onClick={async () => {
                if (await request("revoke-pairing", { pairing_id: pairing.id }))
                  setPairing(null);
              }}
            >
              撤销此码
            </button>
          </div>
        </div>
      )}
      <section className="connection-invitations" aria-label="我的待连接邀请">
        <div className="connection-actions">
          <strong>我的待连接邀请（{data?.my_pairings?.length || 0}/5）</strong>
          <button
            className="text-button"
            disabled={busy || !data?.my_pairings?.length}
            onClick={() => void removeInvitations({ all: true })}
          >
            一键删除未使用邀请
          </button>
        </div>
        <small>
          包含你在各房间创建的有效邀请码。刷新后仍可管理；这里只显示邀请记录，不保存或回显旧码明文。删除不会移除已连接设备。
        </small>
        {!data?.my_pairings?.length && <p>暂无待连接邀请</p>}
        {data?.my_pairings?.map((item: Row) => (
          <div
            className="connection-invitation"
            key={item.id}
            aria-label={`待连接邀请 ${item.id}`}
          >
            <div>
              <strong>{item.room_name}</strong>
              <small>
                邀请 {item.id.slice(0, 8)} · 创建于{" "}
                {new Date(item.created_at).toLocaleTimeString("zh-CN")} · 到期{" "}
                {new Date(item.expires_at).toLocaleTimeString("zh-CN")}
              </small>
            </div>
            <button
              className="text-button"
              disabled={busy}
              aria-label={`删除邀请码 ${item.id}`}
              onClick={() => void removeInvitations({ pairing_ids: [item.id] })}
            >
              删除
            </button>
          </div>
        ))}
      </section>
      {manager && removableSeats.length > 0 && (
        <div className="connection-actions seat-cleanup">
          <span>已撤销或拒绝的记录：{removableSeats.length}</span>
          <button
            className="danger-text"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "删除全部已撤销或拒绝的 Agent 记录？不会影响已批准的 Agent，也不会删除聊天和任务历史。",
                )
              )
                void request("delete-seats", { all: true });
            }}
          >
            <Trash2 size={14} />
            一键删除失效记录
          </button>
        </div>
      )}
      {data.seats.length ? (
        <div className="connection-seats">
          {data.seats.map((s: Row) => {
            const online =
              s.state === "approved" &&
              s.last_seen_at &&
              Date.now() - new Date(s.last_seen_at).getTime() < 45000;
            const host = s.participant_id === data.agent_host_participant_id;
            return (
              <article
                className={`connection-seat ${host ? "chair" : ""}`}
                key={s.participant_id}
                aria-label={`${s.display_name} 的联机席位`}
              >
                <ParticipantAvatar
                  name={s.display_name}
                  online={Boolean(online)}
                  size={42}
                />
                <div className="seat-info">
                  <strong>
                    <Bot size={14} />
                    {s.display_name}
                    {host && (
                      <span className="host-badge">
                        <Crown size={12} />
                        Agent 主持人
                      </span>
                    )}
                  </strong>
                  <small>
                    {s.node_name} · {s.adapter}
                    {s.capabilities?.host_name
                      ? `（${s.capabilities.host_name}）`
                      : ""}{" "}
                    · {s.capabilities.development ? "本机已授权开发" : "仅讨论"}
                  </small>
                  <span className="seat-status">
                    {s.state === "pending"
                      ? "待人类管理者批准"
                      : s.state === "rejected"
                        ? "已拒绝"
                        : s.state === "revoked"
                          ? "已撤销"
                          : s.muted
                            ? "已静音"
                            : !online
                              ? "设备离线"
                              : s.activity === "idle"
                                ? "已批准，等待点名或任务"
                                : turnNames[s.activity] || "在线"}
                  </span>
                </div>
                {manager && (
                  <div className="seat-controls">
                    {s.state === "pending" ? (
                      <>
                        <button
                          className="primary compact"
                          disabled={busy}
                          aria-label={`批准 ${s.display_name}`}
                          onClick={() =>
                            void request("approve", {
                              participant_id: s.participant_id,
                            })
                          }
                        >
                          <Check size={14} />
                          批准
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          aria-label={`拒绝 ${s.display_name}`}
                          onClick={() =>
                            void request("reject", {
                              participant_id: s.participant_id,
                            })
                          }
                        >
                          拒绝
                        </button>
                      </>
                    ) : s.state === "approved" ? (
                      <>
                        <button
                          className="secondary compact"
                          disabled={busy || running || s.muted || host}
                          aria-label={`选定 ${s.display_name} 为 Agent 主持人`}
                          onClick={() =>
                            void request("host", {
                              participant_id: s.participant_id,
                            })
                          }
                        >
                          <Crown size={14} />
                          {host ? "已选定" : "设为主持"}
                        </button>
                        <button
                          className="icon-button"
                          disabled={busy}
                          aria-label={`${s.muted ? "解除静音" : "静音"} ${s.display_name}`}
                          onClick={() =>
                            void request("mute", {
                              participant_id: s.participant_id,
                              muted: !s.muted,
                            })
                          }
                        >
                          {s.muted ? (
                            <Volume2 size={16} />
                          ) : (
                            <VolumeX size={16} />
                          )}
                        </button>
                        <button
                          className="danger-text"
                          disabled={busy}
                          aria-label={`撤销 ${s.display_name} 的设备`}
                          onClick={() => {
                            if (
                              window.confirm(
                                "撤销后设备立即失去房间权限，正在执行的任务会停止。",
                              )
                            )
                              void request("revoke", {
                                participant_id: s.participant_id,
                              });
                          }}
                        >
                          撤销
                        </button>
                      </>
                    ) : (
                      <button
                        className="danger-text"
                        disabled={busy}
                        aria-label={`删除 ${s.display_name} 的记录`}
                        onClick={() => {
                          if (
                            window.confirm(
                              `删除 ${s.display_name} 的联机记录？聊天和任务历史会保留。`,
                            )
                          )
                            void request("delete-seats", {
                              participant_id: s.participant_id,
                            });
                        }}
                      >
                        <Trash2 size={14} />
                        删除记录
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="connection-empty">
          <Bot size={30} />
          <strong>还没有设备申请联机</strong>
          <p>配对后显示真实设备状态，Agent 会等待明确点名和任务。</p>
        </div>
      )}
      <div className="connection-rule">
        <strong>受控发言</strong>
        <p>
          只有人类明确 @、主持人点名或已批准任务会唤起
          Agent。每次授权结束即等待；Agent 的普通回复不会自动唤起其他
          Agent。人类管理者可以静音、暂停或停止协作。
        </p>
      </div>
      <section className="collaboration-section">
        <header>
          <div>
            <h2>需求与设计对齐</h2>
            <p>版本确认后才能开发，修改文档会要求重新对齐。</p>
          </div>
          {brief && <span className="brief-version">v{brief.revision}</span>}
        </header>
        {brief && (
          <div className="brief-summary">
            <details>
              <summary>
                <FileText size={15} />
                阅读当前需求与设计
              </summary>
              <h3>开发需求</h3>
              <p className="brief-text">
                {brief.requirements || "以需求附件为准"}
              </p>
              {(brief.requirements_file_ids || []).map((id: string) => (
                <a className="brief-file" key={id} href={`/api/files/${id}`}>
                  {state.files.find((f) => f.id === id)?.name || "需求附件"}
                </a>
              ))}
              <h3>设计文档</h3>
              <p className="brief-text">{brief.design || "以设计附件为准"}</p>
              {(brief.design_file_ids || []).map((id: string) => (
                <a className="brief-file" key={id} href={`/api/files/${id}`}>
                  {state.files.find((f) => f.id === id)?.name || "设计附件"}
                </a>
              ))}
              <div className="connection-actions">
                {brief.file_ids
                  .filter(
                    (fid: string) =>
                      ![
                        ...(brief.requirements_file_ids || []),
                        ...(brief.design_file_ids || []),
                      ].includes(fid),
                  )
                  .map((fid: string) => (
                    <a
                      className="text-button"
                      href={`/api/files/${fid}`}
                      key={fid}
                    >
                      {state.files.find((f) => f.id === fid)?.name ||
                        "附加文档"}
                    </a>
                  ))}
              </div>
            </details>
            {!data.acks.some((a: Row) => a.participant_id === data.me) && (
              <button
                className="secondary compact"
                disabled={busy}
                onClick={() =>
                  void request("acknowledge", { brief_id: brief.id })
                }
              >
                我已阅读并确认此版本
              </button>
            )}
          </div>
        )}
        {manager && (
          <details className="brief-editor" open={!brief}>
            <summary>
              {brief ? "发布新的需求版本" : "发布开发需求、设计与代码基线"}
            </summary>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await request("brief", {
                  requirements,
                  design,
                  file_ids: docs,
                  requirements_file_ids: requirementsFiles,
                  design_file_ids: designFiles,
                  base_file_id: baseId || null,
                });
                if (result) notify("需求与设计版本已发布。");
              }}
            >
              <label>
                开发需求
                <textarea
                  aria-label="开发需求"
                  rows={5}
                  maxLength={32000}
                  required={!requirementsFiles.length}
                  value={requirements}
                  onChange={(e) => setRequirements(e.target.value)}
                  disabled={busy || !editable}
                />
              </label>
              <BriefFiles
                title="开发需求"
                ids={requirementsFiles}
                files={state.files}
                disabled={busy || !editable}
                upload={(files) => uploadDocuments(files, "requirements")}
                remove={(id) => {
                  setRequirementsFiles((current) =>
                    current.filter((fid) => fid !== id),
                  );
                  setDocs((current) => current.filter((fid) => fid !== id));
                }}
              />
              <label>
                设计文档
                <textarea
                  aria-label="设计文档"
                  rows={5}
                  maxLength={32000}
                  required={!designFiles.length}
                  value={design}
                  onChange={(e) => setDesign(e.target.value)}
                  disabled={busy || !editable}
                />
              </label>
              <BriefFiles
                title="设计文档"
                ids={designFiles}
                files={state.files}
                disabled={busy || !editable}
                upload={(files) => uploadDocuments(files, "design")}
                remove={(id) => {
                  setDesignFiles((current) =>
                    current.filter((fid) => fid !== id),
                  );
                  setDocs((current) => current.filter((fid) => fid !== id));
                }}
              />
              <label>
                代码基线
                <select
                  aria-label="代码基线"
                  value={baseId}
                  onChange={(e) => setBaseId(e.target.value)}
                  disabled={!editable}
                >
                  <option value="">仅讨论，稍后上传源码 ZIP</option>
                  {state.files
                    .filter(
                      (f) =>
                        f.mime_type === "application/zip" &&
                        f.status !== "deleted" &&
                        f.status !== "quarantined",
                    )
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="connection-upload">
                上传纯源码 ZIP（不含凭据、依赖或 Git 内部目录）
                <input
                  aria-label="上传代码基线"
                  type="file"
                  accept=".zip"
                  disabled={busy || !editable}
                  onChange={(e) => void uploadBase(e.target.files?.[0])}
                />
              </label>
              {!!state.files.length && (
                <fieldset>
                  <legend>一同对齐的房间文件</legend>
                  {state.files
                    .filter(
                      (f) =>
                        f.id !== baseId &&
                        !requirementsFiles.includes(f.id) &&
                        !designFiles.includes(f.id) &&
                        f.status !== "deleted" &&
                        f.status !== "quarantined",
                    )
                    .map((f) => (
                      <label className="connection-check" key={f.id}>
                        <input
                          type="checkbox"
                          checked={docs.includes(f.id)}
                          disabled={!editable}
                          onChange={(e) =>
                            setDocs(
                              e.target.checked
                                ? [...docs, f.id]
                                : docs.filter((id) => id !== f.id),
                            )
                          }
                        />
                        {f.name}
                      </label>
                    ))}
                </fieldset>
              )}
              <button className="primary" disabled={busy || !editable}>
                发布需求与设计
              </button>
              {!editable && (
                <p className="muted">
                  开发或审阅中请先停止本轮，再发布新的需求版本。
                </p>
              )}
            </form>
          </details>
        )}
      </section>
      <section className="collaboration-section">
        <header>
          <div>
            <h2>主持讨论与分工</h2>
            <p>围绕主题有限讨论，由主持人安排必要的发言并提出任务。</p>
          </div>
        </header>
        {manager && !running && (
          <form
            className="session-start"
            onSubmit={async (e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              const result = await request("start", {
                topic: String(values.get("topic")),
                max_turns: Number(values.get("max_turns")),
                minutes: 30,
                attendee_ids: [
                  ...new Set([data.agent_host_participant_id, ...selected]),
                ],
              });
              if (result) notify("本轮协作已开始。");
            }}
          >
            <label>
              讨论主题
              <textarea
                aria-label="讨论主题"
                name="topic"
                rows={2}
                required
                maxLength={2000}
                placeholder="例如：按确认文档完成前后台适配并交付可运行源码"
              />
            </label>
            <label>
              最大发言次数
              <input
                aria-label="最大发言次数"
                name="max_turns"
                type="number"
                min={3}
                max={40}
                defaultValue={12}
              />
            </label>
            <fieldset>
              <legend>本轮参与 Agent（最多 8 位，主持人自动参与）</legend>
              {activeSeats.map((s: Row) => (
                <label className="connection-check" key={s.participant_id}>
                  <input
                    type="checkbox"
                    checked={
                      selected.includes(s.participant_id) ||
                      s.participant_id === data.agent_host_participant_id
                    }
                    disabled={
                      s.participant_id === data.agent_host_participant_id
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, s.participant_id]
                          : selected.filter((id) => id !== s.participant_id),
                      )
                    }
                  />
                  {s.display_name}
                </label>
              ))}
            </fieldset>
            <button
              className="primary"
              disabled={
                busy ||
                !brief ||
                !data.agent_host_participant_id ||
                !activeSeats.length
              }
            >
              <Play size={15} />
              开始主持讨论
            </button>
          </form>
        )}
        {session && (
          <div className="session-status" aria-live="polite">
            <div>
              <strong>{stages[session.stage]}</strong>
              <p>{session.topic}</p>
              <small>
                讨论发言 {session.turns_created} / {session.max_turns} ·
                人类管理者保留停止与审批权
              </small>
              {session.error && (
                <p className="connection-error">{session.error}</p>
              )}
            </div>
            {manager && running && (
              <div className="connection-actions">
                {session.stage === "paused" ? (
                  <button
                    className="secondary compact"
                    disabled={busy}
                    onClick={() =>
                      void request("resume", { session_id: session.id })
                    }
                  >
                    <Play size={14} />
                    继续协作
                  </button>
                ) : (
                  <button
                    className="secondary compact"
                    disabled={busy}
                    onClick={() =>
                      void request("pause", { session_id: session.id })
                    }
                  >
                    <Pause size={14} />
                    暂停
                  </button>
                )}
                <button
                  className="danger-text"
                  disabled={busy}
                  onClick={() =>
                    void request("stop", { session_id: session.id })
                  }
                >
                  <Square size={14} />
                  停止本轮
                </button>
              </div>
            )}
          </div>
        )}
        {!!draft.length && (
          <div className="collaboration-plan">
            <h3>本轮分工方案</h3>
            {draft.map((task: Row, i: number) => (
              <article key={i}>
                <label>
                  任务名称
                  <input
                    aria-label={`分工 ${i + 1} 名称`}
                    value={task.title}
                    disabled={
                      !manager ||
                      ["developing", "review", "completed", "stopped"].includes(
                        session.stage,
                      )
                    }
                    onChange={(e) => updatePlan(i, "title", e.target.value)}
                  />
                </label>
                <label>
                  任务描述
                  <textarea
                    aria-label={`分工 ${i + 1} 描述`}
                    value={task.description}
                    rows={2}
                    disabled={
                      !manager ||
                      ["developing", "review", "completed", "stopped"].includes(
                        session.stage,
                      )
                    }
                    onChange={(e) =>
                      updatePlan(i, "description", e.target.value)
                    }
                  />
                </label>
                <div className="plan-fields">
                  <label>
                    负责人
                    <select
                      aria-label={`分工 ${i + 1} 负责人`}
                      value={task.assignee_id}
                      disabled={
                        !manager ||
                        [
                          "developing",
                          "review",
                          "completed",
                          "stopped",
                        ].includes(session.stage)
                      }
                      onChange={(e) =>
                        updatePlan(i, "assignee_id", e.target.value)
                      }
                    >
                      {session.attendee_ids.map((pid: string) => (
                        <option key={pid} value={pid}>
                          {person(pid)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    允许修改的文件或目录
                    <input
                      aria-label={`分工 ${i + 1} 范围`}
                      value={task.paths.join(", ")}
                      disabled={
                        !manager ||
                        [
                          "developing",
                          "review",
                          "completed",
                          "stopped",
                        ].includes(session.stage)
                      }
                      onChange={(e) =>
                        updatePlan(
                          i,
                          "paths",
                          e.target.value
                            .split(",")
                            .map((v) => v.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>
        )}
        {manager &&
          session &&
          running &&
          !["developing", "review"].includes(session.stage) && (
            <div className="connection-actions">
              <button
                className="secondary compact"
                disabled={busy}
                onClick={() =>
                  setDraft([
                    ...draft,
                    {
                      title: "",
                      description: "",
                      assignee_id: session.attendee_ids[0],
                      paths: ["src"],
                    },
                  ])
                }
              >
                <Plus size={14} />
                补充分工
              </button>
              <button
                className="secondary compact"
                disabled={busy || !draft.length}
                onClick={() =>
                  void request("plan", { session_id: session.id, plan: draft })
                }
              >
                保存分工并重新对齐
              </button>
            </div>
          )}
        {session && (
          <div className="alignment-status">
            <h3>Agent 版本确认</h3>
            {session.attendee_ids.map((pid: string) => {
              const confirmed = data.acks.some(
                (a: Row) =>
                  a.participant_id === pid && a.brief_id === session.brief_id,
              );
              return (
                <span key={pid} className={confirmed ? "confirmed" : ""}>
                  {confirmed ? <Check size={14} /> : <FileText size={14} />}{" "}
                  {person(pid)} · {confirmed ? "已确认" : "等待确认"}
                </span>
              );
            })}
          </div>
        )}
        {manager && session?.stage === "ready" && (
          <div className="development-approval">
            <p>
              参与 Agent
              已对齐同一版本。批准后，在各自设备明确授权的隔离目录开发；人类仍可随时停止。
            </p>
            <label className="connection-check">
              <input
                type="checkbox"
                aria-label="确认分工并授权本地开发"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />
              我已审阅分工，批准这些设备按确认文档进行本地开发
            </label>
            <button
              className="primary"
              disabled={busy || !approved}
              onClick={() =>
                void request("approve-plan", {
                  session_id: session.id,
                  confirm: true,
                })
              }
            >
              <Play size={15} />
              批准本地开发
            </button>
          </div>
        )}
        {!!data.work.length && (
          <div className="connection-work">
            <h3>本地开发进度</h3>
            {data.work.map((task: Row) => (
              <div key={task.task_id}>
                <strong>{task.title}</strong>
                <span>{person(task.assignee_id)}</span>
                <small>
                  {
                    (
                      {
                        pending: "等待设备",
                        running: "本机开发中",
                        submitted: "已回传，等待审阅",
                        accepted: "已接受",
                        rejected: "已退回",
                      } as Record<string, string>
                    )[task.state]
                  }
                </small>
                {manager && task.state === "rejected" && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void request("retry-work", { task_id: task.task_id })
                    }
                  >
                    按审阅意见重新开发
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {!!data.artifacts.length && (
        <section className="collaboration-section">
          <header>
            <div>
              <h2>开发成果与合并</h2>
              <p>
                真实变更包保存在房间私有文件；先审阅，再处理冲突并生成合并源码。
              </p>
            </div>
          </header>
          {data.artifacts
            .filter((a: Row) => a.session_id === session?.id)
            .map((a: Row) => (
              <article className="connection-artifact" key={a.id}>
                <div className="artifact-heading">
                  <strong>
                    {data.work.find((w: Row) => w.task_id === a.task_id)
                      ?.title || a.name}
                  </strong>
                  <span>
                    {
                      (
                        {
                          proposed: "待审阅",
                          accepted: "已接受",
                          rejected: "已退回",
                          merged: "已合并",
                        } as Record<string, string>
                      )[a.state]
                    }{" "}
                    · {size(a.size)}
                  </span>
                </div>
                <p>{a.manifest.summary || "本地成果已回传。"}</p>
                <a className="text-button" href={`/api/files/${a.file_id}`}>
                  <Download size={14} />
                  下载变更包
                </a>
                <details>
                  <summary>
                    查看 {a.manifest.changes.length} 项源码变更与本机验证
                  </summary>
                  <ul>
                    {a.manifest.changes.map((c: Row) => (
                      <li key={c.path}>
                        {c.sha256 === null
                          ? "删除"
                          : c.base_sha256
                            ? "修改"
                            : "新增"}{" "}
                        {c.path}
                      </li>
                    ))}
                  </ul>
                  {(a.manifest.checks || []).map((c: Row, i: number) => (
                    <div className="local-check" key={i}>
                      <strong>
                        {c.status === "passed"
                          ? "本机报告通过"
                          : c.status === "failed"
                            ? "本机报告失败"
                            : "未执行验证"}{" "}
                        · {c.command}
                      </strong>
                      <pre>{c.output}</pre>
                    </div>
                  ))}
                </details>
                {a.review_note && (
                  <p className="muted">审阅意见：{a.review_note}</p>
                )}
                {manager && a.state !== "merged" && (
                  <div className="artifact-review">
                    <input
                      aria-label={`成果 ${a.id} 审阅意见`}
                      placeholder="填写具体审阅意见"
                      value={notes[a.id] || ""}
                      onChange={(e) =>
                        setNotes({ ...notes, [a.id]: e.target.value })
                      }
                    />
                    <div className="connection-actions">
                      <button
                        className="secondary compact"
                        disabled={busy || !notes[a.id]?.trim()}
                        aria-label={`接受成果 ${a.id}`}
                        onClick={() =>
                          void request("review", {
                            artifact_id: a.id,
                            accept: true,
                            note: notes[a.id],
                          })
                        }
                      >
                        <Check size={14} />
                        接受成果
                      </button>
                      <button
                        className="danger-text"
                        disabled={busy || !notes[a.id]?.trim()}
                        aria-label={`退回成果 ${a.id}`}
                        onClick={() =>
                          void request("review", {
                            artifact_id: a.id,
                            accept: false,
                            note: notes[a.id],
                          })
                        }
                      >
                        退回修改
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          {manager && session?.stage === "review" && (
            <div className="merge-review">
              <button
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  setError("");
                  try {
                    setPreview(
                      await api<Row>(
                        `rooms/${roomId}/agents/merge-preview?session_id=${session.id}`,
                      ),
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <GitMerge size={15} />
                检查合并与冲突
              </button>
              {preview && (
                <>
                  <p>
                    合并后 {preview.files.length} 个源码文件 ·{" "}
                    {preview.conflicts.length
                      ? `${preview.conflicts.length} 项冲突需要选定版本`
                      : "未发现文件冲突"}
                  </p>
                  {preview.conflicts.map((conflict: Row) => (
                    <label key={conflict.path}>
                      冲突：{conflict.path}
                      <select
                        aria-label={`冲突 ${conflict.path}`}
                        value={resolutions[conflict.path] || ""}
                        onChange={(e) =>
                          setResolutions({
                            ...resolutions,
                            [conflict.path]: e.target.value,
                          })
                        }
                      >
                        <option value="">请选择保留版本</option>
                        <option value="baseline">保留代码基线版本</option>
                        {conflict.versions.map((v: Row) => (
                          <option key={v.artifact_id} value={v.artifact_id}>
                            {data.work.find(
                              (w: Row) =>
                                w.task_id ===
                                data.artifacts.find(
                                  (a: Row) => a.id === v.artifact_id,
                                )?.task_id,
                            )?.title || v.artifact_id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label className="connection-check">
                    <input
                      type="checkbox"
                      aria-label="确认成果合并"
                      checked={mergeConfirmed}
                      onChange={(e) => setMergeConfirmed(e.target.checked)}
                    />
                    已审阅成果与冲突处理，生成房间合并源码 ZIP
                  </label>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !mergeConfirmed ||
                      preview.conflicts.some((c: Row) => !resolutions[c.path])
                    }
                    onClick={async () => {
                      if (
                        await request("merge", {
                          session_id: session.id,
                          resolutions,
                          confirm: true,
                        })
                      )
                        notify("已合并到聊天室文件。");
                    }}
                  >
                    <GitMerge size={15} />
                    合并到房间文件
                  </button>
                </>
              )}
            </div>
          )}
          {session?.merged_file_id && (
            <div className="merged-result">
              <Check size={19} />
              <strong>合并源码已保存到房间文件</strong>
              <a
                className="primary compact"
                href={`/api/files/${session.merged_file_id}`}
              >
                <Download size={15} />
                下载合并源码
              </a>
            </div>
          )}
        </section>
      )}
      {!!data.turns.length && (
        <details className="connection-history">
          <summary>最近的发言与执行记录</summary>
          {data.turns.slice(0, 20).map((turn: Row) => (
            <div key={turn.id}>
              <span>{person(turn.participant_id)}</span>
              <small>
                {turnNames[turn.kind]} · {states[turn.status]}
              </small>
              {turn.error && <p>{turn.error}</p>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
