import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokerClient,
  BrokerError,
  extractSecret,
  parseSnapshot,
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

describe("parseSnapshot (#14)", () => {
  test("valid snapshot parses and strips unknown credential fields", () => {
    const parsed = parseSnapshot({
      generation: 2,
      generatedAt: 500,
      serverNowMs: 600,
      refresher: { enabled: true, intervalMs: 120000, skewMs: 2000, nextSweepInMs: 110000 },
      credentials: [
        {
          id: 1,
          provider: "x",
          credential: { type: "api_key", key: "k", ssn: "123-45-6789" },
          identityKey: null,
          rotatesInMs: 60000,
        },
      ],
    });
    expect(parsed.credentials[0]!.credential).toEqual({ type: "api_key", key: "k" });
    expect((parsed.credentials[0]!.credential as unknown as Record<string, unknown>).ssn).toBeUndefined();
  });
  test("rejects non-object", () => {
    expect(() => parseSnapshot(null)).toThrow(BrokerError);
    expect(() => parseSnapshot("str")).toThrow(BrokerError);
  });
  test("rejects missing credentials", () => {
    expect(() => parseSnapshot({ generation: 1, generatedAt: 1, serverNowMs: 1, refresher: {} })).toThrow(BrokerError);
  });
  test("strips unknown top-level fields", () => {
    const parsed = parseSnapshot({
      generation: 1,
      generatedAt: 1,
      serverNowMs: 1,
      refresher: {},
      credentials: [{ provider: "x", credential: { type: "api_key", key: "k" } }],
      secretPayload: "hidden",
    });
    expect((parsed as unknown as Record<string, unknown>).secretPayload).toBeUndefined();
  });
});

describe("BrokerClient item #1 — token file cache + reload", () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lgcy-broker-"));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reloadToken re-reads the file; #fileToken separated from constructor token", async () => {
    const tokenFile = join(tmpDir, "token.txt");
    await writeFile(tokenFile, "tok-v1\n");
    let lastAuthToken: string | undefined;
    const fetch = (async (input: URL | string, init?: RequestInit) => {
      const h = Object.fromEntries(new Headers(init?.headers).entries());
      lastAuthToken = h.authorization?.replace("Bearer ", "");
      return new Response(JSON.stringify(snapshot()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchImpl;
    // No constructor token — reads from file.
    const c = new BrokerClient({ tokenFile, fetchImpl: fetch, now: () => 0 });
    await c.snapshot();
    expect(lastAuthToken).toBe("tok-v1");
    // Rotate the file behind our back.
    await writeFile(tokenFile, "tok-v2\n");
    c.reloadToken();
    await c.snapshot(true);
    expect(lastAuthToken).toBe("tok-v2");
  });

  test("401 clears file token cache so next read picks up new file token", async () => {
    const tokenFile = join(tmpDir, "token401.txt");
    await writeFile(tokenFile, "stale\n");
    let call = 0;
    const fetch = (async (_input: URL | string, init?: RequestInit) => {
      call++;
      if (call === 1) return new Response("", { status: 401 });
      // After the cached file token was cleared, the client re-reads the file
      // and sends the new token on the second call.
      const h = Object.fromEntries(new Headers(init?.headers).entries());
      expect(h.authorization).toBe("Bearer fresh");
      return new Response(JSON.stringify(snapshot()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchImpl;
    const c = new BrokerClient({ tokenFile, fetchImpl: fetch, now: () => 0 });
    await writeFile(tokenFile, "fresh\n");
    await expect(c.snapshot()).rejects.toThrow(/401/);
    expect(c.snapshot()).resolves.toBeTruthy();
  });
});

describe("BrokerClient item #2 — per-credential rotation vs minTtlMs floor", () => {
  test("stale credential triggers force refresh even when snapshot TTL not exhausted", async () => {
    let fetches = 0;
    const slowSnapshot = (generation: number, rotatesInMs: number): BrokerSnapshot => ({
      generation,
      generatedAt: 1000,
      serverNowMs: 1000,
      refresher: { enabled: true, intervalMs: 60000, skewMs: 0, nextSweepInMs: 50000 },
      credentials: [{ id: 1, provider: "fast", credential: { type: "api_key", key: "v" }, identityKey: null, rotatesInMs }],
    });
    const fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify(slowSnapshot(fetches, 500)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as FetchImpl;
    // rotatesInMs=500, minTtlMs=1000. At t=750 the credential window is stale
    // but the minTtl floor keeps the cache alive — per-credential kicks in.
    let clock = 0;
    const c = new BrokerClient({ fetchImpl: fetch, now: () => clock, token: "t", minTtlMs: 1000, defaultTtlMs: 60000 });
    await c.resolve("fast");
    expect(fetches).toBe(1);
    clock = 750; // within minTtl floor (1000), past credential window (500)
    const secret = await c.resolve("fast");
    expect(secret).toBe("v");
    expect(fetches).toBe(2); // per-credential forced a refresh
  });
});

describe("BrokerClient item #15 — health timeout", () => {
  test("slow broker returns false (offline) instead of hanging", async () => {
    const fetch = (async (_input: URL | string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }) as unknown as FetchImpl;
    const c = new BrokerClient({ token: "t", fetchImpl: fetch, healthTimeoutMs: 10 });
    expect(await c.health()).toBe(false);
  });
});
