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

/** Credential payload as it appears in a broker snapshot. */
export interface BrokerSnapshotCredential {
  type: "oauth" | "api_key";
  /** OAuth access token — the request-time secret. */
  access?: string;
  /** API-key value — the request-time secret. */
  key?: string;
  [ext: string]: unknown;
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
}

const DEFAULT_BASE_URL = "http://127.0.0.1:17384";
const DEFAULT_TTL_MS = 5 * 60_000;
const MIN_TTL_MS = 1_000;
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

export class BrokerClient {
  readonly #baseUrl: string;
  readonly #tokenFile: string;
  readonly #fetch: FetchImpl;
  readonly #now: () => number;
  readonly #defaultTtlMs: number;
  readonly #minTtlMs: number;
  #providedToken: string | undefined;
  #cache: CachedSnapshot | undefined;

  constructor(opts: BrokerClientOptions = {}) {
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#providedToken = opts.token;
    this.#tokenFile = opts.tokenFile ?? DEFAULT_TOKEN_FILE;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#now = opts.now ?? Date.now;
    this.#defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#minTtlMs = opts.minTtlMs ?? MIN_TTL_MS;
  }

  async #token(): Promise<string> {
    if (this.#providedToken !== undefined) return this.#providedToken;
    const text = await Bun.file(this.#tokenFile).text().catch(() => {
      throw new BrokerError(`cannot read broker token at ${this.#tokenFile}`);
    });
    const trimmed = text.trim();
    if (!trimmed) throw new BrokerError(`broker token file is empty: ${this.#tokenFile}`);
    this.#providedToken = trimmed;
    return trimmed;
  }

  /** Liveness probe — unauthenticated. */
  async health(): Promise<boolean> {
    const resp = await this.#fetch(`${this.#baseUrl}/v1/healthz`);
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
    const now = this.#now();
    if (this.#cache && !forceRefresh && now - this.#cache.fetchedAt < this.#ttlFor(this.#cache.snapshot)) {
      return this.#cache.snapshot;
    }
    const token = await this.#token();
    const resp = await this.#fetch(`${this.#baseUrl}/v1/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (resp.status === 401) throw new BrokerError("broker rejected token (401)");
    if (!resp.ok) throw new BrokerError(`broker snapshot failed: ${resp.status}`);
    const json = (await resp.json()) as BrokerSnapshot;
    this.#cache = { snapshot: json, fetchedAt: now };
    return json;
  }

  /** Resolve a provider name to its request-time secret, re-fetching if stale. */
  async resolve(provider: string): Promise<string> {
    const snap = await this.snapshot();
    const entry = snap.credentials.find((c) => c.provider === provider);
    if (!entry) throw new BrokerError(`provider "${provider}" not found in broker snapshot`);
    return extractSecret(entry.credential);
  }

  /** Drop the cached snapshot so the next call re-fetches. */
  invalidate(): void {
    this.#cache = undefined;
  }

  #ttlFor(snapshot: BrokerSnapshot): number {
    const rotates = snapshot.credentials
      .map((c) => c.rotatesInMs)
      .filter((r): r is number => typeof r === "number" && r > 0);
    const min = rotates.length > 0 ? Math.min(...rotates) : this.#defaultTtlMs;
    return Math.max(this.#minTtlMs, Math.min(min, this.#defaultTtlMs));
  }
}
