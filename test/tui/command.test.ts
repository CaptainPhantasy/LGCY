import { describe, expect, test } from "bun:test";
import { CommandRegistry, type Command, type CommandContext, tokenize } from "../../src/tui/command";

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("a b c")).toEqual(["a", "b", "c"]);
  });
  test("honors double quotes", () => {
    expect(tokenize('say "hello world"')).toEqual(["say", "hello world"]);
  });
  test("collapses repeated spaces", () => {
    expect(tokenize("a   b")).toEqual(["a", "b"]);
  });
});

describe("CommandRegistry.parse", () => {
  test("with leading slash", () => {
    expect(CommandRegistry.parse("/help")).toEqual({ id: "help", argv: ["help"] });
  });
  test("without slash", () => {
    expect(CommandRegistry.parse("set model gpt-4")).toEqual({
      id: "set",
      argv: ["set", "model", "gpt-4"],
    });
  });
  test("empty returns undefined", () => {
    expect(CommandRegistry.parse("   ")).toBeUndefined();
  });
});

describe("CommandRegistry", () => {
  function registry(): { reg: CommandRegistry<unknown>; printed: string[] } {
    const printed: string[] = [];
    const reg = new CommandRegistry<unknown>();
    return { reg, printed };
  }
  function ctx(printed: string[]): CommandContext<unknown> {
    return { state: {}, print: (t) => printed.push(t) };
  }

  test("register + get + has + list", () => {
    const { reg } = registry();
    const cmd: Command = { id: "help", description: "d", run: () => {} };
    reg.register(cmd);
    expect(reg.has("help")).toBe(true);
    expect(reg.get("help")).toBe(cmd);
    expect(reg.list()).toHaveLength(1);
  });
  test("duplicate id throws", () => {
    const { reg } = registry();
    reg.register({ id: "x", description: "", run: () => {} });
    expect(() => reg.register({ id: "x", description: "", run: () => {} })).toThrow();
  });
  test("empty id throws", () => {
    const { reg } = registry();
    expect(() => reg.register({ id: "", description: "", run: () => {} })).toThrow();
  });

  test("execute runs handler with argv", async () => {
    const { reg } = registry();
    let received: string[] = [];
    reg.register({ id: "echo", description: "", run: (argv) => void (received = argv) });
    const ok = await reg.execute("/echo a b", ctx([]));
    expect(ok).toBe(true);
    expect(received).toEqual(["echo", "a", "b"]);
  });

  test("unknown command prints error, returns false", async () => {
    const { reg, printed } = registry();
    const ok = await reg.execute("/nope", ctx(printed));
    expect(ok).toBe(false);
    expect(printed[0]).toContain("unknown command");
  });

  test("empty input returns false", async () => {
    const { reg } = registry();
    expect(await reg.execute("", ctx([]))).toBe(false);
  });

  test("async handler awaited", async () => {
    const { reg } = registry();
    let done = false;
    reg.register({
      id: "slow",
      description: "",
      run: async () => {
        await new Promise((r) => setTimeout(r, 5));
        done = true;
      },
    });
    await reg.execute("/slow", ctx([]));
    expect(done).toBe(true);
  });
});
