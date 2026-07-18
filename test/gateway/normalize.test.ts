import { describe, expect, test } from "bun:test";
import type { UnifiedStreamEvent } from "../../src/core/contracts";
import { AnthropicStreamNormalizer, OpenAiStreamNormalizer } from "../../src/gateway/normalize";

const opts = { requestId: "req-1", providerId: "test-provider", now: () => 0 };

function feed(
  n: OpenAiStreamNormalizer | AnthropicStreamNormalizer,
  events: Array<{ event?: string; data: string }>,
): UnifiedStreamEvent[] {
  const out: UnifiedStreamEvent[] = [];
  for (const e of events) out.push(...n.handle({ data: e.data, ...(e.event ? { event: e.event } : {}) }));
  out.push(...n.close());
  return out;
}

function assertMonotonic(events: UnifiedStreamEvent[]) {
  events.forEach((e, i) => expect(e.sequence).toBe(i));
}

describe("OpenAiStreamNormalizer", () => {
  test("text stream normalizes to start/deltas/usage/complete", () => {
    const events = feed(new OpenAiStreamNormalizer(opts), [
      { data: '{"id":"c1","model":"gpt-x","choices":[{"delta":{"role":"assistant","content":""}}]}' },
      { data: '{"id":"c1","choices":[{"delta":{"content":"Hel"}}]}' },
      { data: '{"id":"c1","choices":[{"delta":{"content":"lo"}}]}' },
      { data: '{"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}' },
      { data: "[DONE]" },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "response-start",
      "text-delta",
      "text-delta",
      "usage",
      "response-complete",
    ]);
    assertMonotonic(events);
    expect(events[0]!.model).toBe("gpt-x");
    expect((events[1]!.data as any).text).toBe("Hel");
    expect((events[3]!.data as any).totalTokens).toBe(7);
    expect((events[4]!.data as any).finishReason).toBe("stop");
  });

  test("tool-call stream accumulates arguments and completes at [DONE]", () => {
    const events = feed(new OpenAiStreamNormalizer(opts), [
      { data: '{"id":"c2","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"read_file","arguments":""}}]}}]}' },
      { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}' },
      { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}],"usage":null}' },
      { data: '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}' },
      { data: "[DONE]" },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response-start",
      "tool-call-start",
      "tool-call-delta",
      "tool-call-delta",
      "tool-call-complete",
      "response-complete",
    ]);
    const complete = events.find((e) => e.type === "tool-call-complete")!.data as any;
    expect(complete.id).toBe("call_9");
    expect(complete.name).toBe("read_file");
    expect(JSON.parse(complete.arguments)).toEqual({ path: "a.ts" });
    assertMonotonic(events);
  });

  test("malformed JSON emits stream-parser error, exactly one terminal event", () => {
    const events = feed(new OpenAiStreamNormalizer(opts), [
      { data: '{"id":"c3","choices":[{"delta":{"content":"a"}}]}' },
      { data: "{not json" },
      { data: '{"choices":[{"delta":{"content":"ignored-after-error"}}]}' },
      { data: "[DONE]" },
    ]);
    const terminal = events.filter((e) => e.type === "error" || e.type === "response-complete");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe("error");
    expect((terminal[0]!.data as any).source).toBe("stream-parser");
  });

  test("stream ending without [DONE] yields exactly one error terminal", () => {
    const events = feed(new OpenAiStreamNormalizer(opts), [
      { data: '{"id":"c4","choices":[{"delta":{"content":"partial"}}]}' },
    ]);
    expect(events.at(-1)!.type).toBe("error");
    expect((events.at(-1)!.data as any).message).toContain("without a completion");
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });
});

describe("AnthropicStreamNormalizer", () => {
  test("text stream with usage normalizes correctly", () => {
    const events = feed(new AnthropicStreamNormalizer(opts), [
      { event: "message_start", data: '{"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":10}}}' },
      { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' },
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}' },
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}' },
      { event: "content_block_stop", data: '{"type":"content_block_stop","index":0}' },
      { event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}' },
      { event: "message_stop", data: '{"type":"message_stop"}' },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "response-start",
      "text-delta",
      "text-delta",
      "usage",
      "response-complete",
    ]);
    expect(events[0]!.model).toBe("claude-x");
    expect((events[3]!.data as any)).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect((events[4]!.data as any).finishReason).toBe("end_turn");
    assertMonotonic(events);
  });

  test("tool_use block start/delta/stop maps to tool-call events", () => {
    const events = feed(new AnthropicStreamNormalizer(opts), [
      { event: "message_start", data: '{"type":"message_start","message":{"id":"m2","model":"claude-x"}}' },
      { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"bash"}}' },
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}' },
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}' },
      { event: "content_block_stop", data: '{"type":"content_block_stop","index":0}' },
      { event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}' },
      { event: "message_stop", data: '{"type":"message_stop"}' },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response-start",
      "tool-call-start",
      "tool-call-delta",
      "tool-call-delta",
      "tool-call-complete",
      "response-complete",
    ]);
    const complete = events.find((e) => e.type === "tool-call-complete")!.data as any;
    expect(complete).toEqual({ id: "tu_1", name: "bash", arguments: '{"cmd":"ls"}' });
  });

  test("provider error event preserves message and terminates", () => {
    const events = feed(new AnthropicStreamNormalizer(opts), [
      { event: "message_start", data: '{"type":"message_start","message":{"id":"m3","model":"claude-x"}}' },
      { event: "error", data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
    ]);
    expect(events.at(-1)!.type).toBe("error");
    expect((events.at(-1)!.data as any).source).toBe("provider");
    expect((events.at(-1)!.data as any).message).toBe("Overloaded");
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  test("ping is dropped; unknown events emit a structured warning", () => {
    const events = feed(new AnthropicStreamNormalizer(opts), [
      { event: "ping", data: '{"type":"ping"}' },
      { event: "message_start", data: '{"type":"message_start","message":{"id":"m4","model":"claude-x"}}' },
      { event: "wat", data: '{"type":"wat"}' },
      { event: "message_stop", data: '{"type":"message_stop"}' },
    ]);
    expect(events.map((e) => e.type)).toEqual(["response-start", "warning", "response-complete"]);
    const warning = events[1]!;
    expect((warning.data as { kind: string }).kind).toBe("unknown-event");
    expect((warning.data as { eventType: string }).eventType).toBe("wat");
  });
});

describe("BaseNormalizer (#5, #6, #26, #48)", () => {
  test("non-canonical error envelope terminates with provider error (#5)", () => {
    const n = new AnthropicStreamNormalizer({ ...opts, now: () => 0 });
    const ev = n.handle({ event: "request_error", data: '{"type":"request_error","error":{"message":"boom"}}' });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("error");
    expect((ev[0]!.data as Record<string, unknown>).message).toContain("boom");
  });
  test("error-like type with payload.error terminates (#5)", () => {
    const n = new AnthropicStreamNormalizer({ ...opts, now: () => 0 });
    const ev = n.handle({ event: "weird", data: '{"type":"weird","error":{"message":"x"}}' });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("error");
    expect((ev[0]!.data as Record<string, unknown>).source).toBe("provider");
  });
  test("malformed JSON produces exactly one terminal (#6)", () => {
    const n = new OpenAiStreamNormalizer({ ...opts, now: () => 0 });
    expect(n.handle({ event: "x", data: "not json" }).map((e) => e.type)).toEqual(["error"]);
    expect(n.terminated).toBe(true);
    expect(n.handle({ event: "x", data: "still not json" })).toEqual([]);
  });
  test("elapsedMs clamped at zero with non-monotonic clock (#26)", () => {
    let clock = 100;
    const n = new OpenAiStreamNormalizer({ ...opts, now: () => clock });
    clock = 50; // went backwards
    const events = n.handle({ event: "x", data: '{"id":"c1","model":"m","choices":[{"delta":{"content":"a"}}]}' });
    // The response-start also fires on first handle; filter for text-delta
    const text = events.find((e) => e.type === "text-delta")!;
    expect(text.elapsedMs).toBe(0);
  });
  test("close() is idempotent — second call returns [] (#48)", () => {
    const n = new OpenAiStreamNormalizer({ ...opts, now: () => 0 });
    expect(n.close()).toHaveLength(1); // terminal event
    expect(n.close()).toEqual([]); // already terminated
  });
});
