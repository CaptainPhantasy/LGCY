import { describe, expect, test } from "bun:test";
import { backoffDelay, MaxAttemptsExceededError, withRetry } from "../../src/core/resilience";

describe("backoffDelay", () => {
  test("exponential growth without jitter", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 10_000, jitter: false };
    expect(backoffDelay(opts, 1)).toBe(100);
    expect(backoffDelay(opts, 2)).toBe(200);
    expect(backoffDelay(opts, 3)).toBe(400);
    expect(backoffDelay(opts, 4)).toBe(800);
  });
  test("caps at maxDelayMs", () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 3000, jitter: false };
    expect(backoffDelay(opts, 1)).toBe(1000);
    expect(backoffDelay(opts, 2)).toBe(2000);
    expect(backoffDelay(opts, 3)).toBe(3000);
    expect(backoffDelay(opts, 10)).toBe(3000);
  });
  test("jitter stays within [half, full] of capped delay", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 400, jitter: true };
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(opts, 3); // capped 400 → jitter [200, 400)
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(400);
    }
  });
});

describe("withRetry", () => {
  test("succeeds on first attempt — no sleep", async () => {
    const sleeps: number[] = [];
    const result = await withRetry(() => Promise.resolve("ok"), {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(result).toBe("ok");
    expect(sleeps).toEqual([]);
  });

  test("retries then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("boom");
        return "done";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        sleep: async (ms) => void sleeps.push(ms),
      },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  test("exhausts attempts → MaxAttemptsExceededError with last error", async () => {
    const err = new Error("always fails");
    await expect(
      withRetry(async () => Promise.reject(err), {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 10,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(MaxAttemptsExceededError);
  });

  test("isRetryable=false stops early without exhausting", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TypeError("non-retryable");
        },
        {
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 10,
          sleep: async () => {},
          isRetryable: (e) => !(e instanceof TypeError),
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("onRetry hook fires with attempt + delay", async () => {
    const events: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("x");
      },
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        sleep: async () => {},
        onRetry: (_e, attempt, delayMs) => events.push({ attempt, delayMs }),
      },
    );
    expect(events).toEqual([
      { attempt: 1, delayMs: 10 },
      { attempt: 2, delayMs: 20 },
    ]);
  });

  test("maxAttempts < 1 throws", async () => {
    await expect(
      withRetry(() => Promise.resolve(1), {
        maxAttempts: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
      }),
    ).rejects.toThrow(/maxAttempts/);
  });
});
