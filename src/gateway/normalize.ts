/**
 * Stream normalization — provider-dialect SSE events in, ordered
 * UnifiedStreamEvents out. All provider-specific wire knowledge lives here;
 * nothing above this layer sees raw provider payloads.
 */

import type {
  UnifiedStreamEvent,
  UnifiedStreamEventType,
  UpstreamError,
  UsageData,
} from "../core/contracts";
import type { SseEvent } from "./sse";

export interface NormalizerOptions {
  requestId: string;
  providerId: string;
  /** Monotonic clock in ms; injectable for tests. */
  now?: () => number;
}

abstract class BaseNormalizer {
  protected readonly requestId: string;
  protected readonly providerId: string;
  protected model: string | undefined;
  #sequence = 0;
  #startMs: number;
  #now: () => number;
  #terminated = false;

  constructor(opts: NormalizerOptions) {
    this.requestId = opts.requestId;
    this.providerId = opts.providerId;
    this.#now = opts.now ?? (() => performance.now());
    this.#startMs = this.#now();
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  protected emit(type: UnifiedStreamEventType, data: unknown): UnifiedStreamEvent {
    if (type === "response-complete" || type === "error") this.#terminated = true;
    const ev: UnifiedStreamEvent = {
      type,
      requestId: this.requestId,
      sequence: this.#sequence++,
      providerId: this.providerId,
      elapsedMs: this.#now() - this.#startMs,
      data,
    };
    if (this.model !== undefined) ev.model = this.model;
    return ev;
  }

  protected parseError(message: string, raw: string): UnifiedStreamEvent {
    const err: UpstreamError = {
      source: "stream-parser",
      message,
      body: raw.slice(0, 2048),
      providerId: this.providerId,
      requestId: this.requestId,
    };
    return this.emit("error", err);
  }

  abstract handle(event: SseEvent): UnifiedStreamEvent[];

  /** Stream ended. Guarantees exactly one terminal event per request. */
  close(): UnifiedStreamEvent[] {
    if (this.#terminated) return [];
    const err: UpstreamError = {
      source: "stream-parser",
      message: "upstream stream ended without a completion event",
      providerId: this.providerId,
      requestId: this.requestId,
    };
    return [this.emit("error", err)];
  }
}

/* ------------------------------ OpenAI dialect ----------------------------- */

interface OpenAiToolCallState {
  id: string;
  name: string;
  args: string;
}

export class OpenAiStreamNormalizer extends BaseNormalizer {
  #started = false;
  #tools = new Map<number, OpenAiToolCallState>();
  #finishReason: string | undefined;
  #usage: UsageData | undefined;

  handle(event: SseEvent): UnifiedStreamEvent[] {
    if (this.terminated) return [];
    const data = event.data.trim();
    if (data === "") return [];
    if (data === "[DONE]") return this.#complete();

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return [this.parseError("malformed JSON in OpenAI-dialect stream", data)];
    }

    const out: UnifiedStreamEvent[] = [];
    if (typeof payload.model === "string") this.model = payload.model;
    if (!this.#started) {
      this.#started = true;
      out.push(this.emit("response-start", { id: payload.id, model: payload.model }));
    }

    if (payload.usage) {
      this.#usage = {
        inputTokens: payload.usage.prompt_tokens,
        outputTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
      };
    }

    const choice = payload.choices?.[0];
    if (choice) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        out.push(this.emit("text-delta", { text: delta.content }));
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          let state = this.#tools.get(idx);
          if (!state) {
            state = { id: tc.id ?? `tool_${idx}`, name: tc.function?.name ?? "", args: "" };
            this.#tools.set(idx, state);
            out.push(this.emit("tool-call-start", { id: state.id, name: state.name }));
          } else if (tc.function?.name) {
            state.name = tc.function.name;
          }
          const argDelta: string = tc.function?.arguments ?? "";
          if (argDelta) {
            state.args += argDelta;
            out.push(this.emit("tool-call-delta", { id: state.id, argumentsDelta: argDelta }));
          }
        }
      }
      if (choice.finish_reason) this.#finishReason = choice.finish_reason;
    }
    return out;
  }

  #complete(): UnifiedStreamEvent[] {
    const out: UnifiedStreamEvent[] = [];
    for (const state of this.#tools.values()) {
      out.push(
        this.emit("tool-call-complete", { id: state.id, name: state.name, arguments: state.args }),
      );
    }
    if (this.#usage) out.push(this.emit("usage", this.#usage));
    out.push(this.emit("response-complete", { finishReason: this.#finishReason ?? "stop" }));
    return out;
  }
}

/* ----------------------------- Anthropic dialect --------------------------- */

interface AnthropicBlockState {
  type: "text" | "tool_use";
  id?: string;
  name?: string;
  args: string;
}

export class AnthropicStreamNormalizer extends BaseNormalizer {
  #blocks = new Map<number, AnthropicBlockState>();
  #usage: UsageData = {};
  #stopReason: string | undefined;

  handle(event: SseEvent): UnifiedStreamEvent[] {
    if (this.terminated) return [];
    const data = event.data.trim();
    if (data === "") return [];

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return [this.parseError("malformed JSON in Anthropic-dialect stream", data)];
    }

    const type = payload.type ?? event.event;
    const out: UnifiedStreamEvent[] = [];

    switch (type) {
      case "message_start": {
        const msg = payload.message ?? {};
        if (typeof msg.model === "string") this.model = msg.model;
        if (msg.usage?.input_tokens != null) this.#usage.inputTokens = msg.usage.input_tokens;
        out.push(this.emit("response-start", { id: msg.id, model: msg.model }));
        break;
      }
      case "content_block_start": {
        const idx: number = payload.index ?? 0;
        const block = payload.content_block ?? {};
        if (block.type === "tool_use") {
          const state: AnthropicBlockState = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            args: "",
          };
          this.#blocks.set(idx, state);
          out.push(this.emit("tool-call-start", { id: block.id, name: block.name }));
        } else {
          this.#blocks.set(idx, { type: "text", args: "" });
          if (typeof block.text === "string" && block.text.length > 0) {
            out.push(this.emit("text-delta", { text: block.text }));
          }
        }
        break;
      }
      case "content_block_delta": {
        const idx: number = payload.index ?? 0;
        const delta = payload.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          out.push(this.emit("text-delta", { text: delta.text }));
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const state = this.#blocks.get(idx);
          if (state?.type === "tool_use") {
            state.args += delta.partial_json;
            out.push(
              this.emit("tool-call-delta", { id: state.id, argumentsDelta: delta.partial_json }),
            );
          }
        }
        break;
      }
      case "content_block_stop": {
        const idx: number = payload.index ?? 0;
        const state = this.#blocks.get(idx);
        if (state?.type === "tool_use") {
          out.push(
            this.emit("tool-call-complete", {
              id: state.id,
              name: state.name,
              arguments: state.args,
            }),
          );
        }
        break;
      }
      case "message_delta": {
        if (payload.delta?.stop_reason) this.#stopReason = payload.delta.stop_reason;
        if (payload.usage?.output_tokens != null) {
          this.#usage.outputTokens = payload.usage.output_tokens;
        }
        break;
      }
      case "message_stop": {
        if (this.#usage.inputTokens != null || this.#usage.outputTokens != null) {
          out.push(this.emit("usage", this.#usage));
        }
        out.push(this.emit("response-complete", { finishReason: this.#stopReason ?? "end_turn" }));
        break;
      }
      case "error": {
        const err: UpstreamError = {
          source: "provider",
          message: payload.error?.message ?? "provider stream error",
          body: data.slice(0, 2048),
          providerId: this.providerId,
          requestId: this.requestId,
        };
        out.push(this.emit("error", err));
        break;
      }
      case "ping":
        break;
      default:
        break; // unknown event types tolerated
    }
    return out;
  }
}
