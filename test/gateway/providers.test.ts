import { describe, expect, test } from "bun:test";
import type { ProviderConfiguration } from "../../src/core/contracts";
import {
  BUILT_IN_PROVIDERS,
  ProviderError,
  ProviderRegistry,
  authHeaders,
  completionUrl,
} from "../../src/gateway/providers";

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

describe("completionUrl", () => {
  test("openai dialect appends /chat/completions", () => {
    expect(completionUrl(openai).toString()).toBe("https://api.openai.com/v1/chat/completions");
  });
  test("trailing slash in baseUrl is collapsed", () => {
    expect(
      completionUrl({ ...openai, baseUrl: "https://api.openai.com/v1/" }).toString(),
    ).toBe("https://api.openai.com/v1/chat/completions");
  });
  test("anthropic dialect appends /messages", () => {
    expect(completionUrl(anthropic).toString()).toBe("https://api.anthropic.com/v1/messages");
  });
  test("invalid baseUrl throws", () => {
    expect(() => completionUrl({ ...openai, baseUrl: "not-a-url" })).toThrow(ProviderError);
  });
  test("unsupported scheme throws", () => {
    expect(() => completionUrl({ ...openai, baseUrl: "ftp://x/v1" })).toThrow(ProviderError);
  });
});

describe("authHeaders", () => {
  test("openai uses Bearer authorization", () => {
    const h = authHeaders(openai, "sk-1");
    expect(h.authorization).toBe("Bearer sk-1");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["content-type"]).toBe("application/json");
  });
  test("anthropic uses x-api-key + anthropic-version", () => {
    const h = authHeaders(anthropic, "sk-2");
    expect(h["x-api-key"]).toBe("sk-2");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h.authorization).toBeUndefined();
  });
  test("defaultHeaders merge and are lowercased", () => {
    const h = authHeaders(
      { ...openai, defaultHeaders: { "X-Org": "org1" } },
      "sk-1",
    );
    expect(h["x-org"]).toBe("org1");
  });
});

describe("ProviderRegistry", () => {
  test("default registry contains all built-in providers", () => {
    const r = new ProviderRegistry();
    expect(r.list().map((p) => p.id).sort()).toEqual(["anthropic", "openai", "opencode-go", "opencode-zen"]);
  });
  test("has / get", () => {
    const r = new ProviderRegistry([openai]);
    expect(r.has("openai")).toBe(true);
    expect(r.has("x")).toBe(false);
    expect(r.get("openai")).toBe(openai);
  });
  test("get unknown throws", () => {
    const r = new ProviderRegistry([openai]);
    expect(() => r.get("nope")).toThrow(ProviderError);
  });
  test("register eagerly validates baseUrl", () => {
    const r = new ProviderRegistry([]);
    expect(() => r.register({ ...openai, baseUrl: "bad" })).toThrow(ProviderError);
  });
  test("register rejects empty id", () => {
    const r = new ProviderRegistry([]);
    expect(() => r.register({ ...openai, id: "" })).toThrow(ProviderError);
  });
  test("allowedOrigins derived from baseUrls", () => {
    const r = new ProviderRegistry([openai, anthropic]);
    expect(r.allowedOrigins()).toEqual(
      new Set(["https://api.openai.com", "https://api.anthropic.com"]),
    );
  });

  describe("resolve precedence", () => {
    const disabled = { ...openai, id: "off", enabled: false };
    const reg = new ProviderRegistry([openai, anthropic, disabled]);

    test("request beats session beats workspace beats app", () => {
      expect(
        reg.resolve({ requestProviderId: "openai", sessionProviderId: "anthropic" }).id,
      ).toBe("openai");
      expect(reg.resolve({ sessionProviderId: "anthropic", workspaceDefaultId: "openai" }).id).toBe(
        "anthropic",
      );
      expect(reg.resolve({ workspaceDefaultId: "anthropic", appDefaultId: "openai" }).id).toBe(
        "anthropic",
      );
      expect(reg.resolve({ appDefaultId: "openai" }).id).toBe("openai");
    });
    test("first-named unknown provider throws (no silent fallthrough)", () => {
      expect(() => reg.resolve({ requestProviderId: "ghost", appDefaultId: "openai" })).toThrow(
        ProviderError,
      );
    });
    test("disabled provider throws", () => {
      expect(() => reg.resolve({ requestProviderId: "off" })).toThrow(ProviderError);
    });
    test("nothing selected throws", () => {
      expect(() => reg.resolve({})).toThrow(ProviderError);
    });
  });
});

test("BUILT_IN_PROVIDERS every entry yields a valid http(s) url", () => {
  for (const p of BUILT_IN_PROVIDERS) {
    const u = completionUrl(p);
    expect(u.protocol === "https:" || u.protocol === "http:").toBe(true);
  }
});
