import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, scrubSecrets, SessionStore } from "../../src/services/sessions";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgcy-sess-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("create + load round-trips header", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("s1", { title: "Test", createdAt: 1000, providerId: "openai" });
    const loaded = await store.load("s1");
    expect(loaded.sessionId).toBe("s1");
    expect(loaded.meta.title).toBe("Test");
    expect(loaded.meta.providerId).toBe("openai");
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(loaded.entries).toEqual([]);
  });

  test("append assigns monotonic sequence numbers", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("s1", { title: "T", createdAt: 0 });
    const seq0 = await store.append("s1", "message", { role: "user", content: "hi" });
    const seq1 = await store.append("s1", "message", { role: "assistant", content: "yo" });
    expect(seq0).toBe(0);
    expect(seq1).toBe(1);
    const loaded = await store.load("s1");
    expect(loaded.entries).toHaveLength(2);
    expect(loaded.entries[0]!.seq).toBe(0);
    expect(loaded.entries[1]!.seq).toBe(1);
    expect(loaded.entries[0]!.type).toBe("message");
    expect(loaded.entries[1]!.data).toEqual({ role: "assistant", content: "yo" });
  });

  test("append scrubs secrets at the persistence boundary", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("s1", { title: "T", createdAt: 0 });
    await store.append("s1", "message", {
      authorization: "Bearer live-token",
      content: "token is sk-abcd1234567890",
      nested: { api_key: "secret-value", keep: "ok" },
    });
    const loaded = await store.load("s1");
    expect(loaded.entries[0]!.data).toEqual({
      authorization: "[redacted]",
      content: "token is sk-[redacted]",
      nested: { api_key: "[redacted]", keep: "ok" },
    });
  });

  test("append supports an explicit scrubber override", async () => {
    const store = new SessionStore({ baseDir: dir, scrubber: () => ({ scrubbed: true }) });
    await store.create("s1", { title: "T", createdAt: 0 });
    await store.append("s1", "message", { key: "secret" });
    const loaded = await store.load("s1");
    expect(loaded.entries[0]!.data).toEqual({ scrubbed: true });
  });

  test("load skips torn/malformed lines (crash-safe)", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("s1", { title: "T", createdAt: 0 });
    await store.append("s1", "message", { ok: true });
    // Append a corrupt line directly.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.pathFor("s1"), "THIS IS NOT JSON\n");
    const loaded = await store.load("s1");
    expect(loaded.entries).toHaveLength(1); // corrupt line skipped
  });

  test("load throws on missing header", async () => {
    const store = new SessionStore({ baseDir: dir });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.pathFor("s1"), '{"v":1,"kind":"entry","seq":0,"type":"x","data":{}}\n');
    await expect(store.load("s1")).rejects.toThrow(/header/);
  });

  test("list returns all sessions sorted by mtime desc", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("a", { title: "A", createdAt: 0 });
    await store.create("b", { title: "B", createdAt: 0 });
    await store.append("b", "message", {});
    const list = await store.list();
    expect(list.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    const b = list.find((s) => s.sessionId === "b")!;
    expect(b.entryCount).toBe(1);
  });

  test("list returns [] when directory does not exist", async () => {
    const store = new SessionStore({ baseDir: join(dir, "nope") });
    expect(await store.list()).toEqual([]);
  });
});

describe("SessionStore — items #22/#24/#59", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lgcy-sess-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("seq cache yields monotonic seqs without reload (#22)", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("s1", { title: "T", createdAt: 0 });
    const seq0 = await store.append("s1", "x", { n: 1 });
    const seq1 = await store.append("s1", "x", { n: 2 });
    expect(seq0).toBe(0);
    expect(seq1).toBe(1);
  });

  test("list with torn line does not inflate entryCount (#24)", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("s1", { title: "T", createdAt: 0 });
    await store.append("s1", "x", { ok: true });
    // Append a garbage line directly.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.pathFor("s1"), "GARBAGE LINE NOT JSON\n");
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.entryCount).toBe(1); // garbage not counted
  });

  test("redacted flag set when scrubber modifies data (#59)", async () => {
    const store = new SessionStore({ baseDir: dir });
    await store.create("s1", { title: "T", createdAt: 0 });
    await store.append("s1", "msg", { authorization: "Bearer live" });
    await store.append("s1", "msg", { harmless: 1 });
    const loaded = await store.load("s1");
    expect(loaded.entries[0]!.redacted).toBe(true);
    expect(loaded.entries[1]!.redacted).toBeUndefined();
  });
});

describe("SessionStore — migrations", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lgcy-sess-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("migration runs registered steps", async () => {
    const migrations = new Map([
      [
        0,
        (line: Record<string, unknown>) => ({ ...line, v: 1, meta: { ...((line.meta as object) ?? {}), migrated: true } }),
      ],
    ]);
    const store = new SessionStore({ baseDir: dir, migrations });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      store.pathFor("s1"),
      '{"v":0,"kind":"header","sessionId":"s1","meta":{"title":"old","createdAt":0}}\n',
    );
    const loaded = await store.load("s1");
    expect((loaded.meta as unknown as { migrated: boolean }).migrated).toBe(true);
  });
});

describe("scrubSecrets", () => {
  test("redacts api-key-shaped strings", () => {
    expect(scrubSecrets("token is sk-abcd1234567890")).toBe("token is sk-[redacted]");
  });
  test("redacts bearer tokens", () => {
    expect(scrubSecrets("Authorization: Bearer abc123")).toBe("Authorization: Bearer [redacted]");
  });
  test("redacts keyed secret fields in objects", () => {
    const out = scrubSecrets({
      password: "hunter2",
      name: "keep",
      nested: { access_token: "tok", ok: 1 },
    }) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect(out.name).toBe("keep");
    expect((out.nested as Record<string, unknown>).access_token).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });
  test("generic key/token names redact only credential-shaped values", () => {
    const out = scrubSecrets({
      key: "ctrl-c", // keyboard shortcut — NOT a secret
      token: "abc", // too short to be a credential
      secret: "sk-" + "livekey123456789", // credential-shaped generic key
    }) as Record<string, unknown>;
    expect(out.key).toBe("ctrl-c");
    expect(out.token).toBe("abc");
    expect(out.secret).toBe("[redacted]");
  });
  test("passes through primitives", () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets(null)).toBe(null);
  });
  test("redacts always-secret keys: access_token, refresh_token, client_secret, cookie (#23/#25)", () => {
    const out = scrubSecrets({
      access_token: "at",
      refresh_token: "rt",
      client_secret: "cs",
      private_key: "pk",
      cookie: "sessionid=abc",
    }) as Record<string, unknown>;
    expect(out.access_token).toBe("[redacted]");
    expect(out.refresh_token).toBe("[redacted]");
    expect(out.client_secret).toBe("[redacted]");
    expect(out.private_key).toBe("[redacted]");
    expect(out.cookie).toBe("[redacted]");
  });
  test("JWT-shaped string in free text scrubbed (#43)", () => {
    const result = scrubSecrets("my token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3j6NJpMfWYw5vJ-lh_jGQrJ8X3Ggg1Eg");
    expect(result).toContain("[redacted-jwt]");
  });
  test("Bearer after newline (no space) still redacted (#43)", () => {
    expect(scrubSecrets("Authorization:\nBearer abc123")).toBe("Authorization:\nBearer [redacted]");
  });
  test("Buffer input stringified (#58)", () => {
    const result = scrubSecrets({ buf: Buffer.from("hi") }) as Record<string, unknown>;
    expect(result.buf as string).toMatch(/^\[buffer \d+ bytes\]/);
  });
  test("Date input stringified (#58)", () => {
    const d = new Date(0);
    expect(scrubSecrets(d)).toBe(d.toISOString());
  });
  test("circular reference produces marker (#58)", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    const out = scrubSecrets(o) as Record<string, unknown>;
    expect(out.self).toBe("[circular]");
  });
});
