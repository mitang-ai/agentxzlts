import { desktopRelease } from "@/lib/desktop-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const release = await desktopRelease();
  return Response.json(
    release || {
      error: "Windows 桌面客户端尚未发布",
      code: "DESKTOP_NOT_PUBLISHED",
    },
    { status: release ? 200 : 404, headers: { "Cache-Control": "no-store" } },
  );
}
