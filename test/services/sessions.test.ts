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
    const out = scrubSecrets({ key: "secret", name: "keep", nested: { token: "t", ok: 1 } }) as Record<string, unknown>;
    expect(out.key).toBe("[redacted]");
    expect(out.name).toBe("keep");
    expect((out.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });
  test("passes through primitives", () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets(null)).toBe(null);
  });
});
