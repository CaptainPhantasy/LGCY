import { describe, expect, test } from "bun:test";
import {
  BrokerClient,
  BrokerError,
  extractSecret,
  type BrokerSnapshot,
  type FetchImpl,
} from "../../src/broker/client";

function snapshot(overrides: Partial<BrokerSnapshot> = {}): BrokerSnapshot {
  return {
    generation: 1,
    generatedAt: 1000,
    serverNowMs: 1000,
    refresher: { enabled: true, intervalMs: 60000, skewMs: 1000, nextSweepInMs: 50000 },
    credentials: [
      {
        id: 1,
        provider: "opencode-go",
        credential: { type: "api_key", key: "go-secret" },
        identityKey: null,
        rotatesInMs: 60000,
      },
      {
        id: 2,
        provider: "anthropic",
        credential: { type: "oauth", access: "anthropic-access", refresh: "__remote__", expires: 9999999 },
        identityKey: "user@example",
        rotatesInMs: 30000,
      },
    ],
    ...overrides,
  };
}

function mockFetch(opts: {
  status?: number;
  body?: unknown;
  healthOk?: boolean;
}): { fetch: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: URL | string) => {
    const url = input instanceof URL ? input.toString() : input;
    urls.push(url);
    if (url.endsWith("/v1/healthz")) {
      return new Response(JSON.stringify({ ok: opts.healthOk ?? true, version: "17.0.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const status = opts.status ?? 200;
    const body = opts.body ?? snapshot();
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchImpl;
  return { fetch, urls };
}

describe("extractSecret", () => {
  test("api_key → key", () => {
    expect(extractSecret({ type: "api_key", key: "k" })).toBe("k");
  });
  test("oauth → access token", () => {
    expect(extractSecret({ type: "oauth", access: "a", refresh: "__remote__", expires: 1 })).toBe("a");
  });
  test("api_key empty key throws", () => {
    expect(() => extractSecret({ type: "api_key", key: "" })).toThrow(BrokerError);
  });
  test("oauth empty access throws", () => {
    expect(() => extractSecret({ type: "oauth", access: "", refresh: "__remote__", expires: 1 })).toThrow(
      BrokerError,
    );
  });
});

describe("BrokerClient", () => {
  test("health returns true on ok", async () => {
    const { fetch } = mockFetch({});
    const c = new BrokerClient({ token: "t", fetchImpl: fetch });
    expect(await c.health()).toBe(true);
  });
  test("health returns false on bad status", async () => {
    const { fetch } = mockFetch({ healthOk: false });
    const c = new BrokerClient({ token: "t", fetchImpl: fetch });
    expect(await c.health()).toBe(false);
  });

  test("resolve api_key provider returns key", async () => {
    const { fetch } = mockFetch({});
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => 0 });
    expect(await c.resolve("opencode-go")).toBe("go-secret");
  });
  test("resolve oauth provider returns access token", async () => {
    const { fetch } = mockFetch({});
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => 0 });
    expect(await c.resolve("anthropic")).toBe("anthropic-access");
  });
  test("unknown provider throws", async () => {
    const { fetch } = mockFetch({});
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => 0 });
    await expect(c.resolve("nope")).rejects.toThrow(BrokerError);
  });

  test("snapshot cached within TTL — single fetch for two resolves", async () => {
    const { fetch, urls } = mockFetch({});
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => 0 });
    await c.resolve("opencode-go");
    await c.resolve("anthropic");
    const snapshotFetches = urls.filter((u) => u.endsWith("/v1/snapshot"));
    expect(snapshotFetches).toHaveLength(1);
  });

  test("snapshot re-fetched after TTL expires", async () => {
    const { fetch, urls } = mockFetch({});
    let clock = 0;
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => clock, defaultTtlMs: 30000 });
    await c.resolve("opencode-go"); // fetch at clock=0
    clock = 50000; // past TTL
    await c.resolve("opencode-go"); // re-fetch
    const snapshotFetches = urls.filter((u) => u.endsWith("/v1/snapshot"));
    expect(snapshotFetches).toHaveLength(2);
  });

  test("invalidate forces re-fetch", async () => {
    const { fetch, urls } = mockFetch({});
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => 0 });
    await c.snapshot();
    c.invalidate();
    await c.snapshot();
    expect(urls.filter((u) => u.endsWith("/v1/snapshot"))).toHaveLength(2);
  });

  test("forceRefresh bypasses cache", async () => {
    const { fetch, urls } = mockFetch({});
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => 0 });
    await c.snapshot();
    await c.snapshot(true);
    expect(urls.filter((u) => u.endsWith("/v1/snapshot"))).toHaveLength(2);
  });

  test("401 throws clear error", async () => {
    const { fetch } = mockFetch({ status: 401 });
    const c = new BrokerClient({ token: "bad", fetchImpl: fetch, now: () => 0 });
    await expect(c.snapshot()).rejects.toThrow(/401/);
  });
  test("500 throws", async () => {
    const { fetch } = mockFetch({ status: 500 });
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, now: () => 0 });
    await expect(c.snapshot()).rejects.toThrow(BrokerError);
  });

  test("authorization header carries bearer token", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetch = (async (input: URL | string, init?: RequestInit) => {
      calls.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(JSON.stringify(snapshot()), { status: 200 });
    }) as unknown as FetchImpl;
    const c = new BrokerClient({ token: "tok-123", fetchImpl: fetch, now: () => 0 });
    await c.snapshot();
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
  });
});
