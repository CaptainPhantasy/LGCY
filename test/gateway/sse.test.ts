import { describe, expect, test } from "bun:test";
import { SseParser, type SseEvent } from "../../src/gateway/sse";

const enc = new TextEncoder();

function parseAll(chunks: string[]): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(enc.encode(c)));
  out.push(...p.close());
  return out;
}

describe("SseParser", () => {
  test("single complete event", () => {
    expect(parseAll(['data: {"x":1}\n\n'])).toEqual([{ data: '{"x":1}' }]);
  });

  test("multiple events in one chunk", () => {
    const events = parseAll(["data: a\n\ndata: b\n\ndata: [DONE]\n\n"]);
    expect(events.map((e) => e.data)).toEqual(["a", "b", "[DONE]"]);
  });

  test("event split across arbitrary chunk boundaries", () => {
    const wire = 'data: {"delta":"hello world"}\n\n';
    for (let cut = 1; cut < wire.length - 1; cut++) {
      const events = parseAll([wire.slice(0, cut), wire.slice(cut)]);
      expect(events).toEqual([{ data: '{"delta":"hello world"}' }]);
    }
  });

  test("byte-at-a-time delivery", () => {
    const wire = "event: message\ndata: hi\n\n";
    const events = parseAll(wire.split(""));
    expect(events).toEqual([{ event: "message", data: "hi" }]);
  });

  test("CRLF delimiters", () => {
    expect(parseAll(["data: a\r\n\r\ndata: b\r\n\r\n"]).map((e) => e.data)).toEqual(["a", "b"]);
  });

  test("CR split across chunks does not double-terminate", () => {
    // "data: a\r" | "\n\r\n" — the LF after the chunk boundary belongs to the CR
    const events = parseAll(["data: a\r", "\n\r\ndata: b\n\n"]);
    expect(events.map((e) => e.data)).toEqual(["a", "b"]);
  });

  test("multi-line data joined with newline", () => {
    const events = parseAll(["data: line1\ndata: line2\n\n"]);
    expect(events).toEqual([{ data: "line1\nline2" }]);
  });

  test("comment heartbeats are ignored", () => {
    const events = parseAll([": ping\n\n: keepalive\ndata: real\n\n"]);
    expect(events).toEqual([{ data: "real" }]);
  });

  test("empty heartbeat events emit nothing", () => {
    expect(parseAll(["\n\n\n"])).toEqual([]);
  });

  test("event and id fields", () => {
    const events = parseAll(["event: content_block_delta\nid: 42\ndata: x\n\n"]);
    expect(events).toEqual([{ event: "content_block_delta", id: "42", data: "x" }]);
  });

  test("UTF-8 code point split across chunks", () => {
    const wire = enc.encode("data: héllo \u{1F30D}\n\n");
    // Split inside the multi-byte emoji (last 4 bytes before "\n\n")
    for (let cut = 1; cut < wire.length - 1; cut++) {
      const p = new SseParser();
      const out = [...p.push(wire.slice(0, cut)), ...p.push(wire.slice(cut)), ...p.close()];
      expect(out).toEqual([{ data: "héllo \u{1F30D}" }]);
    }
  });

  test("field with no colon treated as field name with empty value", () => {
    const events = parseAll(["data\n\n"]);
    expect(events).toEqual([{ data: "" }]);
  });

  test("colon with no space preserves value", () => {
    expect(parseAll(["data:tight\n\n"])).toEqual([{ data: "tight" }]);
  });

  test("only first leading space is stripped", () => {
    expect(parseAll(["data:  two spaces\n\n"])).toEqual([{ data: " two spaces" }]);
  });

  test("malformed lines do not crash and do not corrupt following events", () => {
    const events = parseAll(["garbage-field: whatever\nretry: 100\ndata: ok\n\n"]);
    expect(events).toEqual([{ data: "ok" }]);
  });

  test("final buffered event flushed at close without trailing blank line", () => {
    const events = parseAll(["data: tail"]);
    expect(events).toEqual([{ data: "tail" }]);
  });

  test("close is idempotent and push after close is inert", () => {
    const p = new SseParser();
    p.push(enc.encode("data: a\n\n"));
    expect(p.close()).toEqual([]);
    expect(p.close()).toEqual([]);
    expect(p.push(enc.encode("data: b\n\n"))).toEqual([]);
  });

  test("large stream: 1000 events across randomized-size chunks", () => {
    const wire = Array.from({ length: 1000 }, (_, i) => `data: ev${i}\n\n`).join("");
    const chunks: string[] = [];
    let pos = 0;
    let step = 1;
    while (pos < wire.length) {
      // deterministic pseudo-random chunk sizes 1..17
      step = (step * 7 + 3) % 17 || 1;
      chunks.push(wire.slice(pos, pos + step));
      pos += step;
    }
    const events = parseAll(chunks);
    expect(events).toHaveLength(1000);
    expect(events[0]!.data).toBe("ev0");
    expect(events[999]!.data).toBe("ev999");
  });
});
