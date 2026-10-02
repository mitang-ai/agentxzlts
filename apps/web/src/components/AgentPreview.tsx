"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import "./agent-center.css";
export default function AgentPreview() {
  const [protocol, setProtocol] = useState("openai"),
    [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    void api<any>("my-agents/policy")
      .then((d) => setEnabled(d.policy.preview_enabled))
      .catch(() => setEnabled(false));
  }, []);
  if (enabled === null)
    return <div className="agent-center">正在读取预览设置…</div>;
  if (!enabled)
    return <div className="agent-center">管理员暂未开放此预览。</div>;
  return (
    <div className="agent-center">
      <header>
        <h1>
          协作岛 Agent <span className="agent-badge">开发中</span>
        </h1>
        <p>这是能力与配置预览，不会调用模型、保存密钥或执行任务。</p>
      </header>
      <section className="agent-card">
        <h2>接入自己的模型</h2>
        <div className="agent-actions">
          <button
            className={
              protocol === "openai" ? "primary compact" : "secondary compact"
            }
            onClick={() => setProtocol("openai")}
          >
            OpenAI 兼容
          </button>
          <button
            className={
              protocol === "anthropic" ? "primary compact" : "secondary compact"
            }
            onClick={() => setProtocol("anthropic")}
          >
            Anthropic 兼容
          </button>
        </div>
        <label>
          Base URL（示意）
          <input
            disabled
            placeholder={
              protocol === "openai"
                ? "https://模型服务地址/v1"
                : "https://模型服务地址"
            }
          />
        </label>
        <label>
          API Key
          <input
            disabled
            type="password"
            placeholder="开发中，不接收真实密钥"
            autoComplete="off"
          />
        </label>
        <button disabled className="secondary">
          探测可用模型（开发中）
        </button>
        <p>
          未来读取服务的模型列表，再进行能力验证；不支持探测的服务可手动填写模型
          ID。发现模型不等于它支持工具或可以执行任务。
        </p>
        <fieldset>
          <legend>模型多选交互示例（演示数据，不保存）</legend>
          <label>
            <input type="checkbox" />
            推理模型 · 用于计划
          </label>
          <label>
            <input type="checkbox" />
            代码模型 · 用于开发
          </label>
          <label>
            <input type="checkbox" />
            审阅模型 · 用于检查
          </label>
        </fieldset>
      </section>
      <section className="agent-card">
        <h2>计划中的真实 Agent 能力</h2>
        <ul>
          <li>拆分目标、制定计划、记住当前项目进度</li>
          <li>在授权的项目范围读取和编辑文件，展示修改差异</li>
          <li>运行经批准的命令与测试，保留可回退检查点</li>
          <li>使用联网检索、浏览器与 MCP 工具，按权限审批</li>
          <li>在聊天室接受点名、与其他 Agent 分工、提交可验收成果</li>
          <li>独立任务上下文、操作审计、发送护栏和资源配额</li>
        </ul>
        <button className="primary" disabled>
          创建 Agent（开发中）
        </button>
        <p>
          当前服务器仅承担网站与通信。未来执行放到独立本地节点或隔离工作机，不在现有低配置服务器运行重型开发任务。
        </p>
      </section>
    </div>
  );
}
