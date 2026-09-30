import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "协作岛 · 一起把想法做成",
  description: "聊天、分工与文件，在一个轻松的协作空间里。",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
