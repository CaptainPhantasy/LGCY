/**
 * Live chat round-trip against a loopback OpenAI-compatible server.
 * Exercises the real fetch → SSE → normalizer → sendAndStream path over
 * 127.0.0.1 with an `env` credential the test sets itself, so no external
 * network or real provider secret is needed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, sendAndStream } from "../../src/app/main";

const ENV_VAR = "LGCY_LOOPBACK_TEST_KEY";
const FAKE_KEY = "loopback-test-only";
let server: ReturnType<typeof Bun.serve>;
let dir: string;
const seen: { auth?: string | null; body?: any; path?: string } = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgcy-loopback-"));
  process.env[ENV_VAR] = FAKE_KEY;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.path = url.pathname;
      seen.auth = req.headers.get("authorization");
      seen.body = await req.json();
      const chunks = ["Hello", " from", " loopback"];
      const sse =
        chunks
          .map((t, i) => `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: t } : { content: t } }] })}\n\n`)
          .join("") +
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(async () => {
  server?.stop(true);
  delete process.env[ENV_VAR];
  await rm(dir, { recursive: true, force: true });
});

test("sendAndStream round-trips through a loopback OpenAI-compatible server", async () => {
  const ctx = createApp({ settingsPath: join(dir, "config.json"), sessionsDir: join(dir, "sessions"), cwd: dir });
  ctx.registry.register({
    id: "loopback",
    displayName: "Loopback mock",
    kind: "openai",
    dialect: "openai",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKeyReference: { kind: "env", variable: ENV_VAR },
    enabled: true,
  });
  const log: string[] = [];
  const reply = await sendAndStream(ctx, "loopback", "mock-model", "ping", log, () => {});
  expect(reply).toBe("Hello from loopback");
  expect(log.some((l) => l.startsWith("error:"))).toBe(false);
  expect(seen.path).toBe("/v1/chat/completions");
  expect(seen.auth).toBe(`Bearer ${FAKE_KEY}`);
  expect(seen.body.model).toBe("mock-model");
  expect(seen.body.stream).toBe(true);
  expect(seen.body.messages).toEqual([{ role: "user", content: "ping" }]);
});
