"use client";
import { useState } from "react";
import { Copy, FileText, Bot } from "lucide-react";
import { operationGuideMarkdown } from "@/lib/operation-guide";
import type { DesktopRelease } from "@/lib/desktop-release";

export default function GuideActions({
  release,
}: {
  release: DesktopRelease | null;
}) {
  const [message, setMessage] = useState("");
  async function copy(llm: boolean) {
    try {
      const origin = window.location.origin;
      await navigator.clipboard.writeText(
        llm
          ? `请阅读协作岛操作指南：${origin}/guide/llm。先解释操作步骤和限制，不要在未经我授权时安装、删除或执行任务。`
          : operationGuideMarkdown(origin, release),
      );
      setMessage(llm ? "LLM 阅读指令已复制" : "完整操作文档已复制");
    } catch {
      setMessage("复制失败，请打开 Markdown 阅读版并手动复制。");
    }
  }
  return (
    <div className="guide-tools">
      <div className="guide-tool-buttons">
        <button className="secondary compact" onClick={() => void copy(false)}>
          <Copy size={16} />
          复制完整文档
        </button>
        <button className="secondary compact" onClick={() => void copy(true)}>
          <Bot size={16} />
          复制 LLM 阅读指令
        </button>
        <a
          className="secondary compact"
          href="/guide/llm"
          target="_blank"
          rel="noopener noreferrer"
        >
          <FileText size={16} />
          打开 Markdown
        </a>
      </div>
      <p role="status" className="guide-copy-status">
        {message || "人和 Agent 阅读同一份说明；这里不包含配对码和设备凭据。"}
      </p>
    </div>
  );
}
