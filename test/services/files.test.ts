import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService, FileNotFoundError } from "../../src/services/files";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgcy-files-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileService", () => {
  test("writeText + readText round-trip", async () => {
    const fs = new FileService({ root: dir });
    await fs.writeText("a.txt", "hello");
    expect(await fs.readText("a.txt")).toBe("hello");
  });

  test("writeText creates nested directories", async () => {
    const fs = new FileService({ root: dir });
    await fs.writeText("sub/deep/file.txt", "x");
    expect(await fs.readText("sub/deep/file.txt")).toBe("x");
  });

  test("readText missing file throws FileNotFoundError", async () => {
    const fs = new FileService({ root: dir });
    await expect(fs.readText("nope.txt")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  test("path escaping root is rejected", async () => {
    const fs = new FileService({ root: dir });
    expect(() => fs.resolve("../../../etc/passwd")).toThrow(/workspace root/);
  });

  test("literal child names beginning with dots are allowed", async () => {
    const fs = new FileService({ root: dir });
    await fs.writeText("..foo/file.txt", "ok");
    expect(await fs.readText("..foo/file.txt")).toBe("ok");
  });

  test("absolute path inside root allowed", async () => {
    const fs = new FileService({ root: dir });
    await fs.writeText("ok.txt", "y");
    expect(await fs.readText(join(dir, "ok.txt"))).toBe("y");
  });

  test("exists returns boolean", async () => {
    const fs = new FileService({ root: dir });
    expect(await fs.exists("nope")).toBe(false);
    await fs.writeText("y.txt", "z");
    expect(await fs.exists("y.txt")).toBe(true);
  });

  test("listDir returns sorted entries (dirs first)", async () => {
    const fs = new FileService({ root: dir });
    await fs.writeText("b.txt", "1");
    await fs.writeText("a.txt", "1");
    await fs.writeText("sub/c.txt", "1");
    const entries = await fs.listDir(".");
    const names = entries.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
    const sub = entries.find((e) => e.name === "sub")!;
    expect(sub.isDirectory).toBe(true);
  });

  test("respects maxReadBytes limit", async () => {
    const fs = new FileService({ root: dir, maxReadBytes: 3 });
    await fs.writeText("big.txt", "xxxxx");
    await expect(fs.readText("big.txt")).rejects.toThrow(/too large/);
  });

  test("readText rejects symlinks that escape the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "lgcy-files-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret", "utf-8");
      await symlink(join(outside, "secret.txt"), join(dir, "linked-secret.txt"));
      const fs = new FileService({ root: dir });
      await expect(fs.readText("linked-secret.txt")).rejects.toThrow(/workspace root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("writeText rejects symlinked parent directories that escape the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "lgcy-files-outside-"));
    try {
      await symlink(outside, join(dir, "linked-dir"));
      const fs = new FileService({ root: dir });
      await expect(fs.writeText("linked-dir/new.txt", "secret")).rejects.toThrow(/workspace root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("listDir rejects symlinked directories that escape the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "lgcy-files-outside-"));
    try {
      await symlink(outside, join(dir, "linked-dir"));
      const fs = new FileService({ root: dir });
      await expect(fs.listDir("linked-dir")).rejects.toThrow(/workspace root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
