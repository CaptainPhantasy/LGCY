/**
 * File service — thin, portable wrappers over the runtime filesystem. Reads
 * use Bun.file (fast path); writes and directory walks use node:fs/promises
 * for unambiguous semantics. All paths are resolved against a workspace root
 * to prevent escaping the project boundary.
 */

import { readFile, writeFile, readdir, mkdir, stat, access, realpath, rename, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname, parse, sep } from "node:path";

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`file not found: ${path}`);
    this.name = "FileNotFoundError";
  }
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface FileServiceOptions {
  /** Workspace root; relative paths are resolved under this. */
  root?: string;
  /** Max bytes to read in one call (guards against huge files). */
  maxReadBytes?: number;
}

const DEFAULT_MAX_READ = 2 * 1024 * 1024; // 2 MiB

export class FileService {
  readonly #root: string;
  readonly #maxRead: number;

  constructor(opts: FileServiceOptions = {}) {
    this.#root = resolve(opts.root ?? process.cwd());
    this.#maxRead = opts.maxReadBytes ?? DEFAULT_MAX_READ;
  }

  get root(): string {
    return this.#root;
  }

  /** Resolve a (possibly relative) path safely under the workspace root. */
  resolve(path: string): string {
    const abs = resolve(isAbsolute(path) ? path : join(this.#root, path));
    this.#assertInside(this.#root, abs, path);
    return abs;
  }

  async readText(path: string): Promise<string> {
    const abs = this.resolve(path);
    try {
      await access(abs);
    } catch {
      throw new FileNotFoundError(abs);
    }
    await this.#assertRealTargetInsideRoot(abs, path);
    const st = await stat(abs);
    if (st.size > this.#maxRead) {
      throw new Error(`file too large (${st.size} > ${this.#maxRead} bytes): ${abs}`);
    }
    return readFile(abs, "utf-8");
  }

  /**
   * Write via a temp file in the validated directory + atomic rename. This
   * closes the TOCTOU window between the realpath parent check and the
   * write: even if the parent directory is swapped for a symlink after
   * validation, rename() replaces the destination entry itself (and never
   * follows a destination symlink) within the same validated directory.
   */
  async writeText(path: string, content: string): Promise<void> {
    const abs = this.resolve(path);
    await this.#assertWritableParentInsideRoot(abs, path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.lgcy-tmp-${process.pid}-${crypto.randomUUID()}`);
    try {
      await writeFile(tmp, content, "utf-8");
      await rename(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async listDir(path = "."): Promise<DirEntry[]> {
    const abs = this.resolve(path);
    await this.#assertRealTargetInsideRoot(abs, path);
    const names = await readdir(abs, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const de of names) {
      const fullPath = join(abs, de.name);
      // stat() follows symlinks, so type/size describe the REAL target, not
      // the link. A symlink to a file inside the root reports isDirectory:
      // false with the target's size. Broken links fall back to the Dirent.
      const st = await stat(fullPath).catch(() => null);
      out.push({
        name: de.name,
        path: fullPath,
        isDirectory: st ? st.isDirectory() : de.isDirectory(),
        size: st?.size ?? 0,
      });
    }
    return out.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      const abs = this.resolve(path);
      await access(abs);
      await this.#assertRealTargetInsideRoot(abs, path);
      return true;
    } catch {
      return false;
    }
  }

  #assertInside(root: string, target: string, original: string): void {
    const rel = relative(root, target);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
    throw new Error(`path escapes workspace root: ${original}`);
  }

  async #assertRealTargetInsideRoot(abs: string, original: string): Promise<void> {
    const [realRoot, realTarget] = await Promise.all([realpath(this.#root), realpath(abs)]);
    this.#assertInside(realRoot, realTarget, original);
  }

  async #assertWritableParentInsideRoot(abs: string, original: string): Promise<void> {
    const realRoot = await realpath(this.#root);
    try {
      const realTarget = await realpath(abs);
      this.#assertInside(realRoot, realTarget, original);
      return;
    } catch {
      // Target does not exist yet; validate the nearest existing parent so a
      // symlinked parent cannot redirect new writes outside the workspace.
    }
    const realParent = await this.#realExistingAncestor(dirname(abs));
    this.#assertInside(realRoot, realParent, original);
  }

  async #realExistingAncestor(path: string): Promise<string> {
    let current = path;
    while (true) {
      try {
        return await realpath(current);
      } catch (e) {
        const parent = dirname(current);
        if (parent === current || current === parse(current).root) throw e;
        current = parent;
      }
    }
  }
}
