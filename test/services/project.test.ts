import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectService } from "../../src/services/project";

describe("ProjectService — items #27/#28/#54", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lgcy-project-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("bun.lock takes precedence over package.json in same dir", async () => {
    await writeFile(join(dir, "bun.lock"), "");
    await writeFile(join(dir, "package.json"), '{"name":"x"}');
    const info = await new ProjectService().discover(dir);
    expect(info.kind).toBe("bun");
    expect(info.root).toBe(dir);
  });

  test("walks up from nested child to find parent marker", async () => {
    await writeFile(join(dir, "package.json"), '{"name":"x"}');
    const sub = join(dir, "a", "b", "c");
    await mkdir(sub, { recursive: true });
    const info = await new ProjectService().discover(sub);
    expect(info.kind).toBe("node");
    expect(info.root).toBe(dir);
  });

  test("returns unknown when no markers found", async () => {
    // Force the fallthrough branch deterministically: the real walk-up would
    // find host ancestors (e.g. a .git in the macOS /var/folders tree), so we
    // override exists() to report no markers anywhere and assert the unknown
    // branch is reached regardless of the host filesystem layout.
    class NoMarkerService extends ProjectService {
      override async exists(): Promise<boolean> {
        return false;
      }
    }
    const info = await new NoMarkerService().discover(dir);
    expect(info.kind).toBe("unknown");
    expect(info.root).toBe(dir);
  });

  test("git marker detection", async () => {
    await mkdir(join(dir, ".git"));
    const info = await new ProjectService().discover(dir);
    expect(info.kind).toBe("git");
  });
});
