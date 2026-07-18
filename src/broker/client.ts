/**
 * Auth-broker client — resolves credential references into request-time secrets
 * by talking to the local omp auth-broker (127.0.0.1:17384). Secrets are never
 * cached beyond the snapshot's rotation window and never persisted to disk.
 *
 * Wire shape (from the broker's zod schemas, cycle 1 discovery):
 *   snapshot → { generation, generatedAt, serverNowMs, refresher, credentials[] }
 *   entry    → { id, provider, credential, identityKey, rotatesInMs }
 *   credential → { type: "oauth", access, refresh:"__remote__", expires, ... }
 *               | { type: "api_key", key }
 */

export class BrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerError";
  }
}

/**
 * Credential payload as it appears in a broker snapshot. The shape is
 * validated and stripped of unknown fields at parse time (see parseSnapshot)
 * so unexpected broker fields are never held in memory.
 */
export interface BrokerSnapshotCredential {
  type: "oauth" | "api_key";
  /** OAuth access token — the request-time secret. */
  access?: string;
  /** API-key value — the request-time secret. */
  key?: string;
  /** OAuth refresh marker (e.g. "__remote__"); informational only. */
  refresh?: string;
  /** OAuth expiry epoch ms; informational only. */
  expires?: number;
}

export interface BrokerSnapshotEntry {
  id: number;
  provider: string;
  credential: BrokerSnapshotCredential;
  identityKey: string | null;
  rotatesInMs: number | null;
}

export interface BrokerSnapshot {
  generation: number;
  generatedAt: number;
  serverNowMs: number;
  refresher: {
    enabled: boolean;
    intervalMs: number;
    skewMs: number;
    nextSweepInMs: number;
  };
  credentials: BrokerSnapshotEntry[];
}

export type FetchImpl = typeof globalThis.fetch;

export interface BrokerClientOptions {
  /** Broker base URL; defaults to http://127.0.0.1:17384 */
  baseUrl?: string;
  /** Bearer token; if omitted, read lazily from tokenFile. */
  token?: string;
  /** Path to the bearer token file; defaults to ~/.omp/auth-broker.token */
  tokenFile?: string;
  fetchImpl?: FetchImpl;
  /** Monotonic clock for cache TTL; defaults to Date.now. */
  now?: () => number;
  /** Default cache TTL when a credential has no rotatesInMs; default 5 min. */
  defaultTtlMs?: number;
  /** Floor for cache TTL; default 1 s. */
  minTtlMs?: number;
  /** Hard timeout for health() probes; default 2 s. */
  healthTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:17384";
const DEFAULT_TTL_MS = 5 * 60_000;
const MIN_TTL_MS = 1_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_TOKEN_FILE = `${process.env.HOME ?? ""}/.omp/auth-broker.token`;

interface CachedSnapshot {
  snapshot: BrokerSnapshot;
  fetchedAt: number;
}

/** Extract the request-time secret from a snapshot credential payload. */
export function extractSecret(cred: BrokerSnapshotCredential): string {
  if (cred.type === "api_key") {
    if (typeof cred.key === "string" && cred.key.length > 0) return cred.key;
    throw new BrokerError("api_key credential has empty key");
  }
  if (cred.type === "oauth") {
    if (typeof cred.access === "string" && cred.access.length > 0) return cred.access;
    throw new BrokerError("oauth credential has empty access token");
  }
  throw new BrokerError(`unknown credential type: ${String(cred.type)}`);
}

/**
 * Validate a raw broker snapshot payload and strip unknown fields. Only the
 * documented wire shape survives; unexpected broker fields (which could carry
 * sensitive values) are dropped here rather than held in memory as `unknown`.
 */
export function parseSnapshot(json: unknown): BrokerSnapshot {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new BrokerError("broker snapshot: payload is not an object");
  }
  const j = json as Record<string, unknown>;
  for (const field of ["generation", "generatedAt", "serverNowMs"] as const) {
    if (typeof j[field] !== "number") {
      throw new BrokerError(`broker snapshot: ${field} missing or not a number`);
    }
  }
  const refresher = parseRefresher(j.refresher);
  if (!Array.isArray(j.credentials)) {
    throw new BrokerError("broker snapshot: credentials missing or not an array");
  }
  return {
    generation: j.generation as number,
    generatedAt: j.generatedAt as number,
    serverNowMs: j.serverNowMs as number,
    refresher,
    credentials: j.credentials.map(parseEntry),
  };
}

function parseRefresher(raw: unknown): BrokerSnapshot["refresher"] {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    intervalMs: typeof r.intervalMs === "number" ? r.intervalMs : 0,
    skewMs: typeof r.skewMs === "number" ? r.skewMs : 0,
    nextSweepInMs: typeof r.nextSweepInMs === "number" ? r.nextSweepInMs : 0,
  };
}

function parseEntry(raw: unknown, index: number): BrokerSnapshotEntry {
  if (!raw || typeof raw !== "object") {
    throw new BrokerError(`broker snapshot: credential[${index}] is not an object`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.provider !== "string" || e.provider.length === 0) {
    throw new BrokerError(`broker snapshot: credential[${index}].provider missing`);
  }
  const c = (e.credential ?? {}) as Record<string, unknown>;
  if (c.type !== "oauth" && c.type !== "api_key") {
    throw new BrokerError(`broker snapshot: credential[${index}].type unknown: ${String(c.type)}`);
  }
  const credential: BrokerSnapshotCredential = { type: c.type };
  if (typeof c.access === "string") credential.access = c.access;
  if (typeof c.key === "string") credential.key = c.key;
  if (typeof c.refresh === "string") credential.refresh = c.refresh;
  if (typeof c.expires === "number") credential.expires = c.expires;
  return {
    id: typeof e.id === "number" ? e.id : index,
    provider: e.provider,
    credential,
    identityKey: typeof e.identityKey === "string" ? e.identityKey : null,
    rotatesInMs: typeof e.rotatesInMs === "number" ? e.rotatesInMs : null,
  };
}

export class BrokerClient {
  readonly #baseUrl: string;
  readonly #tokenFile: string;
  readonly #fetch: FetchImpl;
  readonly #now: () => number;
  readonly #defaultTtlMs: number;
  readonly #minTtlMs: number;
  readonly #healthTimeoutMs: number;
  /** Constructor-supplied token. Immutable for the client's lifetime. */
  readonly #providedToken: string | undefined;
  /** Cache of the token FILE read — never aliases #providedToken. */
  #fileToken: string | undefined;
  #cache: CachedSnapshot | undefined;

  constructor(opts: BrokerClientOptions = {}) {
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#providedToken = opts.token;
    this.#tokenFile = opts.tokenFile ?? DEFAULT_TOKEN_FILE;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#now = opts.now ?? Date.now;
    this.#defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#minTtlMs = opts.minTtlMs ?? MIN_TTL_MS;
    this.#healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  async #token(): Promise<string> {
    if (this.#providedToken !== undefined) return this.#providedToken;
    if (this.#fileToken !== undefined) return this.#fileToken;
    const text = await Bun.file(this.#tokenFile).text().catch(() => {
      throw new BrokerError(`cannot read broker token at ${this.#tokenFile}`);
    });
    const trimmed = text.trim();
    if (!trimmed) throw new BrokerError(`broker token file is empty: ${this.#tokenFile}`);
    this.#fileToken = trimmed;
    return trimmed;
  }

  /**
   * Drop the cached token-file value so the next request re-reads the file
   * from disk. Call this when the broker rotates its token file while this
   * process is running. The constructor-supplied token (if any) is
   * unaffected and always wins over the file.
   */
  reloadToken(): void {
    this.#fileToken = undefined;
  }

  /** Liveness probe — unauthenticated, bounded by healthTimeoutMs. */
  async health(): Promise<boolean> {
    let resp: Response;
    try {
      resp = await this.#fetch(`${this.#baseUrl}/v1/healthz`, {
        signal: AbortSignal.timeout(this.#healthTimeoutMs),
      });
    } catch (e) {
      // A hung/slow broker reads as offline; a hard network error propagates
      // so callers can distinguish "offline" from "unknown".
      if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return false;
      throw e;
    }
    if (!resp.ok) return false;
    try {
      const body = (await resp.json()) as { ok?: boolean };
      return body.ok === true;
    } catch {
      return false;
    }
  }

  /** Fetch the full credential snapshot, cached until rotation. */
  async snapshot(forceRefresh = false): Promise<BrokerSnapshot> {
    if (this.#cache && !forceRefresh && this.#now() - this.#cache.fetchedAt < this.#ttlFor(this.#cache.snapshot)) {
      return this.#cache.snapshot;
    }
    const token = await this.#token();
    const resp = await this.#fetch(`${this.#baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (resp.status === 401) {
      // The broker rejected our token — drop any cached file token so the
      // next call re-reads the (presumably rotated) token file.
      this.#fileToken = undefined;
      throw new BrokerError("broker rejected token (401)");
    }
    if (!resp.ok) throw new BrokerError(`broker snapshot failed: ${resp.status}`);
    const json = parseSnapshot(await resp.json());
    // fetchedAt is stamped AFTER the fetch completes so the TTL window is
    // measured from receipt, not from request dispatch.
    this.#cache = { snapshot: json, fetchedAt: this.#now() };
    return json;
  }

  /**
   * Resolve a provider name to its request-time secret. If the specific
   * credential's own rotation window (rotatesInMs) has elapsed since the
   * snapshot was fetched, the snapshot is force-refreshed once before use —
   * per-credential rotation is enforced even when the snapshot-wide TTL
   * (the minimum across credentials) has not yet expired.
   */
  async resolve(provider: string): Promise<string> {
    let snap = await this.snapshot();
    let entry = snap.credentials.find((c) => c.provider === provider);
    if (!entry) throw new BrokerError(`provider "${provider}" not found in broker snapshot`);
    if (this.#entryStale(entry)) {
      snap = await this.snapshot(true);
      entry = snap.credentials.find((c) => c.provider === provider);
      if (!entry) throw new BrokerError(`provider "${provider}" not found in broker snapshot`);
    }
    return extractSecret(entry.credential);
  }

  /** Drop the cached snapshot so the next call re-fetches. */
  invalidate(): void {
    this.#cache = undefined;
  }

  /** True when this credential's own rotation window has elapsed in-cache. */
  #entryStale(entry: BrokerSnapshotEntry): boolean {
    if (!this.#cache || entry.rotatesInMs == null || entry.rotatesInMs <= 0) return false;
    return this.#now() - this.#cache.fetchedAt >= entry.rotatesInMs;
  }

  #ttlFor(snapshot: BrokerSnapshot): number {
    const rotates = snapshot.credentials
      .map((c) => c.rotatesInMs)
      .filter((r): r is number => typeof r === "number" && r > 0);
    const min = rotates.length > 0 ? Math.min(...rotates) : this.#defaultTtlMs;
    return Math.max(this.#minTtlMs, Math.min(min, this.#defaultTtlMs));
  }
}
