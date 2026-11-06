/**
 * Gateway relay — the single orchestration point that turns a UnifiedChatRequest
 * into a stream of UnifiedStreamEvents. It owns no state between requests and
 * depends only on WHATWG fetch/streams (portable to Node and Bun).
 *
 * Error taxonomy is preserved end to end: every failure mode is mapped to an
 * UpstreamError.source and emitted through the normalizer so the stream always
 * carries exactly one terminal with monotonic sequence numbers.
 */

import type {
  CredentialReference,
  ProviderConfiguration,
  SecretResolver,
  UnifiedChatRequest,
  UnifiedStreamEvent,
  UpstreamError,
} from "../core/contracts";
import { ALWAYS_SECRET_KEY_RE, GENERIC_SECRET_KEY_RE, looksLikeSecret, scrubString } from "../core/secrets";
import { createNormalizer, type Normalizer } from "./normalize";
import { SseParser } from "./sse";
import { ProviderRegistry, authHeaders, completionUrl } from "./providers";
import { toAnthropicBody, toOpenAiBody } from "./translate";

export type { SecretResolver };
export type FetchImpl = typeof globalThis.fetch;

export interface RelayCallOptions {
  /** Resolves a credential reference to its secret at request time only. */
  secretResolver: SecretResolver;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchImpl;
  /** Caller-controlled abort (user cancel). */
  signal?: AbortSignal;
  /** Stable request id; generated if omitted. */
  requestId?: string;
  /** Monotonic clock; defaults to Date.now. */
  now?: () => number;
}

const MAX_ERROR_BODY_BYTES = 8192;

/**
 * Best-effort redaction of common secret shapes in an upstream error body.
 * When the body is JSON it is parsed and redacted structurally (key-name
 * aware, escape-safe); non-JSON text falls back to regex patterns.
 */
function redactBody(text: string, contentType?: string): string {
  const limited =
    text.length > MAX_ERROR_BODY_BYTES
      ? text.slice(0, MAX_ERROR_BODY_BYTES) + "…[truncated]"
      : text;
  if (contentType && /\bjson\b/i.test(contentType)) {
    try {
      return JSON.stringify(redactValue(JSON.parse(limited)));
    } catch {
      // Not actually parseable — fall through to the regex path.
    }
  }
  return scrubString(limited).replace(
    /("(?:api[_-]?key|key|token|authorization)"\s*:\s*")[^"]+"/gi,
    '$1[redacted]"',
  );
}

/** Recursive structured redactor for parsed JSON error bodies. */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ALWAYS_SECRET_KEY_RE.test(k)) out[k] = "[redacted]";
      else if (GENERIC_SECRET_KEY_RE.test(k) && looksLikeSecret(v)) out[k] = "[redacted]";
      else out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

export class GatewayRelay {
  readonly #registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.#registry = registry;
  }

  async *stream(
    req: UnifiedChatRequest,
    opts: RelayCallOptions,
  ): AsyncGenerator<UnifiedStreamEvent> {
    const requestId = opts.requestId ?? crypto.randomUUID();
    const now = opts.now ?? Date.now;

    // Resolve provider configuration.
    let config: ProviderConfiguration;
    try {
      config = this.#registry.get(req.providerId);
    } catch (e) {
      yield {
        type: "error",
        requestId,
        sequence: 0,
        providerId: req.providerId,
        elapsedMs: 0,
        data: {
          source: "local-config",
          message: e instanceof Error ? e.message : String(e),
          providerId: req.providerId,
          requestId,
        } satisfies UpstreamError,
      };
      return;
    }

    const normalizer = createNormalizer(config.dialect, {
      requestId,
      providerId: config.id,
      now,
    });
    const fail = (err: UpstreamError): UnifiedStreamEvent[] => normalizer.terminateWithError(err);

    // Short-circuit when the caller's signal is already aborted: emit an
    // explicit cancelled terminal without touching the network, so the
    // lifecycle shows a requestAbort transition instead of a transport error.
    if (opts.signal?.aborted) {
      for (const ev of fail({
        source: "cancelled",
        message: "request aborted before dispatch",
        providerId: config.id,
        requestId,
      })) yield ev;
      return;
    }

    // Translate the unified request to the provider wire body.
    let body: Record<string, unknown>;
    try {
      body = config.dialect === "anthropic" ? toAnthropicBody(req) : toOpenAiBody(req);
    } catch (e) {
      for (const ev of fail({
        source: "local-validation",
        message: e instanceof Error ? e.message : String(e),
        providerId: config.id,
        requestId,
      })) yield ev;
      return;
    }

    // Resolve the secret at request time; never persisted.
    let secret: string;
    let proxySecret: string | undefined;
    try {
      // Keyless endpoints (e.g. local Ollama) send no Authorization header.
      secret = config.apiKeyReference.kind === "none" ? "" : await opts.secretResolver(config.apiKeyReference);
      if (config.proxyAuth) {
        // Best-effort: a missing proxy credential only omits the header.
        try {
          proxySecret = await opts.secretResolver(config.proxyAuth.reference);
        } catch {
          proxySecret = undefined;
        }
      }
    } catch (e) {
      for (const ev of fail({
        source: "local-config",
        message: `failed to resolve credential: ${e instanceof Error ? e.message : String(e)}`,
        providerId: config.id,
        requestId,
      })) yield ev;
      return;
    }

    const url = completionUrl(config);
    const headers = authHeaders(config, secret, proxySecret);

    // Combine caller abort with the per-provider timeout into one signal.
    const userAborted = () => opts.signal?.aborted === true;
    let signal: AbortSignal | undefined = opts.signal;
    if (config.requestTimeoutMs !== undefined) {
      const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
      signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
    }

    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      const source: UpstreamError["source"] = userAborted()
        ? "cancelled"
        : isAbortError(e)
          ? "timeout"
          : "gateway-transport";
      for (const ev of fail({
        source,
        message: e instanceof Error ? e.message : String(e),
        providerId: config.id,
        requestId,
      })) yield ev;
      return;
    }

    // Non-2xx: preserve the exact upstream status, content-type, and body.
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      for (const ev of fail({
        source: "provider",
        status: resp.status,
        contentType: resp.headers.get("content-type") ?? undefined,
        body: redactBody(text, resp.headers.get("content-type") ?? undefined),
        message: `provider responded ${resp.status}`,
        providerId: config.id,
        requestId,
      })) yield ev;
      return;
    }

    // No body is a transport contract violation.
    if (!resp.body) {
      for (const ev of fail({
        source: "gateway-transport",
        message: "provider response had no body",
        providerId: config.id,
        requestId,
      })) yield ev;
      return;
    }

    // Pipe the byte stream through the SSE parser → normalizer → unified events.
    // userAborted is polled between reads AND between normalized events so a
    // caller cancel takes effect even when bytes are already buffered.
    yield* this.#pipe(
      resp.body,
      normalizer,
      () => (userAborted() ? "cancelled" : "gateway-transport"),
      config.id,
      requestId,
      userAborted,
    );
  }

  async *#pipe(
    body: ReadableStream<Uint8Array>,
    normalizer: Normalizer,
    readErrorSource: () => UpstreamError["source"],
    providerId: string,
    requestId: string,
    isAborted: () => boolean,
  ): AsyncGenerator<UnifiedStreamEvent> {
    const parser = new SseParser();
    const reader = body.getReader();
    const abortEvents = (): UnifiedStreamEvent[] =>
      normalizer.terminateWithError({
        source: "cancelled",
        message: "request aborted by caller",
        providerId,
        requestId,
      });
    try {
      while (true) {
        if (isAborted()) {
          for (const ev of abortEvents()) yield ev;
          return;
        }
        let readResult: IteratorResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (e) {
          const source = readErrorSource();
          for (const ev of normalizer.terminateWithError({
            source,
            message: e instanceof Error ? e.message : String(e),
            providerId,
            requestId,
          })) yield ev;
          return;
        }
        if (readResult.done) {
          // The stream may have been closed by a concurrent abort; check
          // before proceeding to parser.close() so the terminal event
          // says "cancelled" instead of a generic stream failure.
          if (isAborted()) {
            for (const ev of abortEvents()) yield ev;
            return;
          }
          break;
        }
        for (const sseEvent of parser.push(readResult.value)) {
          if (normalizer.terminated) break;
          if (isAborted()) {
            for (const ev of abortEvents()) yield ev;
            return;
          }
          for (const ev of normalizer.handle(sseEvent)) yield ev;
        }
        if (normalizer.terminated) return;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }

    // Flush any final unterminated SSE event, then guarantee the terminal.
    for (const sseEvent of parser.close()) {
      if (normalizer.terminated) break;
      for (const ev of normalizer.handle(sseEvent)) yield ev;
    }
    for (const ev of normalizer.close()) yield ev;
  }
}
