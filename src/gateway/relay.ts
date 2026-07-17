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
  UnifiedChatRequest,
  UnifiedStreamEvent,
  UpstreamError,
} from "../core/contracts";
import { createNormalizer, type Normalizer } from "./normalize";
import { SseParser } from "./sse";
import { ProviderRegistry, authHeaders, completionUrl } from "./providers";
import { toAnthropicBody, toOpenAiBody } from "./translate";

export type SecretResolver = (ref: CredentialReference) => Promise<string>;
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

/** Best-effort redaction of common secret shapes in an upstream error body. */
function redactBody(text: string): string {
  const limited =
    text.length > MAX_ERROR_BODY_BYTES
      ? text.slice(0, MAX_ERROR_BODY_BYTES) + "…[truncated]"
      : text;
  return limited
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/("(?:api[_-]?key|key|token|authorization)"\s*:\s*")[^"]+"/gi, '$1[redacted]"');
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
    try {
      secret = await opts.secretResolver(config.apiKeyReference);
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
    const headers = authHeaders(config, secret);

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
        body: redactBody(text),
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
    yield* this.#pipe(resp.body, normalizer, () => {
      // Determine the cause when the read itself throws.
      const source: UpstreamError["source"] = userAborted()
        ? "cancelled"
        : "gateway-transport";
      return source;
    }, config.id, requestId);
  }

  async *#pipe(
    body: ReadableStream<Uint8Array>,
    normalizer: Normalizer,
    readErrorSource: () => UpstreamError["source"],
    providerId: string,
    requestId: string,
  ): AsyncGenerator<UnifiedStreamEvent> {
    const parser = new SseParser();
    const reader = body.getReader();
    try {
      while (true) {
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
        if (readResult.done) break;
        for (const sseEvent of parser.push(readResult.value)) {
          if (normalizer.terminated) break;
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
