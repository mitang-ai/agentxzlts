import { describe, expect, it } from "vitest";
import {
  desktopRelease,
  validateDesktopRelease,
} from "../apps/web/src/lib/desktop-release";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  guideSections,
  guideOrigin,
  operationGuideMarkdown,
} from "../apps/web/src/lib/operation-guide";

const manifest = {
  schema: 1,
  version: "0.4.0",
  platform: "win32",
  arch: "x64",
  minimumWindows: "Windows 10 22H2 x64",
  signed: false,
  guide: "/guide",
  url: "https://github.com/mitang-ai/agentxzlts/releases/download/desktop-v0.4.0/Island-Setup-0.4.0-x64.exe",
  sha256: "A".repeat(64),
  size: 123456,
  runtime: "24.14.1",
  installScriptSha256: "B".repeat(64),
};

describe("公开桌面发布清单和同源操作文档", () => {
  it("机器说明使用配置的公开来源，不暴露反代内部地址", () => {
    expect(
      guideOrigin("http://127.0.0.1:3000/guide/llm", "https://www.51wanai.com"),
    ).toBe("https://www.51wanai.com");
    expect(guideOrigin("http://localhost:3109/guide/llm")).toBe(
      "http://localhost:3109",
    );
    expect(
      guideOrigin("http://localhost:3109/guide/llm", "javascript:alert(1)"),
    ).toBe("http://localhost:3109");
    expect(
      guideOrigin(
        "http://localhost:3109/guide/llm",
        "https://user:secret@example.com",
      ),
    ).toBe("http://localhost:3109");
  });
  it("从固定本地文件读取，缺失、无效或过大清单均拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "island-release-manifest-"));
    const previous = process.env.ISLAND_ROOT;
    process.env.ISLAND_ROOT = root;
    try {
      expect(await desktopRelease()).toBeNull();
      const directory = join(root, "apps/web/public/desktop");
      await mkdir(directory, { recursive: true });
      const file = join(directory, "release.json");
      await writeFile(file, "invalid json");
      expect(await desktopRelease()).toBeNull();
      await writeFile(
        file,
        JSON.stringify({ ...manifest, ignored: "x".repeat(17000) }),
      );
      expect(await desktopRelease()).toBeNull();
      await writeFile(file, JSON.stringify(manifest));
      expect(await desktopRelease()).toEqual(validateDesktopRelease(manifest));
    } finally {
      if (previous === undefined) delete process.env.ISLAND_ROOT;
      else process.env.ISLAND_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  it("只返回经过校验的公开字段和规范化校验值", () => {
    const result = validateDesktopRelease({
      ...manifest,
      private_token: "never-expose",
    });
    expect(result).toMatchObject({
      sha256: "a".repeat(64),
      installScriptSha256: "b".repeat(64),
      signed: false,
    });
    expect(result).not.toHaveProperty("private_token");
    expect(
      validateDesktopRelease({
        ...manifest,
        url: "/desktop/Island-Setup-0.4.0-x64.exe",
      }),
    ).not.toBeNull();
  });
  it("拒绝任意下载代理、其它仓库、凭据、重定向查询和版本错配", () => {
    for (const url of [
      "http://github.com/mitang-ai/agentxzlts/releases/download/desktop-v0.4.0/Island-Setup-0.4.0-x64.exe",
      "https://example.com/Island-Setup-0.4.0-x64.exe",
      "https://github.com.evil.invalid/mitang-ai/agentxzlts/releases/download/desktop-v0.4.0/Island-Setup-0.4.0-x64.exe",
      manifest.url.replace("mitang-ai", "another-user"),
      manifest.url.replace("desktop-v0.4.0", "desktop-v0.3.0"),
      manifest.url.replace("Island-Setup-0.4.0", "Island-Setup-0.3.0"),
      manifest.url + "?redirect=http://127.0.0.1",
      manifest.url + "#hash",
      manifest.url.replace("https://", "https://user:secret@"),
      "/desktop/unrelated.exe",
      "//example.com/Island-Setup-0.4.0-x64.exe",
      "/desktop/../unrelated.exe",
    ])
      expect(validateDesktopRelease({ ...manifest, url }), url).toBeNull();
  });
  it("清单不完整或字段无效时不提供伪下载", () => {
    for (const replacement of [
      { schema: 2 },
      { version: "latest" },
      { arch: "arm64" },
      { platform: "linux" },
      { minimumWindows: "" },
      { sha256: "" },
      { size: 0 },
      { size: 1.2 },
      { signed: "false" },
      { guide: "/admin" },
      { runtime: "latest" },
      { installScriptSha256: "invalid" },
    ])
      expect(
        validateDesktopRelease({ ...manifest, ...replacement }),
      ).toBeNull();
    expect(validateDesktopRelease(null)).toBeNull();
    expect(validateDesktopRelease({})).toBeNull();
  });
  it("人类与 LLM 文档共享所有章节、权限边界与发布校验值", () => {
    const markdown = operationGuideMarkdown(
      "https://www.51wanai.com",
      validateDesktopRelease(manifest),
    );
    for (const section of guideSections) {
      expect(markdown).toContain(section.title);
      for (const text of section.paragraphs) expect(markdown).toContain(text);
    }
    expect(markdown).toContain("https://www.51wanai.com/desktop/install.ps1");
    expect(markdown).toContain("b".repeat(64));
    expect(markdown).toContain("未签名");
    expect(markdown).toContain("不要输出密钥或本机隐私");
    expect(markdown).toContain("旧版客户端和配置不会自动删除或迁移");
    expect(markdown).toContain("不同 Windows 账号、WSL 和容器");
    expect(markdown).toContain("不能保证自动唤醒");
    expect(markdown).toContain("关闭或退出桌面界面不应默认停止");
  });
  it("无发布元数据时明确要求读取真实清单，而不是生成安装假成功", () => {
    const markdown = operationGuideMarkdown("https://www.51wanai.com", null);
    expect(markdown).toContain("DESKTOP_NOT_PUBLISHED");
    expect(markdown).not.toContain("## 当前 Windows 发布\n版本：");
  });
});
