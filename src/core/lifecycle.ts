/**
 * Request lifecycle state machine. Transitions are monotonic and validated;
 * every request reaches exactly one terminal outcome, then must be disposed.
 */

export type LifecycleState =
  | "created"
  | "validated"
  | "connecting"
  | "streaming"
  | "completing"
  | "completed"
  | "aborting"
  | "aborted"
  | "failed"
  | "disposed";

export type TerminalState = "completed" | "aborted" | "failed";

const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  created: ["validated", "failed", "aborting"],
  validated: ["connecting", "failed", "aborting"],
  connecting: ["streaming", "completing", "failed", "aborting"],
  streaming: ["completing", "failed", "aborting"],
  completing: ["completed", "failed", "aborting"],
  completed: ["disposed"],
  aborting: ["aborted", "failed"],
  aborted: ["disposed"],
  failed: ["disposed"],
  disposed: [],
};

export const TERMINAL_STATES: readonly TerminalState[] = ["completed", "aborted", "failed"];

export class LifecycleError extends Error {
  constructor(
    readonly from: LifecycleState,
    readonly to: LifecycleState,
  ) {
    super(`Invalid lifecycle transition: ${from} -> ${to}`);
    this.name = "LifecycleError";
  }
}

export interface LifecycleTransition {
  from: LifecycleState;
  to: LifecycleState;
  atMs: number;
}

export class RequestLifecycle {
  #state: LifecycleState = "created";
  #history: LifecycleTransition[] = [];
  #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  get state(): LifecycleState {
    return this.#state;
  }

  get history(): readonly LifecycleTransition[] {
    return this.#history;
  }

  get isTerminal(): boolean {
    return (TERMINAL_STATES as readonly string[]).includes(this.#state);
  }

  get isDisposed(): boolean {
    return this.#state === "disposed";
  }

  /** The terminal outcome, if one has been reached (survives disposal). */
  get outcome(): TerminalState | undefined {
    for (const t of this.#history) {
      if ((TERMINAL_STATES as readonly string[]).includes(t.to)) return t.to as TerminalState;
    }
    return undefined;
  }

  canTransition(to: LifecycleState): boolean {
    return TRANSITIONS[this.#state].includes(to);
  }

  transition(to: LifecycleState): void {
    if (!this.canTransition(to)) throw new LifecycleError(this.#state, to);
    this.#history.push({ from: this.#state, to, atMs: this.#now() });
    this.#state = to;
  }

  /**
   * Idempotent abort entry: returns true if this call initiated or joined an
   * abort; false if the request already reached a different terminal state
   * (in which case aborting is a no-op, never an error).
   */
  requestAbort(): boolean {
    if (this.#state === "aborting" || this.#state === "aborted") return true;
    if (this.isTerminal || this.isDisposed) return false;
    this.transition("aborting");
    return true;
  }
}
