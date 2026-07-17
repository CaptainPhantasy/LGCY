/**
 * Git service — read-only git status and diff via subprocess. Runs git in the
 * workspace root and parses porcelain output. Never writes to the repo.
 */

import { type FileService } from "./files";

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

export interface GitServiceOptions {
  /** Injectable command runner for tests; defaults to a real subprocess. */
  runner?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export class GitService {
  readonly #root: string;
  readonly #runner: NonNullable<GitServiceOptions["runner"]>;

  constructor(root: string, opts: GitServiceOptions = {}) {
    this.#root = root;
    this.#runner = opts.runner ?? defaultRunner;
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
        const m = /^## (.+?)(?:\.\.\.|$)/.exec(line);
        branch = m ? m[1]! : line.slice(3);
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

export const defaultRunner = async (
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

// FileService import kept for the composition-root convenience below.
export function gitForWorkspace(files: FileService): GitService {
  return new GitService(files.root);
}
