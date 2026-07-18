import { describe, expect, test } from "bun:test";
import { LifecycleError, RequestLifecycle } from "../../src/core/lifecycle";

describe("RequestLifecycle", () => {
  test("happy path reaches completed then disposed", () => {
    const lc = new RequestLifecycle();
    for (const s of ["validated", "connecting", "streaming", "completing", "completed"] as const) {
      lc.transition(s);
    }
    expect(lc.isTerminal).toBe(true);
    expect(lc.outcome).toBe("completed");
    lc.transition("disposed");
    expect(lc.isDisposed).toBe(true);
    expect(lc.outcome).toBe("completed");
  });

  test("rejects invalid transitions", () => {
    const lc = new RequestLifecycle();
    expect(() => lc.transition("streaming")).toThrow(LifecycleError);
    expect(() => lc.transition("completed")).toThrow(LifecycleError);
    expect(lc.state).toBe("created");
  });

  test("transitions are monotonic — no re-entry after terminal", () => {
    const lc = new RequestLifecycle();
    lc.transition("validated");
    lc.transition("connecting");
    lc.transition("failed");
    expect(() => lc.transition("streaming")).toThrow(LifecycleError);
    expect(() => lc.transition("completed")).toThrow(LifecycleError);
    lc.transition("disposed");
    expect(() => lc.transition("failed")).toThrow(LifecycleError);
  });

  test("abort is idempotent from any live state", () => {
    const lc = new RequestLifecycle();
    lc.transition("validated");
    lc.transition("connecting");
    lc.transition("streaming");
    expect(lc.requestAbort()).toBe(true);
    expect(lc.state).toBe("aborting");
    expect(lc.requestAbort()).toBe(true); // second call joins, does not throw
    lc.transition("aborted");
    expect(lc.requestAbort()).toBe(true); // already aborted: still true, no-op
    expect(lc.outcome).toBe("aborted");
  });

  test("abort after a different terminal outcome is a refusal, not an error", () => {
    const lc = new RequestLifecycle();
    for (const s of ["validated", "connecting", "streaming", "completing", "completed"] as const) {
      lc.transition(s);
    }
    expect(lc.requestAbort()).toBe(false);
    expect(lc.state).toBe("completed");
  });

  test("exactly one terminal outcome is recorded in history", () => {
    const lc = new RequestLifecycle();
    lc.transition("validated");
    lc.transition("failed");
    lc.transition("disposed");
    const terminals = lc.history.filter((t) =>
      ["completed", "aborted", "failed"].includes(t.to),
    );
    expect(terminals).toHaveLength(1);
  });

  test("history timestamps are non-decreasing", () => {
    let clock = 0;
    const lc = new RequestLifecycle(() => ++clock);
    lc.transition("validated");
    lc.transition("connecting");
    lc.transition("streaming");
    const times = lc.history.map((t) => t.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("RequestLifecycle — item #47 dispose()", () => {
  test("dispose from completed succeeds", () => {
    const lc = new RequestLifecycle();
    lc.transition("failed");
    lc.dispose();
    expect(lc.isDisposed).toBe(true);
  });
  test("dispose from non-terminal state throws", () => {
    const lc = new RequestLifecycle();
    expect(() => lc.dispose()).toThrow(/Invalid lifecycle transition/);
  });
  test("requestAbort + abort + dispose chain", () => {
    const lc = new RequestLifecycle();
    lc.requestAbort();
    lc.transition("aborted");
    lc.dispose();
    expect(lc.isDisposed).toBe(true);
  });
});
