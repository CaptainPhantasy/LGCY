import { describe, expect, test } from "bun:test";
import type { SecretResolver, UnifiedChatRequest, UnifiedStreamEvent } from "../../src/core/contracts";
import { GatewayRelay, type FetchImpl } from "../../src/gateway/relay";
import { ProviderRegistry } from "../../src/gateway/providers";
import type { ProviderConfiguration } from "../../src/core/contracts";

const openai: ProviderConfiguration = {
  id: "openai",
  displayName: "OpenAI",
  kind: "openai",
  dialect: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyReference: { kind: "env", variable: "OPENAI_API_KEY" },
  enabled: true,
};
const anthropic: ProviderConfiguration = {
  id: "anthropic",
  displayName: "Anthropic",
  kind: "anthropic",
  dialect: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKeyReference: { kind: "env", variable: "ANTHROPIC_API_KEY" },
  enabled: true,
};

const alwaysSecret: SecretResolver = async () => "sk-test";

function req(partial: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return { providerId: "openai", model: "m", messages: [{ role: "user", content: "hi" }], stream: true, ...partial };
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function makeResponse(body: ReadableStream<Uint8Array>, status = 200, contentType = "text/event-stream"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

/** Fetch that captures the request URL/headers/body for assertions. */
function mockFetch(opts: {
  status?: number;
  contentType?: string;
  chunks?: string[];
  throwOnce?: (url: URL, init?: RequestInit) => Error | null;
}): { fetch: FetchImpl; calls: Array<{ url: URL; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: URL; headers: Record<string, string>; body: string }> = [];
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : (input as Request).url);
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const thrown = opts.throwOnce?.(url, init);
    if (thrown) throw thrown;
    if (opts.status && opts.status >= 400) {
      return new Response(opts.chunks?.join("") ?? '{"error":"nope"}', {
        status: opts.status,
        headers: { "content-type": opts.contentType ?? "application/json" },
      });
    }
    return makeResponse(sseBody(opts.chunks ?? []), opts.status, opts.contentType);
  }) as FetchImpl;
  return { fetch, calls };
}

async function collect(gen: AsyncGenerator<UnifiedStreamEvent>): Promise<UnifiedStreamEvent[]> {
  const out: UnifiedStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function errorData(ev: UnifiedStreamEvent): { source: string; message: string } {
  return ev.data as { source: string; message: string };
}

describe("GatewayRelay — happy paths", () => {
  test("OpenAI text stream pipes through SSE → normalizer", async () => {
    const { fetch, calls } = mockFetch({
      chunks: [
        'data: {"id":"c1","model":"gpt-x","choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"id":"c1","choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    const events = await collect(
      relay.stream(req(), { secretResolver: alwaysSecret, fetchImpl: fetch, requestId: "r1", now: () => 0 }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "response-start",
      "text-delta",
      "text-delta",
      "usage",
      "response-complete",
    ]);
    expect(events.every((e) => e.requestId === "r1" && e.providerId === "openai")).toBe(true);
    // monotonic sequence
    events.forEach((e, i) => expect(e.sequence).toBe(i));
    // request wire shape
    const body = JSON.parse(calls[0]!.body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.url.pathname).toBe("/v1/chat/completions");
  });

  test("Anthropic stream pipes through with system extraction + x-api-key", async () => {
    const { fetch, calls } = mockFetch({
      chunks: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":3}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ],
    });
    const relay = new GatewayRelay(new ProviderRegistry([anthropic]));
    const events = await collect(
      relay.stream(
        req({ providerId: "anthropic", messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }] }),
        { secretResolver: alwaysSecret, fetchImpl: fetch, requestId: "r1", now: () => 0 },
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      "response-start",
      "text-delta",
      "usage",
      "response-complete",
    ]);
    const body = JSON.parse(calls[0]!.body);
    expect(body.system).toBe("sys");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-test");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("GatewayRelay — error passthrough", () => {
  test("provider non-2xx preserves status, content-type, redacted body", async () => {
    const { fetch } = mockFetch({
      status: 429,
      contentType: "application/json",
      chunks: ['{"error":{"message":"rate limited","metadata":{"key":"sk-abcd1234567890"}}}'],
    });
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    const events = await collect(
      relay.stream(req(), { secretResolver: alwaysSecret, fetchImpl: fetch, requestId: "r1", now: () => 0 }),
    );
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const d = events[0]!.data as Record<string, unknown>;
    expect(d.source).toBe("provider");
    expect(d.status).toBe(429);
    expect(d.contentType).toBe("application/json");
    expect(d.body as string).toContain("rate limited");
    expect(d.body as string).not.toContain("sk-abcd1234567890");
  });

  test("translation failure → local-validation error terminal", async () => {
    const { fetch } = mockFetch({ chunks: [] });
    const relay = new GatewayRelay(new ProviderRegistry([anthropic]));
    // system-only request cannot translate (no non-system message)
    const events = await collect(
      relay.stream(
        req({ providerId: "anthropic", messages: [{ role: "system", content: "only" }] }),
        { secretResolver: alwaysSecret, fetchImpl: fetch, now: () => 0 },
      ),
    );
    expect(events).toHaveLength(1);
    expect(errorData(events[0]!).source).toBe("local-validation");
  });

  test("unknown provider → local-config error terminal", async () => {
    const { fetch } = mockFetch({ chunks: [] });
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    const events = await collect(
      relay.stream(req({ providerId: "ghost" }), { secretResolver: alwaysSecret, fetchImpl: fetch, now: () => 0 }),
    );
    expect(events).toHaveLength(1);
    expect(errorData(events[0]!).source).toBe("local-config");
  });

  test("secret resolution failure → local-config error terminal", async () => {
    const { fetch } = mockFetch({ chunks: [] });
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    const events = await collect(
      relay.stream(req(), {
        secretResolver: async () => {
          throw new Error("env var missing");
        },
        fetchImpl: fetch,
        now: () => 0,
      }),
    );
    expect(events).toHaveLength(1);
    expect(errorData(events[0]!).source).toBe("local-config");
  });

  test("fetch transport error → gateway-transport terminal", async () => {
    const { fetch } = mockFetch({
      throwOnce: () => new TypeError("fetch failed"),
    });
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    const events = await collect(
      relay.stream(req(), { secretResolver: alwaysSecret, fetchImpl: fetch, now: () => 0 }),
    );
    expect(events).toHaveLength(1);
    expect(errorData(events[0]!).source).toBe("gateway-transport");
  });

  test("user abort → cancelled terminal", async () => {
    const ac = new AbortController();
    const { fetch } = mockFetch({
      throwOnce: () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        return e;
      },
    });
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    ac.abort();
    const events = await collect(
      relay.stream(req(), { secretResolver: alwaysSecret, fetchImpl: fetch, signal: ac.signal, now: () => 0 }),
    );
    expect(events).toHaveLength(1);
    expect(errorData(events[0]!).source).toBe("cancelled");
  });

  test("truncated stream (no [DONE]) yields error terminal from close()", async () => {
    const { fetch } = mockFetch({
      chunks: ['data: {"id":"c1","model":"gpt-x","choices":[{"delta":{"content":"par"}}]}\n\n'],
    });
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    const events = await collect(
      relay.stream(req(), { secretResolver: alwaysSecret, fetchImpl: fetch, now: () => 0 }),
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response-start");
    expect(types[1]).toBe("text-delta");
    expect(types[types.length - 1]).toBe("error");
    expect(errorData(events[events.length - 1]!).source).toBe("stream-parser");
  });

  test("no response body → gateway-transport terminal", async () => {
    const fetch = (async () => new Response(null, { status: 200 })) as unknown as FetchImpl;
    const relay = new GatewayRelay(new ProviderRegistry([openai]));
    const events = await collect(
      relay.stream(req(), { secretResolver: alwaysSecret, fetchImpl: fetch, now: () => 0 }),
    );
    expect(events).toHaveLength(1);
    expect(errorData(events[0]!).source).toBe("gateway-transport");
  });
});
