/**
 * Append-only JSONL session store. Each session is one .jsonl file under the
 * sessions directory; every line is an independently-parseable record tagged
 * with a schema version so future migrations can transform old lines at load.
 *
 * Crash-safety: appends are atomic per-line (one write + newline). A torn final
 * line is skipped on load rather than corrupting the session. No secrets are
 * ever written — callers must scrub credential values before appending.
 */

import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CURRENT_SCHEMA_VERSION = 1;

export interface SessionMeta {
  title: string;
  providerId?: string;
  model?: string;
  createdAt: number;
}

export interface SessionEntry<T = unknown> {
  seq: number;
  timestamp: number;
  type: string;
  data: T;
}

export interface LoadedSession {
  sessionId: string;
  meta: SessionMeta;
  schemaVersion: number;
  entries: SessionEntry[];
}

/** A migration transforms a raw parsed line from an old schema version upward. */
export type Migration = (line: Record<string, unknown>) => Record<string, unknown>;

interface StoreOptions {
  baseDir?: string;
  migrations?: Map<number, Migration>;
}

export class SessionStore {
  readonly #baseDir: string;
  readonly #migrations: Map<number, Migration>;

  constructor(opts: StoreOptions = {}) {
    this.#baseDir = opts.baseDir ?? join(homedir(), ".lgcy", "sessions");
    this.#migrations = opts.migrations ?? new Map();
  }

  pathFor(sessionId: string): string {
    return join(this.#baseDir, `${sessionId}.jsonl`);
  }

  /** Create a new session by writing its header line. Returns the file path. */
  async create(sessionId: string, meta: SessionMeta): Promise<string> {
    await mkdir(this.#baseDir, { recursive: true });
    const path = this.pathFor(sessionId);
    const header = {
      v: CURRENT_SCHEMA_VERSION,
      kind: "header" as const,
      sessionId,
      meta,
    };
    await appendFile(path, `${JSON.stringify(header)}\n`, "utf-8");
    return path;
  }

  /** Append an entry. Returns the assigned monotonic sequence number. */
  async append(sessionId: string, type: string, data: unknown): Promise<number> {
    const { entries } = await this.load(sessionId).catch(() => ({
      entries: [] as SessionEntry[],
    }));
    const seq = entries.length > 0 ? entries[entries.length - 1]!.seq + 1 : 0;
    const line = {
      v: CURRENT_SCHEMA_VERSION,
      kind: "entry" as const,
      sessionId,
      seq,
      timestamp: Date.now(),
      type,
      data,
    };
    await appendFile(this.pathFor(sessionId), `${JSON.stringify(line)}\n`, "utf-8");
    return seq;
  }

  /** Load and replay a session, running schema migrations as needed. */
  async load(sessionId: string): Promise<LoadedSession> {
    const raw = await readFile(this.pathFor(sessionId), "utf-8");
    let meta: SessionMeta | undefined;
    let schemaVersion = CURRENT_SCHEMA_VERSION;
    const entries: SessionEntry[] = [];

    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // skip torn/malformed line — crash-safe
      }
      parsed = this.#migrate(parsed);
      schemaVersion = (parsed.v as number) ?? schemaVersion;
      if (parsed.kind === "header") {
        meta = parsed.meta as SessionMeta;
      } else if (parsed.kind === "entry") {
        entries.push({
          seq: parsed.seq as number,
          timestamp: parsed.timestamp as number,
          type: parsed.type as string,
          data: parsed.data,
        });
      }
    }
    if (!meta) throw new Error(`session ${sessionId}: missing or no header`);
    return { sessionId, meta, schemaVersion, entries };
  }

  /** Summarize every persisted session (id, meta, entry count). */
  async list(): Promise<Array<{ sessionId: string; meta: SessionMeta; entryCount: number; mtimeMs: number }>> {
    let files: string[];
    try {
      files = await readdir(this.#baseDir);
    } catch {
      return [];
    }
    const out: Array<{ sessionId: string; meta: SessionMeta; entryCount: number; mtimeMs: number }> = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionId = f.slice(0, -".jsonl".length);
      const path = this.pathFor(sessionId);
      const loaded = await this.load(sessionId).catch(() => null);
      if (!loaded) continue;
      const st = await stat(path).catch(() => ({ mtimeMs: 0 }));
      out.push({
        sessionId,
        meta: loaded.meta,
        entryCount: loaded.entries.length,
        mtimeMs: st.mtimeMs,
      });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  #migrate(line: Record<string, unknown>): Record<string, unknown> {
    const v = (line.v as number) ?? CURRENT_SCHEMA_VERSION;
    let current = v;
    let result = line;
    while (current < CURRENT_SCHEMA_VERSION) {
      const m = this.#migrations.get(current);
      if (!m) break; // no migration registered — leave as-is
      result = m(result);
      current++;
    }
    return result;
  }
}

/** Scrub common secret shapes from arbitrary data before persistence. */
export function scrubSecrets(data: unknown): unknown {
  if (typeof data === "string") {
    return data
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(data)) return data.map(scrubSecrets);
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (/^(key|token|secret|password|authorization|api[_-]?key)$/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = scrubSecrets(v);
      }
    }
    return out;
  }
  return data;
}
