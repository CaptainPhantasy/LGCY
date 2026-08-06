/**
 * Provider registry: built-in configurations, URL/header construction, and
 * configuration-precedence resolution. No silent fallback — resolution
 * returns exactly what precedence dictates or fails loudly.
 */

import type { ProviderConfiguration, ProviderDialect } from "../core/contracts";
import { ANTHROPIC_VERSION } from "./translate";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export const BUILT_IN_PROVIDERS: ProviderConfiguration[] = [
  {
    id: "opencode-zen",
    displayName: "OpenCode Zen",
    kind: "opencode-zen",
    dialect: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyReference: { kind: "auth-broker", provider: "opencode-zen" },
    proxyAuth: {
      header: "Proxy-Authorization",
      reference: { kind: "env", variable: "OPENCODE_PROXY_AUTH" },
    },
    enabled: true,
  },
  {
    id: "opencode-go",
    displayName: "OpenCode Go",
    kind: "opencode-go",
    dialect: "openai",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyReference: { kind: "auth-broker", provider: "opencode-go" },
    proxyAuth: {
      header: "Proxy-Authorization",
      reference: { kind: "env", variable: "OPENCODE_PROXY_AUTH" },
    },
    enabled: true,
  },
  {
    id: "openai",
    displayName: "OpenAI-compatible",
    kind: "openai",
    dialect: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyReference: { kind: "env", variable: "OPENAI_API_KEY" },
    enabled: true,
  },
  {
    id: "anthropic",
    displayName: "Anthropic-compatible",
    kind: "anthropic",
    dialect: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyReference: { kind: "env", variable: "ANTHROPIC_API_KEY" },
    enabled: true,
  },
];

const COMPLETION_PATHS: Record<ProviderDialect, string> = {
  openai: "/chat/completions",
  anthropic: "/messages",
};

/** Build the completion URL; validates the base URL parses and uses http(s). */
export function completionUrl(config: ProviderConfiguration): URL {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new ProviderError(`provider ${config.id}: invalid baseUrl`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new ProviderError(`provider ${config.id}: unsupported scheme ${base.protocol}`);
  }
  const path = base.pathname.replace(/\/$/, "") + COMPLETION_PATHS[config.dialect];
  return new URL(base.origin + path);
}

/**
 * Authentication headers for a resolved secret. The secret value flows
 * through here at request time only; it is never stored on the config.
 */
export function authHeaders(
  config: ProviderConfiguration,
  secret: string,
  proxySecret?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.dialect === "anthropic"
      ? { "x-api-key": secret, "anthropic-version": ANTHROPIC_VERSION }
      : { authorization: `Bearer ${secret}` }),
  };
  if (config.proxyAuth && proxySecret) {
    const prefix = config.proxyAuth.prefix ?? "Bearer";
    const value = prefix ? `${prefix} ${proxySecret}` : proxySecret;
    headers[config.proxyAuth.header.toLowerCase()] = value;
  }
  for (const [k, v] of Object.entries(config.defaultHeaders ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  return headers;
}

export interface ResolutionContext {
  requestProviderId?: string;
  sessionProviderId?: string;
  workspaceDefaultId?: string;
  appDefaultId?: string;
}

export class ProviderRegistry {
  #providers = new Map<string, ProviderConfiguration>();

  constructor(initial: ProviderConfiguration[] = BUILT_IN_PROVIDERS) {
    for (const p of initial) this.register(p);
  }

  register(config: ProviderConfiguration): void {
    if (!config.id) throw new ProviderError("provider id is required");
    if (!config.dialect) throw new ProviderError(`provider ${config.id}: dialect is required`);
    completionUrl(config); // validates baseUrl + scheme eagerly
    this.#providers.set(config.id, config);
  }

  get(id: string): ProviderConfiguration {
    const p = this.#providers.get(id);
    if (!p) throw new ProviderError(`unknown provider: ${id}`);
    return p;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  list(): ProviderConfiguration[] {
    return [...this.#providers.values()];
  }

  /** Allowlisted upstream origins — the gateway refuses anything else. */
  allowedOrigins(): Set<string> {
    return new Set(this.list().map((p) => new URL(p.baseUrl).origin));
  }

  /**
   * Configuration precedence: request > session > workspace default >
   * app default. The first level that names a provider wins; if that
   * provider is unknown or disabled this throws — it does NOT fall through
   * to the next level (no silent provider switching).
   */
  resolve(ctx: ResolutionContext): ProviderConfiguration {
    const chain: Array<[string, string | undefined]> = [
      ["request", ctx.requestProviderId],
      ["session", ctx.sessionProviderId],
      ["workspace default", ctx.workspaceDefaultId],
      ["app default", ctx.appDefaultId],
    ];
    for (const [level, id] of chain) {
      if (id === undefined) continue;
      const p = this.#providers.get(id);
      if (!p) throw new ProviderError(`${level} provider "${id}" is not configured`);
      if (!p.enabled) throw new ProviderError(`${level} provider "${id}" is disabled`);
      return p;
    }
    throw new ProviderError("no provider selected at any configuration level");
  }
}
