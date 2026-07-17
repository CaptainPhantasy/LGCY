import { describe, expect, test } from "bun:test";
import { TaskStore } from "../../src/services/tasks";

describe("TaskStore", () => {
  test("add returns pending task", () => {
    const store = new TaskStore();
    const t = store.add("write tests");
    expect(t.content).toBe("write tests");
    expect(t.status).toBe("pending");
    expect(t.id).toBeTruthy();
  });

  test("list preserves insertion order", () => {
    const store = new TaskStore();
    store.add("a");
    store.add("b");
    store.add("c");
    expect(store.list().map((t) => t.content)).toEqual(["a", "b", "c"]);
  });

  test("update changes status", () => {
    const store = new TaskStore();
    const t = store.add("x");
    store.update(t.id, "completed");
    expect(store.get(t.id)!.status).toBe("completed");
  });

  test("update unknown id throws", () => {
    const store = new TaskStore();
    expect(() => store.update("nope", "completed")).toThrow(/unknown task/);
  });

  test("remove drops a task", () => {
    const store = new TaskStore();
    const t = store.add("x");
    store.remove(t.id);
    expect(store.list()).toHaveLength(0);
    expect(store.get(t.id)).toBeUndefined();
  });

  test("clearCompleted removes only completed tasks", () => {
    const store = new TaskStore();
    const a = store.add("a");
    const b = store.add("b");
    const c = store.add("c");
    store.update(a.id, "completed");
    store.update(c.id, "completed");
    const removed = store.clearCompleted();
    expect(removed).toBe(2);
    expect(store.list().map((t) => t.id)).toEqual([b.id]);
  });

  test("setActive ensures at most one in_progress", () => {
    const store = new TaskStore();
    const a = store.add("a");
    const b = store.add("b");
    store.setActive(a.id);
    expect(store.get(a.id)!.status).toBe("in_progress");
    store.setActive(b.id);
    expect(store.get(a.id)!.status).toBe("pending"); // demoted
    expect(store.get(b.id)!.status).toBe("in_progress");
  });
});
