"use strict";
const $ = (id) => document.getElementById(id),
  screen = $("screen"),
  notice = $("notice"),
  next = $("next"),
  back = $("back");
const token =
  location.hash.slice(1) || sessionStorage.getItem("island-setup-token");
if (location.hash) {
  sessionStorage.setItem("island-setup-token", token);
  history.replaceState(null, "", location.pathname);
}
let detected,
  step = 0,
  checking = false,
  pollTimer = null,
  dbResult = null,
  verifiedCandidate = null;
let form = {
  mode: "embedded",
  operation: "install",
  siteName: "协作岛",
  port: 3000,
  origin: "http://localhost:3000",
  bindHost: "127.0.0.1",
  storage: "",
  pgPort: 55432,
  pgData: "",
  dbChoice: "manual",
  host: "127.0.0.1",
  dbPort: 5432,
  database: "island",
  user: "",
  dbPassword: "",
  dbURL: "",
  tls: "disable",
  createName: "",
  createDatabase: false,
  nickname: "管理员",
  email: "",
  password: "",
  passwordAgain: "",
  updateBrand: false,
  autoStart: false,
  verifyPublic: false,
  confirmed: false,
};
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function showError(message) {
  notice.hidden = !message;
  notice.textContent = message || "";
}
async function request(path, body) {
  const r = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "操作失败");
  return data;
}
function field(id, label, value, type = "text", help = "") {
  return `<label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value)}" ${type === "password" ? 'autocomplete="new-password"' : ""}>${help ? "<small>" + help + "</small>" : ""}`;
}
function capture() {
  for (const [key, id] of Object.entries({
    port: "port",
    origin: "origin",
    bindHost: "bindHost",
    storage: "storage",
    pgPort: "pgPort",
    pgData: "pgData",
    dbChoice: "dbChoice",
    host: "host",
    dbPort: "dbPort",
    database: "database",
    user: "user",
    dbPassword: "dbPassword",
    dbURL: "dbURL",
    tls: "tls",
    createName: "createName",
    siteName: "siteName",
    nickname: "nickname",
    email: "email",
    password: "password",
    passwordAgain: "passwordAgain",
  })) {
    if ($(id)) form[key] = $(id).value;
  }
  for (const key of [
    "createDatabase",
    "updateBrand",
    "autoStart",
    "verifyPublic",
    "confirmed",
  ])
    if ($(key)) form[key] = $(key).checked;
}
function databaseInput() {
  return {
    ...(form.dbChoice !== "manual"
      ? { candidate: form.dbChoice }
      : verifiedCandidate
        ? { candidate: verifiedCandidate }
        : {}),
    url: form.dbChoice === "manual" ? form.dbURL : "",
    host: form.host,
    port: Number(form.dbPort),
    database: form.database,
    user: form.user,
    password: form.dbPassword,
    tls: form.tls,
    createName: form.createDatabase ? form.createName : "",
  };
}
function render() {
  showError("");
  $("step-label").textContent = [
    "检查安装条件",
    "配置数据库与文件",
    "设置网站与管理员",
    "核对安装配置",
    "安装进度",
  ][step];
  document.querySelectorAll("#steps li").forEach((li, i) => {
    li.className = i === step ? "active" : i < step ? "done" : "";
  });
  back.hidden = step === 0 || step === 4;
  next.disabled = false;
  next.hidden = false;
  next.textContent = step === 3 ? "开始安装" : "下一步";
  if (step === 0) {
    screen.innerHTML = `<h1>${detected.installed ? "管理现有安装" : "欢迎安装协作岛"}</h1><p>检测运行环境和本机 PostgreSQL，安装前验证实际连接。</p><div class="card">${detected.checks.map((c) => `<div class="check"><span class="${c.status}">${c.status === "pass" ? "✓" : c.status === "warning" ? "!" : "×"}</span><strong>${esc(c.name)}</strong><span class="detail">${esc(c.detail)}</span></div>`).join("")}</div>${detected.overrides.length ? '<div class="info">检测到环境配置：' + esc(detected.overrides.join("、")) + "。保存后的统一配置将供网站和所有启动工具读取；显式覆盖需单独设置。</div>" : ""}<div class="actions"><button id="redetect" class="secondary">重新检测</button>${!detected.dependencies ? '<button id="prepare">自动准备项目依赖</button>' : ""}</div>${detected.installed ? '<div class="info">已保存安装配置，将使用升级流程，保留原有账号、聊天、附件和管理员。升级前请停止已运行的网站。</div>' : ""}`;
    next.disabled = detected.checks.some((c) => c.status === "blocked");
    $("redetect").onclick = initialize;
    if ($("prepare"))
      $("prepare").onclick = async () => {
        try {
          $("prepare").disabled = true;
          showError("正在下载并校验锁定依赖，请保持安装器运行。");
          await request("prepare", {});
          form.storage = "";
          await initialize();
        } catch (e) {
          showError(e.message);
          $("prepare").disabled = false;
        }
      };
  }
  if (step === 1) {
    screen.innerHTML = `<h1>数据库与私有文件</h1><p>所选连接用于聊天、后台、迁移和实时通知。地址与凭据只保存在服务器。</p><div class="mode"><button id="embedded" class="secondary ${form.mode === "embedded" ? "selected" : ""}" ${!detected.embeddedSupported ? "disabled" : ""}>内置 PostgreSQL<br><small>自动配置独立本机数据库</small></button><button id="external" class="secondary ${form.mode === "external" ? "selected" : ""}">已有 PostgreSQL<br><small>自动识别或手动填写连接</small></button></div><div class="card">${form.mode === "embedded" ? field("pgPort", "数据库端口", form.pgPort, "number") + field("pgData", "数据库数据目录", form.pgData, "text", "保存现有目录时会复用数据，不执行重置。") : `<label for="dbChoice">发现的数据库</label><select id="dbChoice"><option value="manual">手动填写连接</option>${detected.candidates.map((c, i) => `<option value="${esc(c.id || "local-" + i)}">${esc(c.source + " · " + c.host + ":" + c.port + (c.database ? " / " + c.database : ""))}${c.verified ? " · 已验证" : c.passwordConfigured ? " · 已配置凭据" : " · 需要填写凭据"}</option>`).join("")}</select>${field("dbURL", "连接字符串（可选）", form.dbURL, "password", "可粘贴 PostgreSQL 连接地址；填写后优先使用连接字符串。")}<div class="grid"><div>${field("host", "数据库主机 / Socket 目录", form.host)}${field("database", "数据库名称", form.database)}${field("user", "数据库账号", form.user)}</div><div>${field("dbPort", "数据库端口", form.dbPort, "number")}${field("dbPassword", "数据库密码", form.dbPassword, "password")}<label for="tls">数据库 TLS</label><select id="tls"><option value="disable">本机连接（不使用 TLS）</option><option value="verify-full">TLS 并验证证书与主机名</option></select></div></div>${form.operation !== "upgrade" ? '<label><input type="checkbox" id="createDatabase">自动创建专用数据库</label><div id="create-box" hidden>' + field("createName", "新数据库名称", form.createName, "text", "上方填写可连接的维护库，例如 postgres；账号需要 CREATEDB 权限。") + "</div>" : ""}<button id="check-db" class="secondary">测试连接与安装权限</button><div id="db-result"></div>`}</div><div class="card"><h2>文件存储</h2>${field("storage", "私有文件目录", form.storage, "text", "统一使用绝对路径，聊天上传、下载和后台维护读取同一位置。升级保留已有外部存储适配器。")}</div>`;
    for (const mode of ["embedded", "external"])
      $(mode).onclick = () => {
        capture();
        form.mode = mode;
        dbResult = null;
        verifiedCandidate = null;
        render();
      };
    if (form.mode === "external") {
      if (form.dbChoice.startsWith("local-")) form.dbChoice = "manual";
      $("dbChoice").value = form.dbChoice;
      $("tls").value = form.tls;
      const applyChoice = () => {
        capture();
        const c = detected.candidates.find((c) => c.id === form.dbChoice);
        for (const key of [
          "host",
          "dbPort",
          "database",
          "user",
          "dbPassword",
          "dbURL",
          "tls",
        ])
          $(key).disabled = Boolean(c);
        if (c) {
          $("host").value = c.host;
          $("dbPort").value = c.port;
          $("database").value = c.database;
          $("user").value = c.user;
          if (!Array.from($("tls").options).some((o) => o.value === c.tls))
            $("tls").add(new Option("使用已配置的 TLS 模式：" + c.tls, c.tls));
          $("tls").value = c.tls;
          $("dbPassword").placeholder = c.passwordConfigured
            ? "使用已保存的凭据"
            : "";
        }
        displayDB();
      };
      $("dbChoice").onchange = () => {
        const value = $("dbChoice").value;
        const index = value.startsWith("local-")
          ? Number(value.slice(6))
          : null;
        if (index !== null) {
          const c = detected.candidates[index];
          form.host = c.host;
          form.dbPort = c.port;
          form.user = c.user;
          form.dbChoice = "manual";
          form.dbPassword = "";
          dbResult = null;
          verifiedCandidate = null;
          render();
          return;
        }
        form.dbChoice = value;
        dbResult = null;
        verifiedCandidate = null;
        applyChoice();
      };
      if ($("createDatabase")) {
        $("createDatabase").checked = form.createDatabase;
        $("create-box").hidden = !form.createDatabase;
        $("createDatabase").onchange = () => {
          capture();
          $("create-box").hidden = !form.createDatabase;
          dbResult = null;
          verifiedCandidate = null;
          displayDB();
        };
      }
      for (const key of [
        "host",
        "dbPort",
        "database",
        "user",
        "dbPassword",
        "dbURL",
        "tls",
        "createName",
      ])
        $(key)?.addEventListener("input", () => {
          dbResult = null;
          verifiedCandidate = null;
          displayDB();
        });
      $("check-db").onclick = checkDatabase;
      applyChoice();
    }
  }
  if (step === 2) {
    const preserve = dbResult?.admins > 0 || detected.installed;
    screen.innerHTML = `<h1>网站与管理员</h1><p>配置访问来源和运行端口，前后台将同步使用。</p><div class="grid"><div class="card"><h2>网站设置</h2>${field("siteName", "网站名称", form.siteName)}${field("port", "网站监听端口", form.port, "number")}${field("origin", "浏览器访问地址", form.origin, "url", "本机可用 HTTP；公开部署填写 HTTPS 域名并准备反向代理，安装后自动验证公开地址。")}<label for="bindHost">监听范围</label><select id="bindHost"><option value="127.0.0.1">仅本机</option><option value="0.0.0.0">所有网卡（服务器部署）</option></select>${preserve ? '<label><input id="updateBrand" type="checkbox">同时更新已有网站名称和标题</label>' : ""}<label><input id="verifyPublic" type="checkbox">安装后验证公开访问地址</label><label><input id="autoStart" type="checkbox">登录操作系统后自动启动（可选）</label><small>自动启动需要当前用户的服务管理权限，安装时会实际检查。</small></div><div class="card"><h2>${preserve ? "保留原管理员" : "首位超级管理员"}</h2>${preserve ? '<div class="info">已有安装／管理员时，不重复创建账号、不重置密码。网站和后台继续使用原账号登录。</div>' : `${field("nickname", "管理员昵称", form.nickname)}${field("email", "管理员账号（邮箱）", form.email, "email")}<label for="password">管理员密码</label><div class="password-row"><input id="password" type="password" value="${esc(form.password)}" autocomplete="new-password"><button id="generate" class="secondary">生成密码</button></div><small>新账号 12–128 位；已有邮箱使用原密码（至少 8 位）完成授权。</small>${field("passwordAgain", "确认密码", form.passwordAgain, "password")}<label><input id="show-password" type="checkbox">显示密码</label>`}</div></div>`;
    $("bindHost").value = form.bindHost;
    let previousPort = $("port").value;
    $("port").addEventListener("input", () => {
      try {
        const u = new URL($("origin").value);
        if (
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
          Number(u.port || (u.protocol === "https:" ? 443 : 80)) ===
            Number(previousPort)
        ) {
          u.port = $("port").value;
          $("origin").value = u.origin;
        }
      } catch {}
      previousPort = $("port").value;
    });
    for (const key of ["updateBrand", "autoStart", "verifyPublic"])
      if ($(key)) $(key).checked = form[key];
    if ($("generate")) {
      $("generate").onclick = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        const alphabet =
          "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@_-";
        const password = Array.from(
          bytes,
          (b) => alphabet[b % alphabet.length],
        ).join("");
        $("password").value = password;
        $("passwordAgain").value = password;
        showError("已生成密码，请保存到你的密码管理器。");
      };
      $("show-password").onchange = () => {
        for (const id of ["password", "passwordAgain"])
          $(id).type = $("show-password").checked ? "text" : "password";
      };
    }
    if (!preserve) $("email").autocomplete = "username";
  }
  if (step === 3) {
    let c = detected.candidates.find((c) => c.id === form.dbChoice);
    if (!c && form.dbURL) {
      const u = new URL(form.dbURL);
      c = {
        host: u.searchParams.get("host") || u.hostname,
        port: Number(u.port || 5432),
        database: dbResult?.database || decodeURIComponent(u.pathname.slice(1)),
      };
    }
    screen.innerHTML = `<h1>确认安装配置</h1><p>${form.operation === "upgrade" ? "升级保留已有账号、管理员、聊天和文件。" : "管理员账号由你配置，不使用默认密码。"}</p><div class="card"><dl class="summary"><dt>安装方式</dt><dd>${form.operation === "upgrade" ? "保留数据升级" : "安装网站"}</dd><dt>数据库</dt><dd>${form.mode === "embedded" ? "内置 PostgreSQL · 127.0.0.1:" + esc(form.pgPort) : esc((c?.host || form.host) + ":" + (c?.port || form.dbPort) + " / " + (form.createDatabase ? form.createName : c?.database || form.database))}</dd><dt>网站名称</dt><dd>${esc(form.siteName)}</dd><dt>访问地址</dt><dd>${esc(form.origin)}</dd><dt>监听端口</dt><dd>${esc(form.port)}</dd><dt>私有文件目录</dt><dd>${esc(form.storage)}</dd><dt>管理员</dt><dd>${dbResult?.admins > 0 || detected.installed ? "保留原账号" : esc(form.email)}</dd><dt>密码保存</dt><dd>管理员密码只保存加密结果；数据库凭据保存在受保护配置文件</dd><dt>自动启动</dt><dd>${form.autoStart ? "登录系统后自动启动" : "使用启动文件或 npm run island:start"}</dd></dl><label><input type="checkbox" id="confirmed">确认配置正确；已有网站已完成数据库和文件备份</label></div>`;
    $("confirmed").checked = form.confirmed;
    next.disabled = !form.confirmed;
    $("confirmed").onchange = () => {
      form.confirmed = $("confirmed").checked;
      next.disabled = !form.confirmed;
    };
  }
  if (step === 4) {
    next.hidden = true;
    back.hidden = true;
    screen.innerHTML =
      '<h1>正在安装协作岛</h1><p>请保持安装器运行。关闭浏览器不会中断服务器上的安装进程。</p><div class="card"><div class="status-heading"><h2 id="stage">准备安装</h2><span id="percent">0%</span></div><progress id="progress" max="100" value="0"></progress><div id="logs" class="logs" role="log" aria-label="安装日志"></div><div id="outcome"></div></div>';
  }
}
function displayDB() {
  if (!$("db-result")) return;
  $("db-result").className = dbResult ? "result" : "";
  $("db-result").textContent = dbResult
    ? `连接与权限验证通过 · PostgreSQL ${Math.floor(dbResult.version / 10000)} · ${dbResult.isIsland ? "已有协作岛，" + dbResult.users + " 个用户、" + dbResult.admins + " 位管理员" : "空的专用数据库"} · 实时通知正常`
    : "";
}
async function checkDatabase() {
  capture();
  checking = true;
  $("check-db").disabled = true;
  showError("");
  try {
    const result = await request("check-db", databaseInput());
    dbResult = result;
    verifiedCandidate = result.candidate;
    displayDB();
  } catch (e) {
    showError(e.message);
  } finally {
    checking = false;
    $("check-db").disabled = false;
  }
}
async function initialize() {
  try {
    next.disabled = true;
    showError("");
    detected = await request("detect");
    if (!form.storage) {
      Object.assign(form, {
        ...detected.defaults,
        origin:
          detected.defaults.origin ||
          "http://localhost:" + detected.defaults.port,
        operation: detected.installed ? "upgrade" : "install",
      });
      const usable = detected.candidates.filter((c) => c.verified);
      const configured =
        usable.find((c) => c.source === "已保存的安装配置") ||
        (usable.length === 1 ? usable[0] : null);
      if (configured) {
        form.dbChoice = configured.id;
        dbResult = configured.inspection;
      }
    }
    if (detected.state?.status === "running") {
      step = 4;
      render();
      poll();
    } else {
      render();
    }
  } catch (e) {
    showError(e.message);
    screen.innerHTML =
      "<h1>安装环境需要处理</h1><p>请修复上方问题，再重新运行安装启动文件。</p>";
    next.textContent = "重新检测";
    next.disabled = false;
    next.onclick = initialize;
  }
}
next.onclick = async () => {
  capture();
  showError("");
  try {
    if (step === 1 && form.mode === "external") {
      if (checking) throw Error("请等待连接测试完成。");
      if (!dbResult) throw Error("请先测试数据库连接与安装权限。");
    }
    if (step === 2) {
      const port = Number(form.port),
        origin = new URL(form.origin);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw Error("网站端口须为 1024–65535。");
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw Error("请填写不带路径的完整网站访问地址。");
      if (form.bindHost === "0.0.0.0" && origin.protocol !== "https:")
        throw Error("公开部署请填写 HTTPS 地址并配置反向代理。");
      if (!form.siteName.trim() || form.siteName.trim().length > 60)
        throw Error("请填写 1–60 个字符的网站名称。");
      if (!(dbResult?.admins > 0 || detected.installed)) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
          throw Error("请填写有效管理员邮箱。");
        if (
          form.password.length < (dbResult?.users > 0 ? 8 : 12) ||
          form.password.length > 128
        )
          throw Error(
            "新管理员密码须为 12–128 位；已有账号请使用原密码（至少 8 位）。",
          );
        if (form.password !== form.passwordAgain)
          throw Error("两次输入的密码不同。");
      }
    }
    if (step === 3) {
      if (!form.confirmed) throw Error("请确认安装配置。");
      const data = {
        ...form,
        database: databaseInput(),
        admin:
          dbResult?.admins > 0 || detected.installed
            ? null
            : {
                nickname: form.nickname,
                email: form.email,
                password: form.password,
              },
      };
      next.disabled = true;
      await request("install", data);
      step = 4;
      render();
      poll();
      return;
    }
    step++;
    render();
  } catch (e) {
    showError(e.message);
    next.disabled = false;
  }
};
back.onclick = () => {
  capture();
  step--;
  render();
};
async function poll() {
  clearTimeout(pollTimer);
  try {
    const { state } = await request("status");
    if (state) {
      $("stage").textContent = state.stage;
      $("percent").textContent = state.progress + "%";
      $("progress").value = state.progress;
      $("logs").textContent = (state.logs || [])
        .map((l) => l.message)
        .join("\n");
      $("logs").scrollTop = $("logs").scrollHeight;
      if (state.status === "complete") {
        screen.querySelector("h1").textContent =
          state.operation === "upgrade" ? "升级完成" : "安装完成";
        $("outcome").innerHTML =
          `<div class="result"><span class="success-icon">✓</span><br>数据库、配置与网站服务验证通过。安装窗口关闭后网站继续运行。</div><div class="actions"><a href="${esc(state.origin)}" target="_blank" rel="noreferrer">打开网站</a><a class="secondary" href="${esc(state.adminURL)}" target="_blank" rel="noreferrer">进入管理后台</a></div><div class="info">后续运行：<code>npm run island:start</code><br>停止：<code>npm run island:stop</code><br>状态：<code>npm run island:status</code><br>请保存管理员账号与密码，并备份数据库、文件和安装配置。</div>`;
        form.password = "";
        form.passwordAgain = "";
        form.dbPassword = "";
        sessionStorage.removeItem("island-setup-token");
        return;
      }
      if (state.status === "failed") {
        $("outcome").innerHTML =
          `<div class="error">${esc(state.error)}</div><button id="retry" class="secondary">修改配置并重试</button>`;
        $("retry").onclick = async () => {
          try {
            detected = await request("detect");
            dbResult = null;
            verifiedCandidate = null;
            if (detected.installed) {
              form.operation = "upgrade";
              form.createDatabase = false;
              form.mode = detected.defaults.mode;
              const c = detected.candidates.find(
                (c) => c.source === "已保存的安装配置" && c.verified,
              );
              if (c) {
                form.dbChoice = c.id;
                dbResult = c.inspection;
              }
            }
            step = 1;
            render();
          } catch (e) {
            showError(e.message);
          }
        };
        return;
      }
    }
  } catch (e) {
    showError(e.message);
  }
  pollTimer = setTimeout(poll, 800);
}
initialize();
