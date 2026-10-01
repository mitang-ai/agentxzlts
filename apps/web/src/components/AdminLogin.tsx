"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { SiteBrand } from "./SiteProvider";
import "./admin.css";
export default function AdminLogin({ message }: { message: string }) {
  const [error, setError] = useState(message),
    [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <main className="admin-login">
      <section>
        <SiteBrand />
        <h1>管理后台</h1>
        <p>使用已授权的网站管理员账号登录</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api(
                "auth/login",
                Object.fromEntries(new FormData(e.currentTarget)),
              );
              window.dispatchEvent(new Event("island:session"));
              router.refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            邮箱
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="admin-error" role="alert">
              {error}
            </p>
          )}
          <button className="ad-button primary" disabled={busy}>
            {busy ? "登录中…" : "登录后台"}
          </button>
        </form>
        <a href="/">返回协作空间</a>
      </section>
    </main>
  );
}
