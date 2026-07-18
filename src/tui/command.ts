/**
 * Command registry — the TUI's slash-command dispatcher. Commands are plain
 * handlers over a minimal context; the registry parses input, resolves the
 * command, and invokes it with tokenized arguments.
 */

export interface CommandContext<T = unknown> {
  /** Arbitrary runtime state the handler can read/mutate. */
  state: T;
  /** Write a message back to the user (e.g. confirmation / error). */
  print: (text: string) => void;
}

export interface Command<T = unknown> {
  id: string;
  description: string;
  /** Argv-style token list, argv[0] is the command name (without slash). */
  run: (argv: string[], ctx: CommandContext<T>) => void | Promise<void>;
}

export class CommandRegistry<T = unknown> {
  #commands = new Map<string, Command<T>>();

  register(cmd: Command<T>): void {
    if (!cmd.id) throw new Error("command id is required");
    if (this.#commands.has(cmd.id)) throw new Error(`duplicate command: ${cmd.id}`);
    this.#commands.set(cmd.id, cmd);
  }

  get(id: string): Command<T> | undefined {
    return this.#commands.get(id);
  }

  list(): Command<T>[] {
    return [...this.#commands.values()];
  }

  has(id: string): boolean {
    return this.#commands.has(id);
  }

  /** Parse "cmd arg1 arg2" or "/cmd arg1 arg2"; returns the id + argv. */
  static parse(input: string): { id: string; argv: string[] } | undefined {
    const trimmed = input.trim();
    if (trimmed.length === 0) return undefined;
    const name = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    const argv = tokenize(name);
    if (argv.length === 0) return undefined;
    return { id: argv[0]!, argv };
  }

  /**
   * Resolve and run a parsed command line against a context. Returns true if a
   * command matched. Unknown commands are surfaced via the print callback.
   */
  async execute(input: string, ctx: CommandContext<T>): Promise<boolean> {
    const parsed = CommandRegistry.parse(input);
    if (!parsed) return false;
    const cmd = this.get(parsed.id);
    if (!cmd) {
      ctx.print(`unknown command: /${parsed.id}`);
      return false;
    }
    await cmd.run(parsed.argv, ctx);
    return true;
  }
}

/**
 * Split on whitespace, honoring double-quoted segments. An unterminated
 * quote is handled explicitly: the opening quote is kept as a literal
 * character in the token, so user typos like /model "gpt-4o surface
 * visibly (the model name shows the stray quote) instead of being silently
 * reinterpreted. No escape sequences are supported.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let quotePos = -1; // offset within cur where the current quote opened
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"') {
      if (inQuotes) {
        inQuotes = false;
        quotePos = -1;
      } else {
        inQuotes = true;
        quotePos = cur.length;
      }
      continue;
    }
    if (ch === " " && !inQuotes) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (inQuotes && quotePos >= 0) {
    // Unterminated quote — restore it as a literal character.
    cur = `${cur.slice(0, quotePos)}"${cur.slice(quotePos)}`;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
