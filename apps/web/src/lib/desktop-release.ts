import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repositoryRoot } from "@island/runtime";

export type DesktopRelease = {
  schema: 1;
  version: string;
  platform: "win32";
  arch: "x64";
  minimumWindows: string;
  url: string;
  sha256: string;
  size: number;
  signed: boolean;
  guide: "/guide";
  runtime?: string;
  installScriptSha256?: string;
};

// Only a local, administrator-published manifest is read. This never fetches a
// user-supplied URL, and download links are restricted to our release locations.
export function validateDesktopRelease(value: unknown): DesktopRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    data.schema !== 1 ||
    data.platform !== "win32" ||
    data.arch !== "x64" ||
    typeof data.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.version) ||
    typeof data.minimumWindows !== "string" ||
    !data.minimumWindows.trim() ||
    data.minimumWindows.length > 100 ||
    typeof data.url !== "string" ||
    typeof data.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(data.sha256) ||
    !Number.isSafeInteger(data.size) ||
    (data.size as number) <= 0 ||
    typeof data.signed !== "boolean" ||
    data.guide !== "/guide" ||
    (data.runtime !== undefined &&
      (typeof data.runtime !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(data.runtime))) ||
    (data.installScriptSha256 !== undefined &&
      (typeof data.installScriptSha256 !== "string" ||
        !/^[a-fA-F0-9]{64}$/.test(data.installScriptSha256)))
  )
    return null;
  const filename = `Island-Setup-${data.version}-x64.exe`;
  const localDownload = data.url === `/desktop/${filename}`;
  let githubDownload = false;
  try {
    const url = new URL(data.url);
    githubDownload =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname ===
        `/mitang-ai/agentxzlts/releases/download/desktop-v${data.version}/${filename}`;
  } catch {
    /* Relative, same-site downloads are validated above. */
  }
  if (!localDownload && !githubDownload) return null;
  return {
    schema: 1,
    version: data.version,
    platform: "win32",
    arch: "x64",
    minimumWindows: data.minimumWindows,
    url: data.url,
    sha256: data.sha256.toLowerCase(),
    size: data.size as number,
    signed: data.signed,
    guide: "/guide",
    ...(typeof data.runtime === "string" ? { runtime: data.runtime } : {}),
    ...(typeof data.installScriptSha256 === "string"
      ? { installScriptSha256: data.installScriptSha256.toLowerCase() }
      : {}),
  };
}

export async function desktopRelease(): Promise<DesktopRelease | null> {
  try {
    const manifest = await readFile(
      /* turbopackIgnore: true */ resolve(
        repositoryRoot(),
        "apps/web/public/desktop/release.json",
      ),
      "utf8",
    );
    if (manifest.length > 16384) return null;
    return validateDesktopRelease(JSON.parse(manifest));
  } catch {
    // Missing, incomplete or invalid metadata must not become a fake download.
    return null;
  }
}
