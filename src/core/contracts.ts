/**
 * Shared domain contracts — the provider-neutral types every layer speaks.
 * This module must remain dependency-free and must not import from any
 * other layer.
 */

export type ProviderDialect = "openai" | "anthropic";

export type ProviderKind =
  | "opencode-zen"
  | "opencode-go"
  | "openai"
  | "anthropic"
  | "custom";

/**
 * A credential reference names where a secret lives; it never contains the
 * secret itself. Resolution happens inside the gateway at request time.
 */
export type CredentialReference =
  | { kind: "env"; variable: string }
  | { kind: "auth-broker"; provider: string }
  | { kind: "none" };

export type SecretResolver = (ref: CredentialReference) => Promise<string>;

export interface ProviderConfiguration {
  id: string;
  displayName: string;
  kind: ProviderKind;
  dialect: ProviderDialect;
  baseUrl: string;
  apiKeyReference: CredentialReference;
  enabled: boolean;
  defaultHeaders?: Record<string, string>;
  modelCatalog?: string[];
  requestTimeoutMs?: number;
}

export interface UnifiedToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type UnifiedContentBlock =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "tool-result"; toolCallId: string; content: string; isError?: boolean };

export interface UnifiedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | UnifiedContentBlock[];
  toolCallId?: string;
}

export interface UnifiedChatRequest {
  providerId: string;
  model: string;
  messages: UnifiedMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: UnifiedToolDefinition[];
  metadata?: Record<string, unknown>;
}

export type UnifiedStreamEventType =
  | "response-start"
  | "text-delta"
  | "tool-call-start"
  | "tool-call-delta"
  | "tool-call-complete"
  | "usage"
  | "response-complete"
  | "error";

export interface UnifiedStreamEvent {
  type: UnifiedStreamEventType;
  requestId: string;
  /** Monotonic per-request sequence number, starting at 0. */
  sequence: number;
  providerId: string;
  model?: string;
  /** Milliseconds from request start (monotonic clock). */
  elapsedMs: number;
  data: unknown;
}

export interface UsageData {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Exact upstream failure, preserved end to end. */
export interface UpstreamError {
  source:
    | "local-config"
    | "local-validation"
    | "gateway-transport"
    | "timeout"
    | "cancelled"
    | "provider"
    | "stream-parser";
  /** Upstream HTTP status when source === "provider". */
  status?: number;
  contentType?: string;
  /** Raw upstream body (size-limited, secrets redacted). */
  body?: string;
  message: string;
  providerId?: string;
  requestId?: string;
}
