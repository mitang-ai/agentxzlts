"use client";

import { useState } from "react";
import type { QuickAccount } from "@/lib/quick-account";

export default function QuickAccountCredentials({
  account,
}: {
  account: QuickAccount;
}) {
  const [message, setMessage] = useState("");
  return (
    <section
      className="quick-account-credentials"
      aria-label="本次生成的账号密码"
    >
      <p className="credential-warning">
        请妥善保管自己的账号和密码，不要发到聊天室或交给他人。
        本页关闭或刷新后不会再次显示密码；未保存可能无法找回账号。
      </p>
      <label>
        登录账号
        <input
          value={account.email}
          readOnly
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label>
        登录密码（明文，仅供本人保存）
        <input
          value={account.password}
          readOnly
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="muted small">
        此账号不是可收邮件的邮箱。以后在“邮箱 /
        登录账号”中输入它，再输入密码即可登录。
      </p>
      <button
        className="secondary full"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              `协作岛登录账号：${account.email}\n登录密码：${account.password}`,
            );
            setMessage("已复制，请保存到自己的密码管理器或其他安全位置。");
          } catch {
            setMessage("复制失败，请手动选择上方账号和密码保存。");
          }
        }}
      >
        复制账号和密码
      </button>
      {message && (
        <p role="status" className="small">
          {message}
        </p>
      )}
    </section>
  );
}
