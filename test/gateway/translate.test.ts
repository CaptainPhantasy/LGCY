import { describe, expect, test } from "bun:test";
import type { UnifiedChatRequest } from "../../src/core/contracts";
import {
  ANTHROPIC_VERSION,
  TranslationError,
  toAnthropicBody,
  toOpenAiBody,
} from "../../src/gateway/translate";

function req(partial: Partial<UnifiedChatRequest>): UnifiedChatRequest {
  return {
    providerId: "p",
    model: "m",
    messages: [],
    stream: true,
    ...partial,
  };
}

/* -------------------------------- OpenAI ---------------------------------- */

describe("toOpenAiBody", () => {
  test("string content user message", () => {
    const body = toOpenAiBody(req({ messages: [{ role: "user", content: "hi" }] }));
    expect(body).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test("non-stream omits stream_options", () => {
    const body = toOpenAiBody(req({ stream: false, messages: [{ role: "user", content: "hi" }] }));
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  test("assistant tool-call blocks become tool_calls", () => {
    const body = toOpenAiBody(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "thinking" },
              { type: "tool-call", id: "c1", name: "read", arguments: '{"p":"a"}' },
            ],
          },
        ],
      }),
    );
    const msg = (body.messages as unknown[])[0] as Record<string, unknown>;
    expect(msg.content).toBe("thinking");
    expect(msg.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "read", arguments: '{"p":"a"}' } },
    ]);
  });

  test("assistant with no text yields null content", () => {
    const body = toOpenAiBody(
      req({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool-call", id: "c1", name: "f", arguments: "{}" }],
          },
        ],
      }),
    );
    const msg = (body.messages as unknown[])[0] as Record<string, unknown>;
    expect(msg.content).toBeNull();
  });

  test("tool role carries tool_call_id", () => {
    const body = toOpenAiBody(
      req({ messages: [{ role: "tool", content: "ok", toolCallId: "c1" }] }),
    );
    expect(body.messages).toEqual([{ role: "tool", tool_call_id: "c1", content: "ok" }]);
  });

  test("tools map to function tools", () => {
    const body = toOpenAiBody(
      req({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
      }),
    );
    expect(body.tools).toEqual([
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ]);
  });

  test("temperature + max_tokens pass through", () => {
    const body = toOpenAiBody(
      req({ messages: [{ role: "user", content: "x" }], temperature: 0.3, maxTokens: 50 }),
    );
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(50);
  });

  test("tool message without toolCallId throws", () => {
    expect(() => toOpenAiBody(req({ messages: [{ role: "tool", content: "ok" }] }))).toThrow(
      TranslationError,
    );
  });

  test("tool-result block in assistant throws", () => {
    expect(() =>
      toOpenAiBody(
        req({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool-result", toolCallId: "c1", content: "x" }],
            },
          ],
        }),
      ),
    ).toThrow(TranslationError);
  });
});

/* ------------------------------- Anthropic -------------------------------- */

describe("toAnthropicBody", () => {
  test("system extracted to top-level; user becomes text block", () => {
    const body = toAnthropicBody(
      req({
        messages: [
          { role: "system", content: "be good" },
          { role: "user", content: "hi" },
        ],
      }),
    ) as Record<string, unknown>;
    expect(body.system).toBe("be good");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(body.max_tokens).toBe(4096);
  });

  test("multiple system messages joined with double-newline", () => {
    const body = toAnthropicBody(
      req({
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
          { role: "user", content: "x" },
        ],
      }),
    ) as Record<string, unknown>;
    expect(body.system).toBe("a\n\nb");
  });

  test("max_tokens defaults but explicit value wins", () => {
    const explicit = toAnthropicBody(
      req({ messages: [{ role: "user", content: "x" }], maxTokens: 100 }),
    ) as Record<string, unknown>;
    expect(explicit.max_tokens).toBe(100);
  });

  test("assistant tool-call block parsed to tool_use input", () => {
    const body = toAnthropicBody(
      req({
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", id: "u1", name: "fn", arguments: '{"k":1}' },
            ],
          },
        ],
      }),
    ) as Record<string, unknown>;
    const asst = (body.messages as unknown[])[1] as Record<string, unknown>;
    expect(asst.content).toEqual([{ type: "tool_use", id: "u1", name: "fn", input: { k: 1 } }]);
  });

  test("empty-arguments tool-call becomes empty object input", () => {
    const body = toAnthropicBody(
      req({
        messages: [
          { role: "user", content: "x" },
          {
            role: "assistant",
            content: [{ type: "tool-call", id: "u1", name: "fn", arguments: "" }],
          },
        ],
      }),
    ) as Record<string, unknown>;
    const asst = (body.messages as unknown[])[1] as Record<string, unknown>;
    const block = (asst.content as unknown[])[0] as Record<string, unknown>;
    expect(block.input).toEqual({});
  });

  test("tool message becomes tool_result under a user role", () => {
    const body = toAnthropicBody(
      req({ messages: [{ role: "user", content: "x" }, { role: "tool", content: "r", toolCallId: "u1" }] }),
    ) as Record<string, unknown>;
    expect((body.messages as unknown[])[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "u1", content: "r" }],
    });
  });

  test("tools map to input_schema", () => {
    const body = toAnthropicBody(
      req({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "f", parameters: { type: "object" } }],
      }),
    ) as Record<string, unknown>;
    expect(body.tools).toEqual([{ name: "f", input_schema: { type: "object" } }]);
  });

  test("tool message without toolCallId throws", () => {
    expect(() =>
      toAnthropicBody(req({ messages: [{ role: "user", content: "x" }, { role: "tool", content: "r" }] })),
    ).toThrow(TranslationError);
  });

  test("assistant non-JSON tool-call arguments throws", () => {
    expect(() =>
      toAnthropicBody(
        req({
          messages: [
            { role: "user", content: "x" },
            {
              role: "assistant",
              content: [{ type: "tool-call", id: "u1", name: "fn", arguments: "not-json" }],
            },
          ],
        }),
      ),
    ).toThrow(TranslationError);
  });

  test("system-only request (no user message) throws", () => {
    expect(() => toAnthropicBody(req({ messages: [{ role: "system", content: "x" }] }))).toThrow(
      TranslationError,
    );
  });
});

test("ANTHROPIC_VERSION exported", () => {
  expect(ANTHROPIC_VERSION).toBe("2023-06-01");
});
