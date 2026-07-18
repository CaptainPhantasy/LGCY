/**
 * Project service — workspace discovery and root resolution. Walks up from a
 * starting directory looking for well-known marker files/dirs to identify the
 * project root and kind. Pure filesystem probing; no heuristics magic.
 */

import { access } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";

export type ProjectKind =
  | "bun"
  | "node"
  | "go"
  | "python"
  | "rust"
  | "git"
  | "unknown";

/** Markers that, when present, identify the project root and kind.
 *  PRECEDENCE IS EXPLICIT: when several markers exist in one directory, the
 *  earliest entry in this list wins (bun.lock before package.json, etc.). */
const MARKERS: Array<{ file: string; kind: ProjectKind }> = [
  { file: "bun.lock", kind: "bun" },
  { file: "bun.lockb", kind: "bun" },
  { file: "package.json", kind: "node" },
  { file: "go.mod", kind: "go" },
  { file: "pyproject.toml", kind: "python" },
  { file: "requirements.txt", kind: "python" },
  { file: "Cargo.toml", kind: "rust" },
  { file: ".git", kind: "git" },
];

export interface ProjectInfo {
  root: string;
  name: string;
  kind: ProjectKind;
}

export class ProjectService {
  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discover the project root from a starting directory, walking up until a
   * marker is found or the filesystem root is reached.
   *
   * Marker checks per directory run in parallel (Promise.all); precedence
   * between markers follows MARKERS order (see above).
   *
   * Symlink policy (documented): paths are LEXICAL — resolve() is used, not
   * realpath(). Marker probing follows symlinks at the filesystem level
   * (access()), and a symlinked start directory yields the symlink's path
   * as root. This is intentional: the root is what the user navigated to.
   */
  async discover(startDir = process.cwd()): Promise<ProjectInfo> {
    let dir = resolve(startDir);
    for (;;) {
      const hits = await Promise.all(MARKERS.map((m) => this.exists(join(dir, m.file))));
      const idx = hits.findIndex(Boolean);
      if (idx >= 0) return { root: dir, name: basename(dir), kind: MARKERS[idx]!.kind };
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
    return { root: resolve(startDir), name: basename(resolve(startDir)), kind: "unknown" };
  }

  /** Resolve a path relative to a known project root. */
  relative(root: string, path: string): string {
    return resolve(root, path);
  }
}
