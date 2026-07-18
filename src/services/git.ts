/**
 * Git service — read-only git status and diff via subprocess. Runs git in the
 * workspace root and parses porcelain output. Never writes to the repo.
 *
 * The default runner enforces a hard process timeout (default 10 s) so a hung
 * git process cannot block the caller forever, and classifies a missing git
 * binary as GitNotFoundError with an install hint.
 */

export interface GitStatusEntry {
  path: string;
  /** Staged status code (XY porcelain: X = index, Y = worktree). */
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatus {
  branch: string;
  entries: GitStatusEntry[];
  clean: boolean;
}

/** git executable not found on PATH. */
export class GitNotFoundError extends Error {
  constructor(bin: string) {
    super(`git executable not found: "${bin}" — install git and ensure it is on PATH`);
    this.name = "GitNotFoundError";
  }
}

/** git process exceeded the configured timeout and was killed. */
export class GitTimeoutError extends Error {
  constructor(args: string[], timeoutMs: number) {
    super(`git ${args.join(" ")} timed out after ${timeoutMs}ms and was killed`);
    this.name = "GitTimeoutError";
  }
}

export interface GitServiceOptions {
  /** Injectable command runner for tests; defaults to a real subprocess. */
  runner?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Hard timeout for the default runner; default 10 s. */
  timeoutMs?: number;
}

export class GitService {
  readonly #root: string;
  readonly #runner: NonNullable<GitServiceOptions["runner"]>;

  constructor(root: string, opts: GitServiceOptions = {}) {
    this.#root = root;
    this.#runner =
      opts.runner ?? ((args, cwd) => defaultRunner(args, cwd, { timeoutMs: opts.timeoutMs }));
  }

  /** True if the workspace root is inside a git repository. */
  async isRepo(): Promise<boolean> {
    const r = await this.#runner(["rev-parse", "--is-inside-work-tree"], this.#root);
    return r.exitCode === 0 && r.stdout.trim() === "true";
  }

  /** Porcelain status + current branch. */
  async status(): Promise<GitStatus> {
    const r = await this.#runner(["status", "--porcelain=v1", "-b"], this.#root);
    if (r.exitCode !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`);
    const entries: GitStatusEntry[] = [];
    let branch = "(unknown)";
    for (const line of r.stdout.split("\n")) {
      if (line.length === 0) continue;
      // Branch header: "## main...origin/main [ahead 1]"
      if (line.startsWith("## ")) {
        branch = parseBranchHeader(line.slice(3));
        continue;
      }
      // Porcelain: "XY path" where XY are two status chars.
      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const path = line.slice(3);
      entries.push({ path, indexStatus, worktreeStatus });
    }
    return { branch, entries, clean: entries.length === 0 };
  }

  /** Unstaged diff (worktree vs index). Returns raw unified diff text. */
  async diff(staged = false): Promise<string> {
    const args = ["diff"];
    if (staged) args.push("--cached");
    const r = await this.#runner(args, this.#root);
    if (r.exitCode !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
    return r.stdout;
  }
}

/**
 * Parse the "## ..." header of `git status -b`. Handles the two non-branch
 * forms explicitly: detached HEAD ("HEAD (no branch)") and an unborn branch
 * ("No commits yet on main").
 */
export function parseBranchHeader(header: string): string {
  if (header === "HEAD (no branch)") return "(detached HEAD)";
  const unborn = "No commits yet on ";
  if (header.startsWith(unborn)) {
    return header.slice(unborn.length).split("...")[0]!.trim();
  }
  const m = /^(.+?)(?:\.\.\.|$)/.exec(header);
  return m ? m[1]! : header;
}

export interface DefaultRunnerOptions {
  /** Hard kill timeout; default 10 000 ms. */
  timeoutMs?: number;
  /** Executable to spawn; default "git" (overridable for tests). */
  bin?: string;
}

const DEFAULT_GIT_TIMEOUT_MS = 10_000;

// Helper so the literal "pipe" options flow into the inferred return type.
function spawnGit(bin: string, args: string[], cwd: string) {
  return Bun.spawn({ cmd: [bin, ...args], cwd, stdout: "pipe", stderr: "pipe" });
}

export const defaultRunner = async (
  args: string[],
  cwd: string,
  opts: DefaultRunnerOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const bin = opts.bin ?? "git";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  let proc: ReturnType<typeof spawnGit>;
  try {
    proc = spawnGit(bin, args, cwd);
  } catch (e) {
    if (isEnoent(e)) throw new GitNotFoundError(bin);
    throw e;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (timedOut) throw new GitTimeoutError(args, timeoutMs);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

function isEnoent(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return code === "ENOENT" || /ENOENT|no such file|not found/i.test(e.message);
}
