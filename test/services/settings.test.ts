import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSettings, DEFAULT_SETTINGS, SettingsStore } from "../../src/services/settings";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgcy-settings-"));
  path = join(dir, "config.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("load returns defaults when file missing", async () => {
    const store = new SettingsStore({ path });
    const s = await store.load();
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
  });

  test("save + load round-trip", async () => {
    const store = new SettingsStore({ path });
    await store.save({ defaultProviderId: "openai", theme: "dark" });
    // Fresh instance reads from disk (no cache).
    const store2 = new SettingsStore({ path });
    const s = await store2.load();
    expect(s.defaultProviderId).toBe("openai");
    expect(s.theme).toBe("dark");
  });

  test("update merges without clobbering other keys", async () => {
    const store = new SettingsStore({ path });
    await store.update({ defaultProviderId: "openai", theme: "dark" });
    await store.update({ defaultModel: "gpt-4" });
    const s = await store.load();
    expect(s.defaultProviderId).toBe("openai"); // not clobbered
    expect(s.defaultModel).toBe("gpt-4");
    expect(s.theme).toBe("dark");
  });

  test("update deep-merges models map", async () => {
    const store = new SettingsStore({ path });
    const a: AppSettings = await store.update({ models: { openai: ["gpt-4"] } });
    await store.update({ models: { anthropic: ["claude"] } });
    const s = await store.load();
    expect(s.models).toEqual({ openai: ["gpt-4"], anthropic: ["claude"] });
    void a;
  });

  test("update deep-merges preferences", async () => {
    const store = new SettingsStore({ path });
    await store.update({ preferences: { font: "mono" } });
    await store.update({ preferences: { fontSize: 14 } });
    const s = await store.load();
    expect(s.preferences).toEqual({ font: "mono", fontSize: 14 });
  });
});

describe("SettingsStore — items #16/#17/#45", () => {
  test("load strips unknown keys and invalid theme (#17)", async () => {
    const store = new SettingsStore({ path });
    await writeFile(path, JSON.stringify({ theme: "neon", bogus: 1, defaultProviderId: 42 }), "utf-8");
    const s = await store.load();
    expect(s.theme).toBe("auto"); // invalid → default
    expect((s as Record<string, unknown>).bogus).toBeUndefined();
    expect(s.defaultProviderId).toBeUndefined(); // non-string dropped
  });
  test("update deletes models keys via undefined (#16)", async () => {
    const store = new SettingsStore({ path });
    await store.update({ models: { openai: ["gpt-4"], anthropic: ["claude"] } });
    await store.update({ models: { openai: undefined } });
    const s = await store.load();
    expect(s.models).toEqual({ anthropic: ["claude"] });
  });
  test("update deletes top-level keys via undefined (#16)", async () => {
    const store = new SettingsStore({ path });
    await store.update({ defaultModel: "gpt-4" });
    await store.update({ defaultModel: undefined });
    const s = await store.load();
    expect(s.defaultModel).toBeUndefined();
  });
  test("onWarn triggered on credential-shaped preferences (#45)", async () => {
    const warnings: string[] = [];
    const store = new SettingsStore({ path, onWarn: (m) => warnings.push(m) });
    await store.update({ preferences: { apiToken: "sk-" + "abcdefghijklmnop" } });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain("preferences.");
  });
});
