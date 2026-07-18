import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { banner, createApp, sendAndStream, type AppContext } from "../../src/app/main";
import type { UnifiedStreamEvent } from "../../src/core/contracts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgcy-app-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function app(ctx?: Partial<Parameters<typeof createApp>[0]>): AppContext {
  return createApp({ settingsPath: join(dir, "config.json"), sessionsDir: join(dir, "sessions"), ...(ctx ?? {}) });
}

describe("createApp", () => {
  test("wires all layers", () => {
    const a = app();
    expect(a.registry.list().length).toBeGreaterThan(0);
    expect(a.relay).toBeDefined();
    expect(a.broker).toBeDefined();
    expect(a.secretResolver).toBeDefined();
    expect(a.settings).toBeDefined();
    expect(a.sessions).toBeDefined();
    expect(a.files).toBeDefined();
    expect(a.project).toBeDefined();
    expect(a.git).toBeDefined();
    expect(a.tasks).toBeDefined();
    expect(a.commands).toBeDefined();
  });

  test("registry contains built-in providers", () => {
    const a = app();
    const ids = a.registry.list().map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
  });

  test("built-in commands registered", () => {
    const a = app();
    for (const id of ["help", "providers", "model", "tasks", "clear", "exit"]) {
      expect(a.commands.has(id)).toBe(true);
    }
  });
});

describe("built-in commands", () => {
  test("/providers lists all providers", async () => {
    const a = app();
    const out: string[] = [];
    await a.commands.execute("/providers", { state: { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] }, print: (t) => out.push(t) });
    expect(out.join("\n")).toContain("openai");
    expect(out.join("\n")).toContain("anthropic");
  });

  test("/model updates settings", async () => {
    const a = app();
    const out: string[] = [];
    const state = { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] };
    await a.commands.execute("/model gpt-4o", { state, print: (t) => out.push(t) });
    expect(out[0]).toContain("gpt-4o");
    const fresh = await a.settings.load();
    expect(fresh.defaultModel).toBe("gpt-4o");
  });

  test("/help lists commands", async () => {
    const a = app();
    const out: string[] = [];
    await a.commands.execute("/help", { state: { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] }, print: (t) => out.push(t) });
    expect(out[0]).toContain("/help");
  });

  test("/tasks shows empty state", async () => {
    const a = app();
    const out: string[] = [];
    await a.commands.execute("/tasks", { state: { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] }, print: (t) => out.push(t) });
    expect(out[0]).toContain("no tasks");
  });

  test("/exit signals exit", async () => {
    const a = app();
    const out: string[] = [];
    await a.commands.execute("/exit", { state: { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] }, print: (t) => out.push(t) });
    expect(out[0]).toBe("__exit__");
  });

  test("unknown command prints error", async () => {
    const a = app();
    const out: string[] = [];
    await a.commands.execute("/bogus", { state: { settings: a.settings, registry: a.registry, tasks: a.tasks, output: [] }, print: (t) => out.push(t) });
    expect(out[0]).toContain("unknown command");
  });
});

describe("banner", () => {
  test("includes version + provider summary", () => {
    const a = app();
    const b = banner(a, true);
    expect(b).toContain("lgcy v");
    expect(b).toContain("broker: online");
    expect(b).toContain("openai");
  });
  test("offline broker reflected", () => {
    const a = app();
    expect(banner(a, false)).toContain("broker: offline");
  });
});

describe("sendAndStream", () => {
  test("renders each text delta and leaves the final response in the log", async () => {
    const a = app();
    const events: UnifiedStreamEvent[] = [
      { type: "text-delta", requestId: "r1", sequence: 0, providerId: "openai", model: "gpt-4o", elapsedMs: 1, data: { text: "hel" } },
      { type: "text-delta", requestId: "r1", sequence: 1, providerId: "openai", model: "gpt-4o", elapsedMs: 2, data: { text: "lo" } },
    ];
    a.relay.stream = async function* () {
      yield* events;
    } as typeof a.relay.stream;
    const log: string[] = [];
    const renders: string[][] = [];

    await sendAndStream(a, "openai", "gpt-4o", "hi", log, () => renders.push([...log]));

    expect(renders.length).toBe(3);
    expect(renders[0]).toEqual(["hel"]);
    expect(renders[1]).toEqual(["hello"]);
    expect(renders[2]).toEqual(["hello"]);
    expect(log).toEqual(["hello"]);
  });
});
