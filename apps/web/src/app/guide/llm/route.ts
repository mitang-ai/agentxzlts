import { guideOrigin, operationGuideMarkdown } from "@/lib/operation-guide";
import { desktopRelease } from "@/lib/desktop-release";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return new Response(
    operationGuideMarkdown(
      guideOrigin(request.url, process.env.APP_ORIGIN),
      await desktopRelease(),
    ),
    {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
