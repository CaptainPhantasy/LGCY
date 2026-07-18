/**
 * Append-only JSONL session store. Each session is one .jsonl file under the
 * sessions directory; every line is an independently-parseable record tagged
 * with a schema version so future migrations can transform old lines at load.
 *
 * Crash-safety: appends are atomic per-line (one write + newline). A torn final
 * line is skipped on load rather than corrupting the session. No secrets are
 * ever written — append payloads are scrubbed at the persistence boundary.
 */

import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { scrubSecrets } from "../core/secrets";

// Re-exported for backward compatibility; the implementation lives in core.
export { scrubSecrets } from "../core/secrets";

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
  /** True when the persistence-boundary scrubber modified the payload. */
  redacted?: boolean;
}

export interface LoadedSession {
  sessionId: string;
  meta: SessionMeta;
  schemaVersion: number;
  entries: SessionEntry[];
}

/** A migration transforms a raw parsed line from an old schema version upward. */
export type Migration = (line: Record<string, unknown>) => Record<string, unknown>;
export type SecretScrubber = (data: unknown) => unknown;

interface StoreOptions {
  baseDir?: string;
  migrations?: Map<number, Migration>;
  scrubber?: SecretScrubber;
}

export class SessionStore {
  readonly #baseDir: string;
  readonly #migrations: Map<number, Migration>;
  readonly #scrubber: SecretScrubber;
  /**
   * Highest known seq per session, cached so append() is O(1) instead of
   * re-reading the whole JSONL file per write. The cache is per-instance:
   * appends from OTHER processes are not tracked (documented limitation).
   */
  readonly #nextSeq = new Map<string, number>();

  constructor(opts: StoreOptions = {}) {
    this.#baseDir = opts.baseDir ?? join(homedir(), ".lgcy", "sessions");
    this.#migrations = opts.migrations ?? new Map();
    this.#scrubber = opts.scrubber ?? scrubSecrets;
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
    this.#nextSeq.set(sessionId, 0);
    return path;
  }

  /** Append an entry. Returns the assigned monotonic sequence number. */
  async append(sessionId: string, type: string, data: unknown): Promise<number> {
    let seq = this.#nextSeq.get(sessionId);
    if (seq === undefined) {
      const { entries } = await this.load(sessionId).catch(() => ({
        entries: [] as SessionEntry[],
      }));
      seq = entries.length > 0 ? entries[entries.length - 1]!.seq + 1 : 0;
    }
    const scrubbedData = this.#scrubber(data);
    const line: Record<string, unknown> = {
      v: CURRENT_SCHEMA_VERSION,
      kind: "entry" as const,
      sessionId,
      seq,
      timestamp: Date.now(),
      type,
      data: scrubbedData,
    };
    // Record whether the scrubber modified the payload so consumers can tell
    // "user passed clean data" apart from "the store redacted something".
    if (!jsonEqual(data, scrubbedData)) line.redacted = true;
    await appendFile(this.pathFor(sessionId), `${JSON.stringify(line)}\n`, "utf-8");
    this.#nextSeq.set(sessionId, seq + 1);
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
        const entry: SessionEntry = {
          seq: parsed.seq as number,
          timestamp: parsed.timestamp as number,
          type: parsed.type as string,
          data: parsed.data,
        };
        if (parsed.redacted === true) entry.redacted = true;
        entries.push(entry);
      }
    }
    if (!meta) throw new Error(`session ${sessionId}: missing or no header`);
    const loaded = { sessionId, meta, schemaVersion, entries };
    // Keep the seq cache at least as high as anything observed on disk.
    if (entries.length > 0) {
      const hi = entries[entries.length - 1]!.seq + 1;
      if ((this.#nextSeq.get(sessionId) ?? 0) < hi) this.#nextSeq.set(sessionId, hi);
    }
    return loaded;
  }

  /**
   * Summarize every persisted session (id, meta, entry count). Header-only
   * scan: only the FIRST line of each file is JSON.parsed; entry counts come
   * from a line count, so listing stays fast even with many long sessions.
   */
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
      const raw = await readFile(path, "utf-8").catch(() => null);
      if (raw === null) continue;
      const nl = raw.indexOf("\n");
      const headerLine = (nl === -1 ? raw : raw.slice(0, nl)).trim();
      let meta: SessionMeta | undefined;
      try {
        const parsed = this.#migrate(JSON.parse(headerLine) as Record<string, unknown>);
        if (parsed.kind === "header") meta = parsed.meta as SessionMeta;
      } catch {
        // Unparseable header — skip this session file.
      }
      if (!meta) continue;
      let entryCount = 0;
      for (const line of raw.split("\n")) {
        // Count only lines that look like JSON records — torn/garbage lines
        // from a crash mid-write don't inflate the count.
        if (line.trimStart().startsWith("{")) entryCount++;
      }
      entryCount -= 1; // subtract the header line
      const st = await stat(path).catch(() => ({ mtimeMs: 0 }));
      out.push({ sessionId, meta, entryCount, mtimeMs: st.mtimeMs });
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

/** Structural equality via JSON; unstringifiable data compares as unequal. */
function jsonEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

