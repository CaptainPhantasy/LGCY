import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Repo root is derived from this file's location, never from process.cwd(),
// so the test is independent of the directory CI invokes bun from.
const root = join(import.meta.dir, "../..");
const srcRoot = join(root, "src");
const testRoot = join(root, "test");

// ADR-0001 layer rules. "services" may import sibling "services" modules
// (e.g. TaskStore persists via SessionStore) — this is an explicit,
// ADR-documented carve-out, not an oversight.
const layerRules: Record<string, Set<string>> = {
  core: new Set(),
  gateway: new Set(["core"]),
  broker: new Set(["core"]),
  services: new Set(["core", "broker", "gateway", "services"]),
  tui: new Set(["core", "services", "tui"]),
  app: new Set(["core", "broker", "gateway", "services", "tui", "app"]),
};
const importPattern = /import\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/g;

describe("architecture import boundaries", () => {
  // The rules are enforced on BOTH src/ and test/: test files live in
  // layer-mirroring directories (test/<layer>/...) and must not import
  // upward either, so a boundary regression cannot hide in test code.
  // test/architecture/ itself is outside the layer set and is skipped.
  test("src layers do not import upward across ADR-0001 boundaries", async () => {
    const violations = await collectViolations(srcRoot, srcRoot);
    expect(violations).toEqual([]);
  });

  test("test layers obey the same ADR-0001 boundaries", async () => {
    const violations = await collectViolations(testRoot, testRoot);
    expect(violations).toEqual([]);
  });
});

async function collectViolations(scanRoot: string, layerBase: string): Promise<string[]> {
  const violations: string[] = [];
  for (const file of await sourceFiles(scanRoot)) {
    const layer = relative(layerBase, file).split("/")[0];
    if (!layer || !(layer in layerRules)) continue;
    const allowed = layerRules[layer]!;
    const source = await readFile(file, "utf-8");
    for (const specifier of importSpecifiers(source)) {
      const importedLayer = importedSourceLayer(file, specifier);
      if (!importedLayer || importedLayer === layer) continue;
      if (!allowed.has(importedLayer)) {
        violations.push(`${relative(root, file)} imports ${specifier} (${layer} → ${importedLayer})`);
      }
    }
  }
  return violations;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(importPattern)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

function importedSourceLayer(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = join(importer, "..", specifier);
  const rel = relative(srcRoot, target);
  if (rel.startsWith("..") || rel === "") return undefined;
  const layer = rel.split("/")[0];
  return layer && layer in layerRules ? layer : undefined;
}
