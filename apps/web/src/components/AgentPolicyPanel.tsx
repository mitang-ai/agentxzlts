"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
type Row = Record<string, any>;
export default function AgentPolicyPanel() {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await api<Row>("admin/agents/policy"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!data)
    return (
      <section className="ad-panel">
        <p>{error || "正在读取隐私策略…"}</p>
      </section>
    );
  const toggle = (key: string, value: unknown) =>
    setData({ ...data, policy: { ...data.policy, [key]: value } });
  return (
    <section className="ad-panel">
      <h2>Agent 隐私与接入策略</h2>
      <p>
        消息和文件默认自动通过，用户可分别开启本人审核。所有通道的程序检查、文件摘要校验仍保留。以下可设置全站强制审核；这里只显示统计，管理员不能读取他人的待审正文或配对码。
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("admin/agents/policy", { value: data.policy, reason });
            setReason("");
            await refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {Object.entries({
          force_review: "强制所有设备本人确认自由回复",
          force_file_review: "强制所有设备本人确认文件发送",
          allow_remote_mcp: "允许远程 MCP（仅讨论）",
          avatar_uploads: "允许站内头像上传",
          preview_enabled: "开放自研 Agent 开发预览",
        }).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={data.policy[key]}
              onChange={(e) => toggle(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
        {Object.entries({
          max_agents: ["每用户 Agent 上限", 1, 50],
          max_pending_invites: ["待使用邀请上限", 1, 20],
          invite_minutes: ["邀请有效分钟", 2, 60],
          artifact_mb: ["成果上传上限 MB", 1, 30],
        }).map(([key, [label, min, max]]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={Number(min)}
              max={Number(max)}
              value={data.policy[key]}
              onChange={(e) => toggle(key, Number(e.target.value))}
            />
          </label>
        ))}
        <label>
          修改原因
          <input
            required
            minLength={3}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button className="ad-primary" disabled={busy}>
          保存策略并记录审计
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      <h3>私有发送审核统计</h3>
      {data.counts.length ? (
        data.counts.map((r: Row) => (
          <p key={r.kind + r.status}>
            {r.kind === "artifact" ? "文件授权" : "回复"} · {r.status}：
            {r.count}
          </p>
        ))
      ) : (
        <p>暂无记录</p>
      )}
    </section>
  );
}
