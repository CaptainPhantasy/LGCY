/**
 * Secret resolver — turns a CredentialReference into a request-time secret.
 * Bridges the gateway relay (which needs a SecretResolver) to all credential
 * kinds: environment variables, the auth-broker, or explicit none.
 */

import type { CredentialReference, SecretResolver } from "../core/contracts";
import { BrokerClient, BrokerError, extractSecret } from "./client";

export interface SecretResolverOptions {
  /** Broker client; required to resolve `auth-broker` references. */
  broker?: BrokerClient;
  /** Environment map; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export function createSecretResolver(opts: SecretResolverOptions = {}): SecretResolver {
  const env = opts.env ?? process.env;
  const broker = opts.broker;
  return async (ref: CredentialReference): Promise<string> => {
    switch (ref.kind) {
      case "env": {
        const value = env[ref.variable];
        if (typeof value !== "string" || value.length === 0) {
          throw new BrokerError(`environment variable ${ref.variable} is not set`);
        }
        return value;
      }
      case "auth-broker": {
        if (!broker) throw new BrokerError("no auth-broker client configured");
        return broker.resolve(ref.provider);
      }
      case "none":
        throw new BrokerError("credential reference is 'none' — no secret available");
    }
  };
}

export { BrokerClient, BrokerError, extractSecret };
