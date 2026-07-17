import { describe, expect, test } from "bun:test";
import { BrokerError } from "../../src/broker/client";
import { createSecretResolver } from "../../src/broker/resolve";
import type { CredentialReference } from "../../src/core/contracts";

describe("createSecretResolver", () => {
  test("env reference returns value", async () => {
    const resolve = createSecretResolver({ env: { API_KEY: "v" } });
    await expect(resolve({ kind: "env", variable: "API_KEY" } as CredentialReference)).resolves.toBe("v");
  });
  test("env reference missing throws", async () => {
    const resolve = createSecretResolver({ env: {} });
    await expect(resolve({ kind: "env", variable: "X" } as CredentialReference)).rejects.toThrow(
      BrokerError,
    );
  });
  test("env empty string treated as missing", async () => {
    const resolve = createSecretResolver({ env: { X: "" } });
    await expect(resolve({ kind: "env", variable: "X" } as CredentialReference)).rejects.toThrow(
      BrokerError,
    );
  });
  test("auth-broker reference delegates to broker.resolve", async () => {
    const fakeBroker = { resolve: async (p: string) => `secret-for-${p}` };
    const resolve = createSecretResolver({ broker: fakeBroker as never });
    await expect(
      resolve({ kind: "auth-broker", provider: "opencode-go" } as CredentialReference),
    ).resolves.toBe("secret-for-opencode-go");
  });
  test("auth-broker reference without broker client throws", async () => {
    const resolve = createSecretResolver({});
    await expect(
      resolve({ kind: "auth-broker", provider: "p" } as CredentialReference),
    ).rejects.toThrow(BrokerError);
  });
  test("none reference throws", async () => {
    const resolve = createSecretResolver({});
    await expect(resolve({ kind: "none" } as CredentialReference)).rejects.toThrow(BrokerError);
  });
});
