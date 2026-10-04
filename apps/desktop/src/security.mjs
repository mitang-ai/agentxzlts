import { isAbsolute } from "node:path";
export const OFFICIAL_ORIGIN = "https://www.51wanai.com";
// Pairing and executor configuration remain in the invitation/Agent flow,
// not in a privileged desktop form. Only the keeper window owns these actions.
export const ACTIONS = new Set(["status","prepare","guide","refresh","settings","check-update","open-update"]);
export function permittedNavigation(value, origin = OFFICIAL_ORIGIN) {
  try { const u = new URL(value); return u.origin === origin && !u.username && !u.password; } catch { return false; }
}
export function validateIdentityInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("连接参数无效。");
  const keys = new Set(["server","code","adapter","command","args","workspace","name","allowDevelopment","endpoint"]);
  if (Object.keys(raw).some(k => !keys.has(k))) throw Error("不允许的连接参数。");
  const clean = (key, max, required = true) => {
    const v = raw[key];
    if (v == null && !required) return "";
    if (typeof v !== "string" || v.length > max || /[\x00-\x1f]/.test(v) || (required && !v.trim())) throw Error("无效的 " + key + "。");
    return v.trim();
  };
  const adapter = clean("adapter", 20);
  if (!["codex","claude","opencode","cli","acp","http","a2a","mcp"].includes(adapter)) throw Error("请选择受支持的执行方式。");
  const code = clean("code",128);
  if (!/^[a-z0-9-]{4,128}$/i.test(code)) throw Error("配对码格式无效。");
  const workspace = clean("workspace",4096);
  if (!isAbsolute(workspace)) throw Error("工作目录必须为本机绝对路径。");
  const name = clean("name",80), command = clean("command",4096,false);
  if (["cli","acp"].includes(adapter) && !command) throw Error("此执行方式需要选择自己的 Agent 程序。");
  const args = raw.args || [];
  if (!Array.isArray(args) || args.length > 100 || args.some(v => typeof v !== "string" || v.length > 4096 || /[\x00\r\n]/.test(v))) throw Error("程序参数必须为有效的 JSON 字符串数组。");
  if (raw.allowDevelopment !== undefined && typeof raw.allowDevelopment !== "boolean") throw Error("开发授权无效。");
  const endpoint = clean("endpoint",2048,false), server = clean("server",2048,false);
  for (const v of [server,endpoint].filter(Boolean)) {
    const u = new URL(v);
    if (!["http:","https:"].includes(u.protocol) || u.username || u.password || (u.protocol==="http:" && !["localhost","127.0.0.1","[::1]"].includes(u.hostname))) throw Error("服务地址必须是 HTTPS 或本机回环 HTTP。");
  }
  return {code,adapter,workspace,name,command,args:[...args],endpoint,server,allowDevelopment:raw.allowDevelopment===true};
}
export function publicStatus(value = {}) {
  const text = v => typeof v === "string" ? v.slice(0,160).replace(/[\x00-\x1f]/g," ") : "";
  return {
    version:text(value.version),running:value.running===true,connected:value.connected===true,
    pid:Number.isInteger(value.pid)?value.pid:null,state:text(value.state),modelReady:value.model_ready===true,
    adapter:text(value.adapter),host:text(value.host),name:text(value.name),
    node_id:typeof value.node_id==="string"&&/^[a-f0-9-]{36}$/i.test(value.node_id)?value.node_id:null,
    enabled:value.enabled===true
  };
}
