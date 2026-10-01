import type { Metadata } from "next";
import { settings } from "@/lib/control";
import { SiteProvider } from "@/components/SiteProvider";
import "./globals.css";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const config = await settings();
  return {
    title: config.information.title,
    description: config.information.description,
    icons: config.brand.favicon ? { icon: config.brand.favicon } : undefined,
  };
}
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <SiteProvider>{children}</SiteProvider>
      </body>
    </html>
  );
}
