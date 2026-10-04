// Public GitHub metadata only: no website request, credential, download or execution.
const API =
  "https://api.github.com/repos/mitang-ai/agentxzlts/releases?per_page=20";
const RELEASES = "https://github.com/mitang-ai/agentxzlts/releases";
const CACHE_MS = 6 * 60 * 60 * 1000;
const THROTTLE_MS = 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const MAX_BYTES = 512 * 1024;

function versionParts(value) {
  if (
    typeof value !== "string" ||
    value.length > 50 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

class UpdateCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function failure(code, message) {
  return new UpdateCheckError(code, message);
}

function candidate(release) {
  if (
    !release ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== "string"
  )
    return null;
  const tag = release.tag_name;
  if (!tag.startsWith("desktop-v")) return null;
  const version = tag.slice(9),
    parts = versionParts(version);
  if (
    !parts ||
    release.html_url !== `${RELEASES}/tag/${tag}` ||
    !Array.isArray(release.assets)
  )
    return null;
  if (
    typeof release.published_at !== "string" ||
    !Number.isFinite(Date.parse(release.published_at))
  )
    return null;
  const name = `Island-Setup-${version}-x64.exe`;
  const asset = release.assets.find(
    (item) =>
      item &&
      item.name === name &&
      item.state === "uploaded" &&
      Number.isSafeInteger(item.size) &&
      item.size > 0 &&
      item.browser_download_url === `${RELEASES}/download/${tag}/${name}`,
  );
  if (!asset) return null;
  // Navigation only. We do NOT download bytes or assert an installer hash check here.
  return { version, parts, url: `${RELEASES}/tag/${tag}` };
}

async function readJson(response, remaining, signal) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) ||
      !Number.isSafeInteger(Number(declared)) ||
      Number(declared) > remaining)
  ) {
    await response.body?.cancel().catch(() => {});
    throw failure("response-size", "GitHub 发布信息过大，已停止读取。");
  }
  const type = response.headers.get("content-type") || "";
  if (
    !/^(application\/json|application\/vnd\.github\+json)(?:\s*;|$)/i.test(
      type,
    ) ||
    !response.body?.getReader
  ) {
    await response.body?.cancel().catch(() => {});
    throw failure("response-format", "GitHub 未返回有效的发布信息。");
  }
  const reader = response.body.getReader(),
    chunks = [];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted)
        throw failure("timeout", "检查更新超时，请稍后再试。");
      const { done, value } = await reader.read();
      if (signal.aborted)
        throw failure("timeout", "检查更新超时，请稍后再试。");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > remaining)
        throw failure("response-size", "GitHub 发布信息过大，已停止读取。");
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let parsed;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(data),
      );
    } catch {
      throw failure("response-format", "GitHub 未返回有效的发布信息。");
    }
    if (!Array.isArray(parsed) || parsed.length > 20)
      throw failure("response-format", "GitHub 未返回有效的发布列表。");
    return { releases: parsed, bytes };
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Successful result: {status:'available'|'current'|'ahead', currentVersion,
 * latestVersion, url, checkedAt: ISO timestamp, cached:boolean}.
 * Failed first check: status:'error', checkedAt:null, error:{code,message}.
 * Failed refresh: previous successful fields plus stale:true and error.
 * force bypasses the 6h success cache, never the 1min request throttle.
 */
export function createUpdateChecker({
  currentVersion,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const currentParts = versionParts(currentVersion);
  if (!currentParts) throw Error("客户端版本必须是有效的三段版本号。");
  if (typeof fetchImpl !== "function" || typeof now !== "function")
    throw Error("更新检查依赖无效。");
  let success = null,
    successAt = null,
    lastAttemptAt = null,
    lastResult = null,
    inFlight = null;
  const cachedCopy = (value) => ({
    ...value,
    ...(value.error ? { error: { ...value.error } } : {}),
    cached: true,
  });

  async function request() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(failure("timeout", "检查更新超时，请稍后再试。"));
        controller.abort();
      }, TIMEOUT_MS);
    });
    const operation = (async () => {
      let best = null,
        bytes = 0;
      for (let page = 1; page <= 2; page++) {
        if (controller.signal.aborted)
          throw failure("timeout", "检查更新超时，请稍后再试。");
        const url = page === 1 ? API : `${API}&page=2`;
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
          },
        });
        if (response.redirected || (response.url && response.url !== url)) {
          void response.body?.cancel().catch(() => {});
          throw failure("redirect", "GitHub 发布接口地址异常，已停止检查。");
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw failure(
            response.status === 403 || response.status === 429
              ? "rate-limit"
              : "http",
            "暂时无法读取 GitHub 发布信息，请稍后再试。",
          );
        }
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw failure("timeout", "检查更新超时，请稍后再试。");
        }
        const parsed = await readJson(
          response,
          MAX_BYTES - bytes,
          controller.signal,
        );
        bytes += parsed.bytes;
        for (const release of parsed.releases) {
          const item = candidate(release);
          if (item && (!best || compare(item.parts, best.parts) > 0))
            best = item;
        }
        if (parsed.releases.length < 20) break;
      }
      if (!best)
        throw failure(
          "no-release",
          "未找到可用的 Windows 正式版本，请稍后再试。",
        );
      const comparison = compare(best.parts, currentParts);
      return {
        status:
          comparison > 0 ? "available" : comparison < 0 ? "ahead" : "current",
        currentVersion,
        latestVersion: best.version,
        url: best.url,
        checkedAt: new Date(now()).toISOString(),
        cached: false,
      };
    })();
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    check({ force = false } = {}) {
      if (inFlight) return inFlight;
      const timestamp = now();
      if (
        lastAttemptAt !== null &&
        timestamp - lastAttemptAt < THROTTLE_MS &&
        lastResult
      )
        return Promise.resolve(cachedCopy(lastResult));
      if (!force && success && timestamp - successAt < CACHE_MS)
        return Promise.resolve(
          cachedCopy(lastResult?.stale ? lastResult : success),
        );
      lastAttemptAt = timestamp;
      inFlight = (async () => {
        try {
          success = await request();
          successAt = now();
          lastResult = success;
        } catch (error) {
          const knownError = error instanceof UpdateCheckError;
          const publicError = {
            code: knownError ? error.code : "network",
            message: knownError
              ? error.message
              : "无法连接 GitHub 检查更新，请检查网络后重试。",
          };
          lastResult = success
            ? { ...success, stale: true, error: publicError, cached: true }
            : {
                status: "error",
                currentVersion,
                checkedAt: null,
                cached: false,
                error: publicError,
              };
        } finally {
          inFlight = null;
        }
        return {
          ...lastResult,
          ...(lastResult.error ? { error: { ...lastResult.error } } : {}),
        };
      })();
      return inFlight;
    },
  };
}
