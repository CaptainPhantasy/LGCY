import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// SHARED_DIR is read from LGCY_SHARED_DIR when settings.ts is first imported,
// so each scenario runs in a child Bun process with its own isolated shared
// config instead of whatever the host has under /usr/local/share/lgcy.
const SETTINGS_MODULE = resolve(import.meta.dir, "../../src/services/settings.ts");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgcy-shared-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runWithShared(shared: unknown, userPath: string, body: string): Promise<unknown> {
  const sharedDir = join(dir, "shared");
  await mkdir(sharedDir, { recursive: true });
  await writeFile(join(sharedDir, "config.json"), JSON.stringify(shared));
  const script = `
    const { SettingsStore } = await import(${JSON.stringify(SETTINGS_MODULE)});
    const store = new SettingsStore({ path: ${JSON.stringify(userPath)}, onWarn: () => {} });
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result));
  `;
  const proc = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, LGCY_SHARED_DIR: sharedDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}

describe("SettingsStore with isolated shared defaults (regression: PR #5)", () => {
  const shared = {
    theme: "light",
    models: { anthropic: ["claude-sonnet"], openai: ["gpt-4o"] },
    preferences: { font: "mono", lineHeight: 1.4 },
  };

  test("updating one map entry keeps inherited shared entries", async () => {
    const userPath = join(dir, "user", "config.json");
    const eff = (await runWithShared(shared, userPath, `
      return await store.update({ models: { openai: ["gpt-5"] }, preferences: { fontSize: 14 } });
    `)) as Record<string, unknown>;
    expect(eff.theme).toBe("light");
    expect(eff.models).toEqual({ anthropic: ["claude-sonnet"], openai: ["gpt-5"] });
    expect(eff.preferences).toEqual({ font: "mono", lineHeight: 1.4, fontSize: 14 });
  });

  test("only the user layer is persisted; shared defaults are not written back", async () => {
    const userPath = join(dir, "user", "config.json");
    await runWithShared(shared, userPath, `
      return await store.update({ models: { openai: ["gpt-5"] }, preferences: { fontSize: 14 } });
    `);
    const persisted = JSON.parse(await readFile(userPath, "utf-8"));
    expect(persisted.theme).toBeUndefined();
    expect(persisted.models).toEqual({ openai: ["gpt-5"] });
    expect(persisted.preferences).toEqual({ fontSize: 14 });
  });

  test("a later change to the shared file still reaches the user", async () => {
    const userPath = join(dir, "user", "config.json");
    await runWithShared(shared, userPath, `return await store.update({ preferences: { fontSize: 14 } });`);
    const eff = (await runWithShared(
      { theme: "dark", models: { anthropic: ["claude-opus"] }, preferences: { font: "serif" } },
      userPath,
      `return await store.load();`,
    )) as Record<string, unknown>;
    expect(eff.theme).toBe("dark");
    expect(eff.models).toEqual({ anthropic: ["claude-opus"] });
    expect(eff.preferences).toEqual({ font: "serif", fontSize: 14 });
  });

  test("deleting an inherited key only affects the user layer", async () => {
    const userPath = join(dir, "user", "config.json");
    const eff = (await runWithShared(shared, userPath, `
      await store.update({ theme: "dark" });
      return await store.update({ theme: undefined });
    `)) as Record<string, unknown>;
    expect(eff.theme).toBe("light");
    const persisted = JSON.parse(await readFile(userPath, "utf-8"));
    expect(persisted.theme).toBeUndefined();
  });
});
