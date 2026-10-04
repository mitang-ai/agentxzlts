import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
// @ts-ignore Executable service module.
import { enrollmentDocument } from "../packages/agents/enrollment.mjs";

const script = resolve("apps/web/public/desktop/install.ps1");
const psString = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const windows = process.platform === "win32";
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "island-desktop-bootstrap-"));
  return { root, home: join(root, "home"), install: join(root, "app") };
}
async function startPS(f: Awaited<ReturnType<typeof fixture>>, code: string) {
  const test = join(f.root, randomUUID() + ".ps1");
  await writeFile(
    test,
    "\uFEFF$ErrorActionPreference='Stop'\n. " +
      psString(script) +
      " -FunctionsOnly -TestMode -Quiet -TestHome " +
      psString(f.home) +
      " -TestInstallRoot " +
      psString(f.install) +
      "\n" +
      code,
  );
  const child = spawn("powershell.exe", ["-NoProfile", "-File", test], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b.toString()));
  child.stderr.on("data", (b) => (stderr += b.toString()));
  return {
    child,
    result: once(child, "exit").then(([exit]) => ({ exit, stdout, stderr })),
  };
}
async function runPS(f: Awaited<ReturnType<typeof fixture>>, code: string) {
  return (await startPS(f, code)).result;
}
function manifest(
  url: string,
  bytes = Buffer.from("isolated installer bytes"),
) {
  return {
    schema: 1,
    version: "0.4.0",
    platform: "win32",
    arch: "x64",
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    signed: false,
  };
}
const asPS = (value: unknown) =>
  "(" + psString(JSON.stringify(value)) + " | ConvertFrom-Json)";

it("enrollment 明确 Windows 统一安装、脚本摘要、独立配置和非Windows保留Hub路径", async () => {
  const bytes = await readFile(script);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const p = {
    id: randomUUID(),
    expires_at: "2026-10-03T00:00:00Z",
    client_digest: "e".repeat(64),
    development: true,
  };
  const doc = enrollmentDocument(
    p,
    "private-test-code",
    "https://island.invalid",
    { desktopInstallerDigest: sha },
  );
  expect(doc).toContain("https://island.invalid/desktop/install.ps1");
  expect(doc).toContain(sha);
  expect(doc).toContain("安装锁覆盖等待、下载、校验、静默安装、就绪验证");
  expect(doc).toContain(`.data/connections/${p.id}/config.json`);
  expect(doc).toContain("Linux/macOS");
  expect(doc).toContain("不关闭防护、不绕过签名");
  expect(doc).toContain("不全局安装 Node");
  expect(doc).toContain("刷新仅刷新界面");
  expect(enrollmentDocument(p, "code", "https://island.invalid")).toContain(
    "校验信息暂不可用",
  );
});

it.skipIf(!windows)(
  "PS5.1语法可解析，脚本保留UTF8 BOM且不依赖全局Node/npm",
  async () => {
    const f = await fixture();
    try {
      const result = await runPS(
        f,
        "$errors=$null; $tokens=$null; [Management.Automation.Language.Parser]::ParseFile(" +
          psString(script) +
          ",[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count){throw ($errors|Out-String)}; Write-Output 'PARSED'",
      );
      expect(result.stderr).toBe("");
      expect(result.exit).toBe(0);
      expect(result.stdout).toContain("PARSED");
      expect((await readFile(script)).subarray(0, 3).toString("hex")).toBe(
        "efbbbf",
      );
      const source = await readFile(script, "utf8");
      expect(source).not.toMatch(
        /npm (ci|install)|ExecutionPolicy Bypass|ServerCertificateValidationCallback/,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!windows)(
  "清单严格限制官方地址/平台/摘要/布尔值，测试仅允许显式loopback",
  async () => {
    const f = await fixture();
    try {
      const valid = manifest(
        "https://github.com/mitang-ai/agentxzlts/releases/download/desktop-v0.4.0/Island-Setup-0.4.0-x64.exe",
      );
      const cases = [
        { ...valid, schema: "1" },
        { ...valid, platform: "linux" },
        { ...valid, sha256: "bad" },
        { ...valid, signed: "false" },
        { ...valid, size: 1.5 },
        { ...valid, size: 0 },
        { ...valid, url: "https://evil.invalid/Island-Setup.exe" },
        { ...valid, url: valid.url + "?token=x" },
        { ...valid, url: valid.url.replace("0.4.0-x64.exe", "0.3.0-x64.exe") },
      ];
      const result = await runPS(
        f,
        "$null=Test-SetupManifest " +
          asPS(valid) +
          ";\n" +
          cases
            .map(
              (m, i) =>
                "$bad=$false; try {$null=Test-SetupManifest " +
                asPS(m) +
                "} catch {$bad=$true}; if(!$bad){throw 'case " +
                i +
                " accepted'}",
            )
            .join("\n") +
          "\n$TestMode=$false; $bad=$false; try {$null=Assert-SetupUrl 'http://127.0.0.1:7777/release.json' 'manifest'}catch{$bad=$true}; if(!$bad){throw 'loopback accepted in normal mode'}; Write-Output 'VALIDATED'",
      );
      expect(result.stderr).toBe("");
      expect(result.exit).toBe(0);
      expect(result.stdout).toContain("VALIDATED");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!windows)(
  "真实流式下载按字节进度，错误SHA/长度不允许执行",
  async () => {
    const f = await fixture();
    const payload = Buffer.alloc(196613, 0x61);
    const server = createServer((req, res) => {
      if (req.url === "/bad-length")
        res.writeHead(200, { "Content-Length": payload.length + 1 });
      else res.writeHead(200, { "Content-Length": payload.length });
      res.end(payload);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const good = manifest(base + "/installer", payload);
      const badSha = { ...good, sha256: "b".repeat(64) };
      const wrongSize = { ...good, size: payload.length - 1 };
      const result = await runPS(
        f,
        "$client=New-SetupHttpClient; try {\n" +
          "Save-SetupInstaller $client " +
          asPS(good) +
          " " +
          psString(join(f.root, "good.exe")) +
          ";\n" +
          "$bad=$false; try{Save-SetupInstaller $client " +
          asPS(badSha) +
          " " +
          psString(join(f.root, "bad.exe")) +
          "}catch{if($_.Exception.Message -notlike 'INSTALLER_SHA256:*'){throw};$bad=$true};if(!$bad){throw 'hash accepted'};\n" +
          "$bad=$false; try{Save-SetupInstaller $client " +
          asPS(wrongSize) +
          " " +
          psString(join(f.root, "size.exe")) +
          "}catch{if($_.Exception.Message -notlike 'INSTALLER_SIZE:*'){throw};$bad=$true};if(!$bad){throw 'size accepted'}; Write-Output 'DOWNLOADED'\n}finally{$client.Dispose()}",
      );
      expect(result.stderr).toBe("");
      expect(result.exit).toBe(0);
      expect(await readFile(join(f.root, "good.exe"))).toEqual(payload);
      expect(result.stdout).toContain("DOWNLOADED");
    } finally {
      server.close();
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!windows)("跨进程安装锁先等后复用，超时不删除或抢锁", async () => {
  const f = await fixture();
  try {
    const ready = join(f.root, "lock-ready");
    const first = await startPS(
      f,
      "$paths=Get-SetupPaths; $lock=Enter-SetupLock $paths; try{[IO.File]::WriteAllText(" +
        psString(ready) +
        ",'ready');Start-Sleep -Milliseconds 1800}finally{$lock.Dispose()};Write-Output 'FIRST'",
    );
    for (let i = 0; i < 100; i++) {
      try {
        if ((await readFile(ready, "utf8")) === "ready") break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    const before = Date.now();
    const second = await runPS(
      f,
      "$paths=Get-SetupPaths; $lock=Enter-SetupLock $paths;try{Write-Output 'SECOND'}finally{$lock.Dispose()}",
    );
    expect(second.exit).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toContain("等待已有安装完成");
    expect(Date.now() - before).toBeGreaterThan(1000);
    expect((await first.result).exit).toBe(0);
    const timeout = await runPS(
      f,
      "$paths=Get-SetupPaths;$lock=Enter-SetupLock $paths;try{$LockTimeoutSeconds=1;$bad=$false;try{$null=Enter-SetupLock $paths}catch{if($_.Exception.Message -notlike 'INSTALL_LOCK_TIMEOUT:*'){throw};$bad=$true};if(!$bad){throw 'lock acquired twice'};Write-Output 'LOCK_TIMEOUT'}finally{$lock.Dispose()}",
    );
    expect(timeout.exit).toBe(0);
    expect(timeout.stdout).toContain("LOCK_TIMEOUT");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it.skipIf(!windows)(
  "伪造locator和链接路径在执行前拒绝，保留原文件",
  async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.home, ".island-node"), { recursive: true });
      const bad = {
        schema: 1,
        version: "0.4.0",
        ready: true,
        runtimeVersion: "24.14.1",
        exe: join(f.root, "attacker.exe"),
        node: join(f.home, ".island-node", "runtime", "24.14.1", "node.exe"),
        clientRoot: join(f.home, ".island-node", "client"),
        root: join(f.home, ".island-node", "client"),
      };
      const record = join(f.home, ".island-node", "desktop-install.json");
      await writeFile(record, JSON.stringify(bad));
      const result = await runPS(
        f,
        "$bad=$false;try{$null=Get-SetupLocator (Get-SetupPaths) '0.4.0'}catch{if($_.Exception.Message -notlike 'LOCATOR_PATH:*'){throw};$bad=$true};if(!$bad){throw 'forged path accepted'};Write-Output 'REFUSED'",
      );
      expect(result.stderr).toBe("");
      expect(result.exit).toBe(0);
      expect(JSON.parse(await readFile(record, "utf8"))).toEqual(bad);
      const outside = join(f.root, "outside");
      const link = join(f.root, "link");
      await mkdir(outside);
      await symlink(outside, link, "junction");
      const linked = await runPS(
        f,
        "$bad=$false;try{$null=Assert-SafeSetupPath " +
          psString(join(link, "file.json")) +
          "}catch{if($_.Exception.Message -notlike 'INSTALL_PATH_REPARSE:*'){throw};$bad=$true};if(!$bad){throw 'link accepted'};Write-Output 'LINK_REFUSED'",
      );
      expect(linked.exit).toBe(0);
      expect(linked.stdout).toContain("LINK_REFUSED");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!windows)(
  "已有完整安装读取清单后复用，不下载/执行EXE或重配身份",
  async () => {
    const f = await fixture();
    let requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          manifest(
            `http://127.0.0.1:${(server.address() as any).port}/installer`,
          ),
        ),
      );
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const state = join(f.home, ".island-node"),
        client = join(state, "client");
      const node = join(state, "runtime", "24.14.1", "node.exe");
      const exe = join(f.install, "Island.exe");
      await mkdir(f.install, { recursive: true });
      await mkdir(resolve(node, ".."), { recursive: true });
      for (const file of [
        "connect.cmd",
        "packages/node/bin/island-node.mjs",
        ...["ws", "proper-lockfile", "zod", "yauzl", "yazl"].map(
          (name) => `node_modules/${name}/package.json`,
        ),
      ]) {
        await mkdir(resolve(client, file, ".."), { recursive: true });
        await writeFile(join(client, file), "fixture only");
      }
      await writeFile(join(client, "CLIENT_VERSION.txt"), "hub-1\n");
      const identity = join(client, "existing-private-config.json");
      await writeFile(
        identity,
        "existing fixture identity must remain unchanged",
      );
      const locator = {
        schema: 1,
        version: "0.4.0",
        ready: true,
        runtimeVersion: "24.14.1",
        exe,
        node,
        clientRoot: client,
        root: client,
      };
      await writeFile(
        join(state, "desktop-install.json"),
        JSON.stringify(locator),
      );
      const compile = (name: string, version: string, target: string) =>
        "Add-Type -TypeDefinition " +
        psString(
          'using System.Reflection; [assembly: AssemblyVersion("' +
            version +
            '.0")] [assembly: AssemblyFileVersion("' +
            version +
            '.0")] [assembly: AssemblyInformationalVersion("' +
            version +
            '")] namespace ' +
            name +
            " { public class Stub { public static void Main() {} } }",
        ) +
        " -OutputAssembly " +
        psString(target) +
        " -OutputType ConsoleApplication;\n";
      const result = await runPS(
        f,
        compile("GuiFixture", "0.4.0", exe) +
          compile("NodeFixture", "24.14.1", node) +
          "$ManifestUrl=" +
          psString(
            `http://127.0.0.1:${(server.address() as any).port}/release.json`,
          ) +
          ";Invoke-DesktopSetup;Write-Output 'REUSED'",
      );
      expect(result.stderr).toBe("");
      expect(result.exit).toBe(0);
      expect(result.stdout).toContain('"reused":true');
      expect(requests).toEqual(["/release.json"]);
      expect(await readFile(identity, "utf8")).toBe(
        "existing fixture identity must remain unchanged",
      );
    } finally {
      server.close();
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!windows)("版本清单和安装资产拒绝跨地址跳转及超大清单", async () => {
  const f = await fixture();
  const other = createServer((_req, res) => res.end("must not reach")).listen(
    0,
    "127.0.0.1",
  );
  await once(other, "listening");
  const server = createServer((req, res) => {
    if (req.url === "/oversize") res.end("x".repeat(65537));
    else
      res
        .writeHead(302, {
          Location: `http://127.0.0.1:${(other.address() as any).port}/elsewhere`,
        })
        .end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const result = await runPS(
      f,
      "$client=New-SetupHttpClient;try{\n" +
        "$ManifestUrl=" +
        psString(base + "/redirect") +
        ";$bad=$false;try{$null=Get-SetupManifest $client}catch{if($_.Exception.Message -notlike 'DOWNLOAD_REDIRECT:*'){throw};$bad=$true};if(!$bad){throw 'manifest redirect accepted'};\n" +
        "$bad=$false;try{Save-SetupInstaller $client " +
        asPS(manifest(base + "/redirect")) +
        " " +
        psString(join(f.root, "redirect.exe")) +
        "}catch{if($_.Exception.Message -notlike 'DOWNLOAD_REDIRECT:*'){throw};$bad=$true};if(!$bad){throw 'installer redirect accepted'};\n" +
        "$ManifestUrl=" +
        psString(base + "/oversize") +
        ";$bad=$false;try{$null=Get-SetupManifest $client}catch{if($_.Exception.Message -notlike 'MANIFEST_SIZE:*'){throw};$bad=$true};if(!$bad){throw 'huge manifest accepted'};Write-Output 'LIMITED'\n}finally{$client.Dispose()}",
    );
    expect(result.stderr).toBe("");
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("LIMITED");
  } finally {
    server.close();
    other.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it.skipIf(!windows)(
  "真实安装测试子进程严格隔离HOME和安装目录，正常分支保留Shell安全检查",
  async () => {
    const f = await fixture();
    try {
      const result = await runPS(
        f,
        "$paths=Get-SetupPaths;$ManifestUrl='http://127.0.0.1:7777/release.json';$env:ELECTRON_RUN_AS_NODE='1';" +
          "$info=New-SetupInstallerProcess 'fixture.exe' 'fixture-work' $paths;" +
          "if($info.UseShellExecute -or !$info.CreateNoWindow){throw 'test launcher not hidden'};" +
          "if($info.Arguments -cne ('/S /D='+$paths.Install)){throw 'NSIS directory invalid'};" +
          "if($info.EnvironmentVariables['ISLAND_DESKTOP_TEST'] -cne '1' -or $info.EnvironmentVariables['ISLAND_DESKTOP_TEST_HOME'] -cne $paths.Home -or $info.EnvironmentVariables['ISLAND_DESKTOP_TEST_ORIGIN'] -cne 'http://127.0.0.1:7777'){throw 'test environment invalid'};" +
          "if($info.EnvironmentVariables.ContainsKey('ELECTRON_RUN_AS_NODE')){throw 'electron node flag leaked'};" +
          "if($env:ELECTRON_RUN_AS_NODE -cne '1'){throw 'parent environment changed'};" +
          "$ManifestUrl='https://www.51wanai.com/desktop/release.json';$bad=$false;try{$null=New-SetupInstallerProcess 'fixture.exe' 'fixture-work' $paths}catch{if($_.Exception.Message -notlike 'TEST_ORIGIN_REQUIRED:*'){throw};$bad=$true};if(!$bad){throw 'real website accepted as test origin'};" +
          "$TestMode=$false;$normal=New-SetupInstallerProcess 'fixture.exe' 'fixture-work' $paths;if(!$normal.UseShellExecute -or $normal.Arguments -cne '/S' -or $normal.CreateNoWindow){throw 'normal shell security changed'};Write-Output 'ISOLATED_PROCESS'",
      );
      expect(result.stderr).toBe("");
      expect(result.exit).toBe(0);
      expect(result.stdout).toContain("ISOLATED_PROCESS");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
