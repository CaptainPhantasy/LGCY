/**
 * Task / plan store — lightweight in-memory todo list with optional JSONL
 * persistence. Mirrors the "plans/tasks" surface in the build-loop plan. Tasks
 * are append-only events so the history is replayable and crash-safe.
 */

import { type SessionStore } from "./sessions";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  content: string;
  status: TaskStatus;
  createdAt: number;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `task-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export class TaskStore {
  readonly #tasks = new Map<string, Task>();
  readonly #order: string[] = [];
  readonly #session?: SessionStore;
  readonly #sessionId?: string;

  constructor(opts: { session?: SessionStore; sessionId?: string } = {}) {
    this.#session = opts.session;
    this.#sessionId = opts.sessionId;
  }

  add(content: string): Task {
    const task: Task = {
      id: nextId(),
      content,
      status: "pending",
      createdAt: Date.now(),
    };
    this.#tasks.set(task.id, task);
    this.#order.push(task.id);
    this.#persist("task-added", task).catch(() => {});
    return task;
  }

  update(id: string, status: TaskStatus): void {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    task.status = status;
    this.#persist("task-updated", { id, status }).catch(() => {});
  }

  remove(id: string): void {
    if (this.#tasks.delete(id)) {
      const i = this.#order.indexOf(id);
      if (i >= 0) this.#order.splice(i, 1);
      this.#persist("task-removed", { id }).catch(() => {});
    }
  }

  get(id: string): Task | undefined {
    return this.#tasks.get(id);
  }

  list(): Task[] {
    return this.#order.map((id) => this.#tasks.get(id)!).filter(Boolean);
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
    for (const t of this.#tasks.values()) {
      if (t.status === "in_progress") t.status = "pending";
    }
    this.update(id, "in_progress");
  }

  async #persist(type: string, data: unknown): Promise<void> {
    if (this.#session && this.#sessionId) {
      await this.#session.append(this.#sessionId, type, data);
    }
  }
}
