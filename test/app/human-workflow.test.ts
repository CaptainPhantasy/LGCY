/**
 * Regression tests for the human-workflow defects found in the 2026-11-06
 * PTY audit: /clear wiping the chrome, truncated (unwrapped) lines, input
 * that hid the newest characters, lone Escape never firing, keyless local
 * endpoints, and dishonest provider status.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEAR_SENTINEL, createApp, inputWindow, sendAndStream, wrapText } from "../../src/app/main";
import { KeyDecoder } from "../../src/tui/keybind";
import { authHeaders, credentialStatus, customProviderFromEnv } from "../../src/gateway/providers";
import { SessionStore } from "../../src/services/sessions";

const enc = (s: string) => new TextEncoder().encode(s);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgcy-human-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("/clear", () => {
  test("emits the clear sentinel, never a raw escape sequence", async () => {
    const a = createApp({ settingsPath: join(dir, "c.json"), sessionsDir: join(dir, "s"), env: {} });
    const out: string[] = [];
    await a.commands.execute("/clear", { state: { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] }, print: (t) => out.push(t) });
    expect(out).toEqual([CLEAR_SENTINEL]);
    expect(out.join("")).not.toContain("\x1b");
  });
});

describe("wrapText", () => {
  test("wraps long lines to the width without truncating", () => {
    const msg = "error: failed to resolve credential: environment variable ANTHROPIC_API_KEY is not set";
    for (const w of [60, 80, 120]) {
      const lines = wrapText(msg, w);
      expect(lines.every((l) => l.length <= w)).toBe(true);
      expect(lines.join(" ").replace(/\s+/g, " ")).toBe(msg);
      expect(lines.join("")).not.toContain("\u2026");
    }
  });
  test("hard-splits words longer than the width and keeps newlines", () => {
    expect(wrapText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
  });
});

describe("inputWindow", () => {
  test("keeps the newest typed characters visible", () => {
    const typed = "a".repeat(100) + "TAIL";
    const shown = inputWindow(typed, 60);
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown.endsWith("TAIL")).toBe(true);
    expect(inputWindow("short", 60)).toBe("\u203a short");
  });
});

describe("lone Escape", () => {
  test("is pending, then resolves to Escape after the timeout", () => {
    const d = new KeyDecoder();
    expect(d.feed(enc("\x1b"))).toEqual([]);
    expect(d.hasPendingEscape()).toBe(true);
    expect(d.takePendingEscape().map((k) => k.key)).toEqual(["Escape"]);
    expect(d.feed(enc("\x1b[A")).map((k) => k.key)).toEqual(["ArrowUp"]);
    expect(d.feed(enc("/exit")).map((k) => k.key).join("")).toBe("/exit");
  });
  test("Escape followed by an arrow in one chunk is not fused", () => {
    const d = new KeyDecoder();
    expect(d.feed(enc("\x1b\x1b[D")).map((k) => k.key)).toEqual(["Escape", "ArrowLeft"]);
  });
});

describe("custom OpenAI-compatible endpoint", () => {
  test("LGCY_BASE_URL creates a keyless provider listed first", () => {
    const a = createApp({ settingsPath: join(dir, "c2.json"), sessionsDir: join(dir, "s2"), env: { LGCY_BASE_URL: "http://127.0.0.1:11434/v1/" } });
    const first = a.registry.list()[0]!;
    expect(first.id).toBe("custom");
    expect(first.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(first.apiKeyReference).toEqual({ kind: "none" });
    expect(authHeaders(first, "").authorization).toBeUndefined();
  });
  test("OPENAI_BASE_URL reuses OPENAI_API_KEY; LGCY_API_KEY wins", () => {
    expect(customProviderFromEnv({ OPENAI_BASE_URL: "http://h/v1", OPENAI_API_KEY: "k" })!.apiKeyReference).toEqual({ kind: "env", variable: "OPENAI_API_KEY" });
    expect(customProviderFromEnv({ LGCY_BASE_URL: "http://h/v1", LGCY_API_KEY: "k" })!.apiKeyReference).toEqual({ kind: "env", variable: "LGCY_API_KEY" });
    expect(customProviderFromEnv({})).toBeUndefined();
  });
  test("/providers reports real credential status", async () => {
    const a = createApp({ settingsPath: join(dir, "c3.json"), sessionsDir: join(dir, "s3"), env: {} });
    const openai = a.registry.get("openai");
    expect(credentialStatus(openai, {})).toBe("missing API key (OPENAI_API_KEY)");
    expect(credentialStatus(openai, { OPENAI_API_KEY: "x" })).toBe("configured");
    const out: string[] = [];
    await a.commands.execute("/providers", { state: { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] }, print: (t) => out.push(t) });
    expect(out.join("\n")).not.toMatch(/^enabled /m);
  });
});

describe("sendAndStream history", () => {
  test("sends earlier turns so the model sees the whole conversation", async () => {
    const a = createApp({ settingsPath: join(dir, "c4.json"), sessionsDir: join(dir, "s4"), env: {} });
    let seen: unknown;
    a.relay.stream = async function* (req: { messages: unknown }) {
      seen = req.messages;
      yield { type: "text-delta", requestId: "r", sequence: 0, providerId: "openai", model: "m", elapsedMs: 1, data: { text: "ok" } };
    } as unknown as typeof a.relay.stream;
    const reply = await sendAndStream(a, "openai", "m", "second", [], () => {}, [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ]);
    expect(reply).toBe("ok");
    expect((seen as Array<{ content: string }>).map((m) => m.content)).toEqual(["first", "one", "second"]);
  });
});

describe("session privacy", () => {
  test("session directory is 0700 and files are 0600", async () => {
    const base = join(dir, "private-sessions");
    const store = new SessionStore({ baseDir: base });
    const path = await store.create("t1", { title: "t", providerId: "openai", createdAt: 1 });
    await store.append("t1", "message", { role: "user", content: "hi" });
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(base)).toEqual(["t1.jsonl"]);
  });
});
