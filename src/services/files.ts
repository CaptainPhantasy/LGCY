/**
 * File service — thin, portable wrappers over the runtime filesystem. Reads
 * use Bun.file (fast path); writes and directory walks use node:fs/promises
 * for unambiguous semantics. All paths are resolved against a workspace root
 * to prevent escaping the project boundary.
 */

import { readFile, writeFile, readdir, mkdir, stat, access } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";

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
    const abs = isAbsolute(path) ? path : join(this.#root, path);
    const rel = relative(this.#root, abs);
    if (rel.startsWith("..")) throw new Error(`path escapes workspace root: ${path}`);
    return abs;
  }

  async readText(path: string): Promise<string> {
    const abs = this.resolve(path);
    try {
      await access(abs);
    } catch {
      throw new FileNotFoundError(abs);
    }
    const st = await stat(abs);
    if (st.size > this.#maxRead) {
      throw new Error(`file too large (${st.size} > ${this.#maxRead} bytes): ${abs}`);
    }
    return readFile(abs, "utf-8");
  }

  async writeText(path: string, content: string): Promise<void> {
    const abs = this.resolve(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }

  async listDir(path = "."): Promise<DirEntry[]> {
    const abs = this.resolve(path);
    const names = await readdir(abs, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const de of names) {
      const fullPath = join(abs, de.name);
      let size = 0;
      try {
        size = (await stat(fullPath)).size;
      } catch {
        /* broken symlink etc. */
      }
      out.push({ name: de.name, path: fullPath, isDirectory: de.isDirectory(), size });
    }
    return out.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }
}
