/**
 * Request translation: UnifiedChatRequest → provider wire bodies.
 * Structures that cannot be translated safely are rejected loudly —
 * nothing is silently discarded.
 */

import type { UnifiedChatRequest, UnifiedContentBlock, UnifiedMessage } from "../core/contracts";

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

function blocksOf(m: UnifiedMessage): UnifiedContentBlock[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
}

function textOf(m: UnifiedMessage): string {
  return blocksOf(m)
    .map((b) => {
      if (b.type !== "text") {
        throw new TranslationError(`unexpected ${b.type} block in ${m.role} message`);
      }
      return b.text;
    })
    .join("");
}

/* ------------------------------ OpenAI dialect ----------------------------- */

export function toOpenAiBody(req: UnifiedChatRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const m of req.messages) {
    if (m.role === "tool") {
      if (!m.toolCallId) throw new TranslationError("tool message requires toolCallId");
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: textOf(m) });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = blocksOf(m);
      const toolCalls = blocks.filter((b) => b.type === "tool-call");
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      const bad = blocks.find((b) => b.type === "tool-result");
      if (bad) throw new TranslationError("tool-result block not valid in assistant message");
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = text.length > 0 ? text : null;
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      messages.push(msg);
      continue;
    }
    messages.push({ role: m.role, content: textOf(m) });
  }

  const body: Record<string, unknown> = { model: req.model, messages, stream: req.stream };
  if (req.stream) body.stream_options = { include_usage: true };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: t.parameters,
      },
    }));
  }
  return body;
}

/* ----------------------------- Anthropic dialect --------------------------- */

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

export function toAnthropicBody(req: UnifiedChatRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Record<string, unknown>[] = [];

  for (const m of req.messages) {
    switch (m.role) {
      case "system":
        systemParts.push(textOf(m)); // extracted to top-level `system`
        break;
      case "user":
        messages.push({ role: "user", content: [{ type: "text", text: textOf(m) }] });
        break;
      case "assistant": {
        const content: Record<string, unknown>[] = [];
        for (const b of blocksOf(m)) {
          if (b.type === "text") {
            if (b.text.length > 0) content.push({ type: "text", text: b.text });
          } else if (b.type === "tool-call") {
            let input: unknown;
            try {
              input = b.arguments === "" ? {} : JSON.parse(b.arguments);
            } catch {
              throw new TranslationError(
                `tool-call ${b.id} has non-JSON arguments; cannot translate to Anthropic tool_use`,
              );
            }
            content.push({ type: "tool_use", id: b.id, name: b.name, input });
          } else {
            throw new TranslationError("tool-result block not valid in assistant message");
          }
        }
        messages.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        if (!m.toolCallId) throw new TranslationError("tool message requires toolCallId");
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: textOf(m) }],
        });
        break;
      }
    }
  }

  if (messages.length === 0) {
    throw new TranslationError("Anthropic requires at least one non-system message");
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    stream: req.stream,
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      input_schema: t.parameters,
    }));
  }
  return body;
}
