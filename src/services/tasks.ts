/**
 * Task / plan store — lightweight in-memory todo list with optional JSONL
 * persistence. Mirrors the "plans/tasks" surface in the build-loop plan. Tasks
 * are append-only events so the history is replayable and crash-safe.
 *
 * Invariants:
 *  - AT MOST one task is in_progress at any time; zero is a valid state.
 *    update(id, "in_progress") and setActive() both demote any other active
 *    task, so the invariant cannot be bypassed.
 *  - Persistence failures are never swallowed: they are reported through the
 *    onPersistError handler (default: stderr) because the write is async
 *    fire-and-forget behind a synchronous API.
 */

import { type SessionStore } from "./sessions";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  content: string;
  status: TaskStatus;
  createdAt: number;
}

export interface TaskStoreOptions {
  session?: SessionStore;
  sessionId?: string;
  /** Called when a background persistence write fails. */
  onPersistError?: (error: unknown) => void;
}

const STATUS_RANK: Record<TaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 };

export class TaskStore {
  // Map preserves insertion order, so listing is O(n) without a separate
  // order array and remove() is O(1) (no indexOf+splice).
  readonly #tasks = new Map<string, Task>();
  readonly #session?: SessionStore;
  readonly #sessionId?: string;
  readonly #onPersistError: (error: unknown) => void;

  constructor(opts: TaskStoreOptions = {}) {
    this.#session = opts.session;
    this.#sessionId = opts.sessionId;
    this.#onPersistError =
      opts.onPersistError ?? ((e) => console.error("lgcy: task persistence failed:", e));
  }

  add(content: string): Task {
    const task: Task = {
      // UUIDs: unique across processes AND across TaskStore instances in the
      // same process — no module-level counter, no Date.now() collisions.
      id: `task-${crypto.randomUUID()}`,
      content,
      status: "pending",
      createdAt: Date.now(),
    };
    this.#tasks.set(task.id, task);
    this.#report(this.#persist("task-added", task));
    return task;
  }

  update(id: string, status: TaskStatus): void {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    if (status === "in_progress") {
      // Enforce the at-most-one-active invariant here, not just in setActive.
      for (const t of this.#tasks.values()) {
        if (t.id !== id && t.status === "in_progress") t.status = "pending";
      }
    }
    task.status = status;
    this.#report(this.#persist("task-updated", { id, status }));
  }

  remove(id: string): void {
    if (this.#tasks.delete(id)) {
      this.#report(this.#persist("task-removed", { id }));
    }
  }

  get(id: string): Task | undefined {
    return this.#tasks.get(id);
  }

  /**
   * Tasks in insertion order by default; with { grouped: true }, ordered
   * in_progress → pending → completed (stable within each status).
   */
  list(opts?: { grouped?: boolean }): Task[] {
    const all = [...this.#tasks.values()];
    if (!opts?.grouped) return all;
    return all.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  }

  clearCompleted(): number {
    const removed: string[] = [];
    for (const [id, t] of this.#tasks) {
      if (t.status === "completed") removed.push(id);
    }
    for (const id of removed) this.remove(id);
    return removed.length;
  }

  /** Exactly one task may be in_progress at a time. */
  setActive(id: string): void {
    this.update(id, "in_progress");
  }

  #report(write: Promise<void>): void {
    write.catch((e) => this.#onPersistError(e));
  }

  async #persist(type: string, data: unknown): Promise<void> {
    if (this.#session && this.#sessionId) {
      await this.#session.append(this.#sessionId, type, data);
    }
  }
}
