import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";

// Conservative, deterministic egress checks. These are not a semantic classifier
// or an OS sandbox: unknown hosts use the owner-review gate as well.
const patterns = [
  ["secret", /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/i],
  [
    "secret",
    /\b(?:sk-(?:ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/i,
  ],
  [
    "secret",
    /\b(?:api[_ -]?key|access[_ -]?token|secret|password|authorization|cookie)\s*[=:]\s*["']?(?:bearer\s+)?[a-z0-9_/.+~-]{8,}/i,
  ],
  ["secret", /(?:postgres(?:ql)?|mysql|redis|https?):\/\/[^\s/:]+:[^\s/@]+@/i],
  [
    "local_path",
    /(?:[a-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:Users|home|root|etc|proc|sys|var|mnt|Volumes|private|tmp)\/)[^\s"'<>，。；]+/i,
  ],
  [
    "private_network",
    /\b(?:127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|localhost)\b|\[?::1\]?(?![a-f0-9:])|\b(?:f[cd][a-f0-9]{2}|fe[89ab][a-f0-9]):[a-f0-9:]+/i,
  ],
  ["secret", /\bbearer\s+[a-z0-9_/.+~-]{16,}/i],
];
export function privacyFindings(value) {
  const strings = [];
  const visit = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  const text = strings.join("\n");
  return [
    ...new Set(
      patterns.filter(([, re]) => re.test(text)).map(([kind]) => kind),
    ),
  ];
}
export function redactPrivateText(value) {
  let text = String(value || "");
  for (const [kind, re] of patterns)
    text = text.replace(
      new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"),
      `[已隐藏:${kind}]`,
    );
  return text;
}
export function safeResult(result, localRoots = []) {
  const rewrite = (value) => {
    if (typeof value === "string") {
      for (const root of localRoots
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)) {
        value = value.split(root).join("[项目]");
        value = value.split(root.replaceAll("\\", "/")).join("[项目]");
      }
      return redactPrivateText(value);
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
      );
    return value;
  };
  return rewrite(result);
}
export function privateFile(path) {
  return (
    path
      .split("/")
      .some((p) =>
        /^(?:\.env(?!\.example$)|\.ssh$|\.aws$|\.codex$|\.island|id_rsa|id_ed25519|credentials|secrets?\.)/i.test(
          p,
        ),
      ) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(path)
  );
}
export function artifactFindings(files) {
  const findings = new Set();
  for (const [path, bytes] of files) {
    if (privateFile(path)) findings.add("private_file");
    if (path === "island-artifact.json") {
      try {
        for (const f of privacyFindings(JSON.parse(bytes.toString())))
          findings.add(f);
      } catch {
        findings.add("invalid_manifest");
      }
      continue;
    }
    // Text source is checked; binaries always require explicit digest-bound consent.
    if (!bytes.includes(0))
      for (const f of privacyFindings(bytes.toString("utf8"))) findings.add(f);
  }
  return [...findings];
}
export function childEnvironment(env = process.env) {
  // Do not forward the bridge's token, model keys or cloud credentials by default.
  const allow = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
  ];
  return Object.fromEntries(
    allow.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
  );
}
export class PrivacyVault {
  constructor(root) {
    this.root = root;
  }
  async key() {
    if (!this.promise)
      this.promise = (async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const file = resolve(this.root, "egress.key");
        try {
          await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 });
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
        if (process.platform !== "win32") {
          await chmod(this.root, 0o700);
          await chmod(file, 0o600);
        }
        const key = await readFile(file);
        if (key.length !== 32)
          throw Error("隐私加密配置损坏，请恢复密钥备份。");
        return key;
      })();
    return this.promise;
  }
  async seal(value, context) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  async open(value, context) {
    const [iv, tag, bytes] = value
      .split(".")
      .map((v) => Buffer.from(v, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", await this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(bytes), cipher.final()]).toString(),
    );
  }
}
