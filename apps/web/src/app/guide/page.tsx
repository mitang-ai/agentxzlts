import type { Metadata } from "next";
import { Download, ArrowLeft } from "lucide-react";
import GuideActions from "@/components/GuideActions";
import DesktopInstallAction from "@/components/DesktopInstallAction";
import {
  guideTitle,
  guideIntroduction,
  guideSections,
  guideBoundaries,
} from "@/lib/operation-guide";
import { desktopRelease } from "@/lib/desktop-release";
import "./guide.css";

export const metadata: Metadata = {
  title: "操作指南与 Windows 客户端 · 协作岛",
};
export const dynamic = "force-dynamic";

export default async function GuidePage() {
  const release = await desktopRelease();
  return (
    <main className="operation-guide">
      <header className="guide-header">
        <a href="/" className="guide-back">
          <ArrowLeft size={16} />
          返回协作岛
        </a>
        <span>操作指南 · Windows 桌面客户端</span>
      </header>
      <section className="guide-introduction">
        <p className="guide-eyebrow">一份说明，两种使用方式</p>
        <h1>{guideTitle}</h1>
        <p>{guideIntroduction}</p>
        <GuideActions release={release} />
      </section>
      <section
        className="guide-download"
        id="download"
        aria-labelledby="download-title"
      >
        <div>
          <h2 id="download-title">Windows 桌面客户端</h2>
          <p>完整协作岛界面 ＋ 本机 Agent 管理中心，共用同一个 Hub。</p>
          <p>
            首发：Windows 10 22H2 x64 / Windows 11 x64。网页版继续独立可用。
          </p>
        </div>
        {release ? (
          <div className="guide-release" data-testid="desktop-release">
            {release.installScriptSha256 && (
              <DesktopInstallAction sha256={release.installScriptSha256} />
            )}
            <a
              className={
                release.installScriptSha256 ? "secondary compact" : "primary"
              }
              href={release.url}
            >
              <Download size={17} />
              直接下载 Windows EXE
            </a>
            <p>
              v{release.version} · {(release.size / 1048576).toFixed(1)} MB ·{" "}
              {release.minimumWindows}
            </p>
            {!release.signed && (
              <p className="guide-warning">
                本版本未进行 Windows
                代码签名，系统可能显示安全提示。仅使用本页发布链接，并核对下方校验值；不要关闭系统保护。
              </p>
            )}
            <details>
              <summary>查看下载校验值</summary>
              <p>EXE SHA-256</p>
              <code>{release.sha256}</code>
              {release.installScriptSha256 && (
                <>
                  <p>install.ps1 SHA-256</p>
                  <code>{release.installScriptSha256}</code>
                </>
              )}
              <p>
                可使用 PowerShell：
                <code>
                  Get-FileHash -Algorithm SHA256 -LiteralPath
                  '下载文件的完整路径'
                </code>
              </p>
            </details>
          </div>
        ) : (
          <div className="guide-release" role="status">
            <strong>Windows 客户端尚未发布</strong>
            <p>
              当前没有有效发布清单。请继续使用网页，稍后再查看；不要下载来源不明的安装包。
            </p>
          </div>
        )}
      </section>
      <section
        className="guide-diagram"
        aria-label="网页、桌面版和本机 Agent 的关系"
      >
        <div>
          <strong>网页 / 桌面 GUI</strong>
          <span>聊天、任务、文件与审批</span>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <strong>同一协作岛服务</strong>
          <span>同一账号、房间和数据</span>
        </div>
        <div>
          <strong>本机管理中心</strong>
          <span>查看状态、设置与诊断</span>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <strong>一个 Hub · 多个 Agent</strong>
          <span>独立身份、执行器与工作区</span>
        </div>
      </section>
      <div className="guide-body">
        <nav className="guide-contents" aria-label="操作指南目录">
          <strong>快速定位</strong>
          <a href="#download">下载与校验</a>
          {guideSections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
          <a href="#llm-boundary">LLM 操作边界</a>
        </nav>
        <article>
          {guideSections.map((section) => (
            <section id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.steps && (
                <ol>
                  {section.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
              {section.note && (
                <aside className="guide-note">{section.note}</aside>
              )}
            </section>
          ))}
          <section id="llm-boundary">
            <h2>LLM 阅读与操作边界</h2>
            {guideBoundaries.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <a href="/guide/llm" target="_blank" rel="noopener noreferrer">
              打开可直接读取的 Markdown 全文 →
            </a>
          </section>
        </article>
      </div>
    </main>
  );
}
