import { describe, expect, test } from "bun:test";
import { GitNotFoundError, GitService, GitTimeoutError, defaultRunner, parseBranchHeader } from "../../src/services/git";

describe("parseBranchHeader (#29)", () => {
  test("normal branch", () => {
    expect(parseBranchHeader("main...origin/main [ahead 1]")).toBe("main");
  });
  test("detached HEAD", () => {
    expect(parseBranchHeader("HEAD (no branch)")).toBe("(detached HEAD)");
  });
  test("unborn branch (no commits)", () => {
    expect(parseBranchHeader("No commits yet on feature-x")).toBe("feature-x");
  });
  test("simple branch (no upstream)", () => {
    expect(parseBranchHeader("fix/docs")).toBe("fix/docs");
  });
});

describe("GitService defaultRunner (#30/#53)", () => {
  test("real git --version succeeds", async () => {
    const { stdout } = await defaultRunner(["--version"], process.cwd());
    expect(stdout).toMatch(/^git version/);
  });

  test("missing binary throws GitNotFoundError (#53)", async () => {
    await expect(
      defaultRunner(["status"], process.cwd(), { bin: "definitely-not-a-real-binary-xyz" }),
    ).rejects.toBeInstanceOf(GitNotFoundError);
  });

  test("timeout kills hung process and throws GitTimeoutError (#30)", async () => {
    // Spawn bun with a long setTimeout — the runner kills it after 50 ms.
    await expect(
      defaultRunner(["-e", "setTimeout(()=>{}, 5000)"], process.cwd(), {
        bin: process.execPath,
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(GitTimeoutError);
  });
});

describe("GitService — branch parsing with injected runner (#29)", () => {
  function mockRunner(stdout: string) {
    return async () => ({ stdout, stderr: "", exitCode: 0 });
  }

  test("normal branch status", async () => {
    const gs = new GitService("/x", { runner: mockRunner("## main...origin/main\nM  file.ts\n") });
    const s = await gs.status();
    expect(s.branch).toBe("main");
    expect(s.entries).toHaveLength(1);
    expect(s.clean).toBe(false);
  });

  test("detached HEAD status", async () => {
    const gs = new GitService("/x", { runner: mockRunner("## HEAD (no branch)\n") });
    expect((await gs.status()).branch).toBe("(detached HEAD)");
  });

  test("unborn branch status", async () => {
    const gs = new GitService("/x", { runner: mockRunner("## No commits yet on main\n") });
    expect((await gs.status()).branch).toBe("main");
  });
});
