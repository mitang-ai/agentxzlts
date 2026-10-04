import { afterEach, expect, it, vi } from "vitest";
// @ts-ignore Executable desktop module.
import { createUpdateChecker } from "../apps/desktop/src/updates.mjs";

const api =
  "https://api.github.com/repos/mitang-ai/agentxzlts/releases?per_page=20";
const prefix = "https://github.com/mitang-ai/agentxzlts/releases";
const hour = 3600_000;
function release(version = "0.4.1", extra: Record<string, any> = {}) {
  const tag = `desktop-v${version}`,
    name = `Island-Setup-${version}-x64.exe`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `${prefix}/tag/${tag}`,
    published_at: "2026-10-04T06:00:00Z",
    assets: [
      {
        name,
        state: "uploaded",
        size: 12345,
        browser_download_url: `${prefix}/download/${tag}/${name}`,
      },
    ],
    ...extra,
  };
}
const json = (value: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
function fixture(items: unknown[] = [release()], currentVersion = "0.4.0") {
  let time = Date.parse("2026-10-04T07:00:00Z");
  const fetchImpl = vi.fn(async () => json(items));
  return {
    fetchImpl,
    checker: createUpdateChecker({
      currentVersion,
      fetchImpl,
      now: () => time,
    }),
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}
afterEach(() => vi.useRealTimers());

it("only requests public fixed GitHub API and returns validated release-page navigation", async () => {
  const { checker, fetchImpl } = fixture();
  expect(await checker.check()).toEqual({
    status: "available",
    currentVersion: "0.4.0",
    latestVersion: "0.4.1",
    url: `${prefix}/tag/desktop-v0.4.1`,
    checkedAt: "2026-10-04T07:00:00.000Z",
    cached: false,
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const [url, options] = fetchImpl.mock.calls[0] as any;
  expect(url).toBe(api);
  expect(options).toMatchObject({
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  expect(options.headers.Authorization).toBeUndefined();
  expect(options.headers.Cookie).toBeUndefined();
  expect(options.signal).toBeInstanceOf(AbortSignal);
});

it.each([
  ["0.4.0", "current"],
  ["0.3.9", "ahead"],
  ["0.10.0", "available"],
])("compares strict numeric version %s as %s", async (version, status) => {
  expect(await fixture([release(version)]).checker.check()).toMatchObject({
    status,
    latestVersion: version,
  });
});

it("ignores web releases, drafts, prereleases, malformed versions and installers that cannot be used", async () => {
  const invalid = [
    release("0.9.0", { draft: true }),
    release("0.8.0", { prerelease: true }),
    release("0.7.0", { tag_name: "v0.7.0" }),
    release("01.0.0"),
    release("1.0.0-beta.1"),
    release("1.0.0+build"),
    release("9007199254740992.0.0"),
    release("1.0.0", { assets: [] }),
    release("0.7.0", { html_url: "https://evil.example/release" }),
    release("0.7.0", {
      html_url: `${prefix}/tag/desktop-v0.7.0?redirect=evil`,
    }),
    release("0.7.0", {
      assets: [{ ...release("0.7.0").assets[0], state: "new" }],
    }),
    release("0.7.0", { assets: [{ ...release("0.7.0").assets[0], size: 0 }] }),
    release("0.7.0", {
      assets: [
        {
          ...release("0.7.0").assets[0],
          browser_download_url: "https://github.com.evil.example/asset.exe",
        },
      ],
    }),
    release("0.7.0", {
      assets: [
        { ...release("0.7.0").assets[0], name: "Island-Setup-0.7.0-arm64.exe" },
      ],
    }),
    release("0.7.0", {
      assets: [
        { ...release("0.7.0").assets[0], name: "Island-Setup-0.6.0-x64.exe" },
      ],
    }),
    release("0.7.0", { published_at: null }),
  ];
  expect(
    await fixture([
      ...invalid,
      release("0.4.1"),
      release("0.4.2"),
    ]).checker.check(),
  ).toMatchObject({ latestVersion: "0.4.2", status: "available" });
});

it.each([
  "01.4.0",
  "0.4",
  "0.4.0-dev",
  "9007199254740992.1.1",
  "-1.2.3",
  "1.2.3 ",
])("rejects invalid client version %s before any request", (version) => {
  expect(() => fixture([], version)).toThrow("三段版本号");
});

it("examines at most two fixed pages and selects highest valid desktop version, not published order", async () => {
  const f = fixture();
  f.fetchImpl
    .mockImplementationOnce(async () =>
      json(Array.from({ length: 20 }, (_, i) => release(`0.4.${i}`))),
    )
    .mockImplementationOnce(async () =>
      json([release("0.5.0"), release("0.4.99")]),
    );
  expect(await f.checker.check()).toMatchObject({ latestVersion: "0.5.0" });
  expect(f.fetchImpl.mock.calls.map((call: any) => call[0])).toEqual([
    api,
    `${api}&page=2`,
  ]);
});

it("never follows Link header into third page or another host", async () => {
  const f = fixture();
  f.fetchImpl.mockImplementation(async () =>
    json(
      Array.from({ length: 20 }, () => release()),
      { link: '<https://evil.example>; rel="next"' },
    ),
  );
  expect(await f.checker.check()).toMatchObject({ status: "available" });
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
});

it("6h cache, 1min forced-check throttle and concurrent singleflight reduce traffic", async () => {
  const f = fixture();
  const a = f.checker.check(),
    b = f.checker.check({ force: true });
  expect(a).toBe(b);
  const result = await a;
  result.url = "https://evil.example";
  expect(await f.checker.check({ force: true })).toMatchObject({
    cached: true,
    url: `${prefix}/tag/desktop-v0.4.1`,
  });
  f.advance(59_999);
  await f.checker.check({ force: true });
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  f.advance(1);
  await f.checker.check({ force: true });
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  f.advance(6 * hour - 1);
  await f.checker.check();
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  f.advance(1);
  await f.checker.check();
  expect(f.fetchImpl).toHaveBeenCalledTimes(3);
});

it("network failure is an error, throttled and never misreported as current", async () => {
  const f = fixture();
  f.fetchImpl.mockRejectedValue(Error("secret local path / cookie"));
  expect(await f.checker.check()).toEqual({
    status: "error",
    currentVersion: "0.4.0",
    checkedAt: null,
    cached: false,
    error: {
      code: "network",
      message: "无法连接 GitHub 检查更新，请检查网络后重试。",
    },
  });
  expect(await f.checker.check({ force: true })).toMatchObject({
    status: "error",
    cached: true,
  });
  expect(f.fetchImpl).toHaveBeenCalledOnce();
  f.advance(60_000);
  f.fetchImpl.mockResolvedValue(json([release()]));
  expect(await f.checker.check({ force: true })).toMatchObject({
    status: "available",
    cached: false,
  });
});

it("failed refresh preserves prior timestamp but explicitly marks cached data stale", async () => {
  const f = fixture();
  const previous = await f.checker.check();
  f.advance(6 * hour);
  f.fetchImpl.mockRejectedValue(Error("offline"));
  expect(await f.checker.check()).toMatchObject({
    ...previous,
    checkedAt: previous.checkedAt,
    cached: true,
    stale: true,
    error: { code: "network" },
  });
  expect(await f.checker.check({ force: true })).toMatchObject({
    stale: true,
    error: { code: "network" },
  });
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
});

it("does not expose arbitrary coded fetch errors or their secrets", async () => {
  const f = fixture();
  f.fetchImpl.mockRejectedValue(
    Object.assign(Error("private file path and token"), { code: "ENOTFOUND" }),
  );
  const result = await f.checker.check();
  expect(result).toMatchObject({ status: "error", error: { code: "network" } });
  expect(JSON.stringify(result)).not.toContain("private");
});

it.each([403, 429, 404, 500, 302])(
  "HTTP %s is not success and is never followed",
  async (status) => {
    const f = fixture();
    f.fetchImpl.mockResolvedValue(new Response("do not disclose", { status }));
    expect(await f.checker.check()).toMatchObject({
      status: "error",
      error: { code: status === 403 || status === 429 ? "rate-limit" : "http" },
    });
  },
);

it("rejects a fetch implementation that reports a redirect or untrusted final URL", async () => {
  for (const properties of [
    { redirected: true },
    { url: "https://evil.example/api" },
    { url: `${api}&page=9` },
  ]) {
    const f = fixture(),
      response = json([release()]);
    for (const [key, value] of Object.entries(properties))
      Object.defineProperty(response, key, { value });
    f.fetchImpl.mockResolvedValue(response);
    expect(await f.checker.check()).toMatchObject({
      status: "error",
      error: { code: "redirect" },
    });
  }
});

it("rejects oversized Content-Length before reading and limits streaming bytes without the header", async () => {
  const f = fixture();
  f.fetchImpl.mockResolvedValue(json([], { "content-length": "524289" }));
  expect(await f.checker.check()).toMatchObject({
    status: "error",
    error: { code: "response-size" },
  });
  const g = fixture();
  g.fetchImpl.mockResolvedValue(
    new Response(" ".repeat(524289), {
      headers: { "content-type": "application/json" },
    }),
  );
  expect(await g.checker.check()).toMatchObject({
    status: "error",
    error: { code: "response-size" },
  });
});

it("bounds total bytes across both pages", async () => {
  const f = fixture();
  const padded = release("0.4.1", { body: "x".repeat(20_000) });
  f.fetchImpl
    .mockImplementationOnce(async () =>
      json(Array.from({ length: 20 }, () => padded)),
    )
    .mockImplementationOnce(async () =>
      json([release("0.5.0", { body: "x".repeat(150_000) })]),
    );
  expect(await f.checker.check()).toMatchObject({
    status: "error",
    error: { code: "response-size" },
  });
});

it.each([
  new Response("<html>oops</html>", {
    headers: { "content-type": "text/html" },
  }),
  new Response("{oops", { headers: { "content-type": "application/json" } }),
  json({ message: "oops" }),
  json(Array.from({ length: 21 }, () => release())),
])("rejects malformed JSON/type/list", async (response) => {
  const f = fixture();
  f.fetchImpl.mockResolvedValue(response);
  expect(await f.checker.check()).toMatchObject({
    status: "error",
    error: { code: "response-format" },
  });
});

it("no eligible release is an error rather than a false current verdict", async () => {
  expect(await fixture([]).checker.check()).toMatchObject({
    status: "error",
    error: { code: "no-release" },
  });
});

it("10s deadline aborts a stalled fetch", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetchImpl.mockImplementation(() => new Promise(() => {}));
  const promise = f.checker.check();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await promise).toMatchObject({
    status: "error",
    error: { code: "timeout" },
  });
  expect((f.fetchImpl.mock.calls[0] as any)[1].signal.aborted).toBe(true);
});

it("10s deadline cancels a stalled streaming body too", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    cancelled = vi.fn();
  f.fetchImpl.mockResolvedValue(
    new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const promise = f.checker.check();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await promise).toMatchObject({
    status: "error",
    error: { code: "timeout" },
  });
  expect(cancelled).toHaveBeenCalledOnce();
});
