import { AgentError } from "./protocol.mjs";
import yauzl from "yauzl";
import yazl from "yazl";
import { createHash } from "node:crypto";
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const ARCHIVE_LIMIT = 100 * 1024 * 1024;
export function safePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f:]/.test(path) ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.toLowerCase() === ".git" ||
          /[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new AgentError(
      400,
      "归档路径无效：禁止绝对路径、目录穿越和 Git 内部目录。",
    );
  return path;
}
export function inScope(path, scopes) {
  safePath(path);
  return scopes.some(
    (scope) =>
      scope === "*" ||
      path === scope.replace(/\/$/, "") ||
      path.startsWith(scope.replace(/\/$/, "") + "/"),
  );
}
export async function readArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 30 * 1024 * 1024)
    throw new AgentError(400, "源码归档压缩包不能超过 30MB。");
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(new AgentError(400, "ZIP 文件无法读取。"));
        const files = new Map();
        let total = 0,
          count = 0,
          done = false;
        const fail = (e) => {
          if (done) return;
          done = true;
          zip.close();
          reject(e);
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (!done) {
            done = true;
            resolve(files);
          }
        });
        zip.on("entry", (entry) => {
          try {
            if (++count > 5000 || entry.generalPurposeBitFlag & 1)
              throw new AgentError(400, "ZIP 条目过多或包含加密内容。");
            if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
              throw new AgentError(400, "源码归档不能包含符号链接。");
            if (entry.fileName.endsWith("/")) {
              safePath(entry.fileName.slice(0, -1));
              zip.readEntry();
              return;
            }
            const path = safePath(entry.fileName);
            if (
              files.has(path) ||
              entry.uncompressedSize > 10 * 1024 * 1024 ||
              total + entry.uncompressedSize > ARCHIVE_LIMIT
            )
              throw new AgentError(400, "ZIP 重复路径或展开大小超出限制。");
            total += entry.uncompressedSize;
            zip.openReadStream(entry, (e, stream) => {
              if (e) return fail(e);
              const chunks = [];
              let size = 0;
              stream.on("data", (chunk) => {
                size += chunk.length;
                if (size > entry.uncompressedSize || size > 10 * 1024 * 1024) {
                  stream.destroy();
                  fail(Error("ZIP 实际展开大小超出限制。"));
                } else chunks.push(chunk);
              });
              stream.on("error", fail);
              stream.on("end", () => {
                if (done) return;
                files.set(path, Buffer.concat(chunks));
                zip.readEntry();
              });
            });
          } catch (e) {
            fail(e);
          }
        });
        zip.readEntry();
      },
    ),
  );
}
export function writeArchive(files) {
  const zip = new yazl.ZipFile();
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    zip.addBuffer(bytes, safePath(path), {
      mtime: new Date("2026-01-01T00:00:00Z"),
      mode: 0o100644,
    });
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    zip.outputStream.on("data", (b) => {
      size += b.length;
      if (size > 30 * 1024 * 1024) {
        zip.outputStream.destroy();
        reject(new AgentError(400, "生成的源码包超过 30MB。"));
      } else chunks.push(b);
    });
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
export const treeHash = (files) =>
  digest(
    JSON.stringify(
      [...files]
        .map(([path, bytes]) => [path, digest(bytes)])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
export async function packArtifact(base, current, metadata, scopes) {
  const changes = [],
    payload = new Map();
  for (const path of new Set([...base.keys(), ...current.keys()])) {
    const previous = base.get(path),
      next = current.get(path);
    if (
      (previous && next && digest(previous) === digest(next)) ||
      (!previous && !next)
    )
      continue;
    if (!inScope(path, scopes))
      throw new AgentError(400, "成果修改超出已确认分工范围：" + path);
    changes.push({
      path,
      base_sha256: previous ? digest(previous) : null,
      sha256: next ? digest(next) : null,
    });
    if (next) payload.set("files/" + path, next);
  }
  if (changes.length > 500)
    throw new AgentError(400, "单个成果的变更文件不能超过 500 项。");
  payload.set(
    "island-artifact.json",
    Buffer.from(
      JSON.stringify({
        version: 1,
        ...metadata,
        base_hash: treeHash(base),
        changes,
      }),
    ),
  );
  return writeArchive(payload);
}
export async function unpackArtifact(bytes, base, metadata, scopes) {
  const files = await readArchive(bytes),
    raw = files.get("island-artifact.json");
  if (!raw || raw.length > 256 * 1024)
    throw new AgentError(400, "成果缺少有效清单。");
  let manifest;
  try {
    manifest = JSON.parse(raw.toString());
  } catch {
    throw new AgentError(400, "成果清单格式无效。");
  }
  if (
    manifest.version !== 1 ||
    manifest.base_hash !== treeHash(base) ||
    manifest.brief_hash !== metadata.brief_hash ||
    manifest.task_id !== metadata.task_id ||
    !Array.isArray(manifest.changes) ||
    manifest.changes.length > 500
  )
    throw new AgentError(400, "成果与任务、需求版本或代码基线不一致。");
  const seen = new Set();
  for (const c of manifest.changes) {
    if (!inScope(c.path, scopes) || seen.has(c.path))
      throw new AgentError(400, "成果超出分工范围或包含重复路径。");
    seen.add(c.path);
    const original = base.get(c.path),
      content = files.get("files/" + c.path);
    if (
      c.base_sha256 !== (original ? digest(original) : null) ||
      c.sha256 !== (content ? digest(content) : null) ||
      (c.sha256 === null && content) ||
      (c.sha256 === null && !original)
    )
      throw new AgentError(400, "成果文件内容或基线摘要不一致。");
  }
  if (
    [...files.keys()].some(
      (p) =>
        p !== "island-artifact.json" &&
        (!p.startsWith("files/") || !seen.has(p.slice(6))),
    )
  )
    throw new AgentError(400, "成果存在未声明文件。");
  return { manifest, files };
}
export function mergeArtifacts(base, artifacts, resolutions = {}) {
  const result = new Map(base),
    candidates = new Map(),
    conflicts = [];
  for (const a of artifacts)
    for (const c of a.manifest.changes) {
      if (!candidates.has(c.path)) candidates.set(c.path, []);
      candidates.get(c.path).push({
        artifact_id: a.id,
        sha256: c.sha256,
        bytes: a.files.get("files/" + c.path),
      });
    }
  for (const [path, versions] of candidates) {
    const distinct = new Set(versions.map((v) => v.sha256)),
      choice = resolutions[path];
    let picked = versions[0];
    if (distinct.size > 1) {
      if (choice === "baseline") continue;
      picked = versions.find((v) => v.artifact_id === choice);
      if (!picked) {
        conflicts.push({
          path,
          versions: versions.map(({ artifact_id, sha256 }) => ({
            artifact_id,
            sha256,
          })),
        });
        continue;
      }
    }
    if (picked.sha256 === null) result.delete(path);
    else result.set(path, picked.bytes);
  }
  for (const path of Object.keys(resolutions))
    if (!candidates.has(path))
      throw new AgentError(400, "合并决策包含未知路径。");
  return { files: result, conflicts, hash: treeHash(result) };
}
