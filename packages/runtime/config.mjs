import { readFileSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { parseEnv } from "node:util";
export const keys = [
  "DATABASE_URL",
  "APP_ORIGIN",
  "STORAGE_DIR",
  "PORT",
  "ISLAND_BIND_HOST",
  "PG_PORT",
  "PG_DATA_DIR",
  "PG_USER",
  "PG_PASSWORD",
  "TRUST_PROXY",
  "BACKUP_STATUS_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
export function repositoryRoot(cwd = process.cwd()) {
  return resolve(
    process.env.ISLAND_ROOT ||
      (basename(cwd) === "web" && basename(dirname(cwd)) === "apps"
        ? resolve(cwd, "../..")
        : cwd),
  );
}
export function configPath(root = repositoryRoot()) {
  return resolve(
    /* turbopackIgnore: true */ process.env.ISLAND_CONFIG_FILE ||
      resolve(root, ".data/installation/config.json"),
  );
}
export function readSavedConfig(root = repositoryRoot()) {
  const file = configPath(root);
  if (!existsSync(/* turbopackIgnore: true */ file)) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8"));
  } catch {
    throw new Error("安装配置无法读取，请检查权限或恢复配置备份。");
  }
  if (
    config.version !== 1 ||
    !config.env ||
    !["embedded", "external"].includes(config.mode)
  )
    throw new Error("安装配置格式无效，请恢复配置备份。");
  if (
    !config.installationId ||
    !config.env.DATABASE_URL ||
    !config.env.APP_ORIGIN ||
    !config.env.STORAGE_DIR
  )
    throw new Error("安装配置不完整，请恢复配置备份。");
  return config;
}
export function fileEnvironment(root = repositoryRoot()) {
  const result = {};
  // Next environment filenames first; workspace local settings override root legacy files.
  for (const file of [
    ".env",
    ".env.local",
    "apps/web/.env",
    "apps/web/.env.local",
  ]) {
    const path = resolve(root, file);
    if (existsSync(/* turbopackIgnore: true */ path))
      Object.assign(
        result,
        parseEnv(readFileSync(/* turbopackIgnore: true */ path, "utf8")),
      );
  }
  const expanded = {},
    visiting = new Set();
  const valueFor = (key) => {
    if (key in expanded) return expanded[key];
    if (visiting.has(key))
      throw new Error("环境文件存在循环变量引用，请检查配置。");
    visiting.add(key);
    const value = String(result[key] ?? "").replace(
      /(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
      (match, escaped, a, b) => {
        if (escaped) return match.slice(1);
        const name = a || b;
        return process.env[name] ?? (name in result ? valueFor(name) : "");
      },
    );
    visiting.delete(key);
    expanded[key] = value;
    return value;
  };
  for (const key of Object.keys(result)) valueFor(key);
  return expanded;
}
export function loadRuntimeConfig(root = repositoryRoot()) {
  const saved = readSavedConfig(root),
    local = fileEnvironment(root),
    env = {};
  for (const key of keys) {
    const overrides = (process.env.ISLAND_ENV_OVERRIDES || "").split(",");
    const value = saved
      ? overrides.includes(key)
        ? (process.env[key] ?? saved.env[key])
        : (saved.env[key] ?? local[key])
      : (process.env[key] ?? local[key]);
    if (value !== undefined) env[key] = String(value);
  }
  if (
    saved &&
    ["DATABASE_URL", "APP_ORIGIN", "STORAGE_DIR"].some((k) => !env[k])
  )
    throw new Error("必需的运行配置被覆盖为空，请修正显式覆盖。");
  const configuredDatabase = Boolean(env.DATABASE_URL);
  env.DATABASE_URL ||=
    "postgresql://island:local-development-only@127.0.0.1:55432/postgres";
  env.APP_ORIGIN ||= "http://localhost:3000";
  env.STORAGE_DIR = env.STORAGE_DIR
    ? resolve(root, "apps/web", env.STORAGE_DIR)
    : resolve(root, ".data/files");
  env.PORT ||= "3000";
  env.ISLAND_BIND_HOST ||= "0.0.0.0";
  env.PG_PORT ||= "55432";
  env.PG_DATA_DIR = resolve(root, env.PG_DATA_DIR || ".data/postgres");
  env.PG_USER ||= "island";
  env.PG_PASSWORD ||= "local-development-only";
  return {
    root,
    env,
    saved,
    mode: saved?.mode || (configuredDatabase ? "external" : "embedded"),
  };
}
export function applyRuntimeConfig(root = repositoryRoot()) {
  const config = loadRuntimeConfig(root);
  for (const [key, value] of Object.entries(config.env))
    process.env[key] = value;
  return config;
}
