"use client";
import { useState } from "react";
import { Download, Copy } from "lucide-react";

export default function DesktopInstallAction({ sha256 }: { sha256: string }) {
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      // An HTTPS origin and the server-validated digest are embedded as literals.
      // The script is never executed by the webpage itself.
      const source = `${window.location.origin}/desktop/install.ps1`;
      const command = `$ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP ('island-install-'+[guid]::NewGuid().ToString()+'.ps1'); Invoke-WebRequest -UseBasicParsing -Uri '${source.replaceAll("'", "''")}' -OutFile $p; if((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() -ne '${sha256}'){throw '安装引导校验失败，请勿运行'}; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p`;
      await navigator.clipboard.writeText(command);
      setMessage(
        "安装命令已复制。在 PowerShell 中粘贴执行，将先校验安装引导。网页不会自动执行。",
      );
    } catch {
      setMessage("复制失败。请下载安装引导，按文档核对 SHA-256 后运行。");
    }
  }
  return (
    <div className="guide-install-actions">
      <a className="primary" href="/desktop/install.ps1" download="install.ps1">
        <Download size={17} />
        下载安装引导
      </a>
      <button className="secondary compact" onClick={() => void copy()}>
        <Copy size={16} />
        复制一键安装命令
      </button>
      <p>
        推荐：复制命令到 PowerShell
        执行。统一窗口显示下载、校验与组件准备，不要求管理员权限；下载脚本不代表已经安装。
      </p>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
