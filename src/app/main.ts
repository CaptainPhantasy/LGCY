/**
 * Composition root + entry point. Wires every layer per ADR-0001's dependency
 * direction (core ← broker ← gateway ← services ← app) and registers the
 * built-in slash commands. `createApp` is the testable factory; `main` is the
 * process entry that runs an interactive TUI loop when stdin is a TTY and a
 * status report otherwise.
 */

import {
  BUILT_IN_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  ProviderRegistry,
  credentialStatus,
  customProviderFromEnv,
} from "../gateway/providers";
import { GatewayRelay } from "../gateway/relay";
import { BrokerClient } from "../broker/client";
import { createSecretResolver } from "../broker/resolve";
import { FileService } from "../services/files";
import { ProjectService, type ProjectInfo } from "../services/project";
import { GitService } from "../services/git";
import { SessionStore } from "../services/sessions";
import { SettingsStore, type AppSettings } from "../services/settings";
import { TaskStore } from "../services/tasks";
import { CommandRegistry, type CommandContext } from "../tui/command";
import { KeyDecoder } from "../tui/keybind";
import { Renderer } from "../tui/renderer";
import { ScreenBuffer } from "../tui/buffer";
import { HIDE_CURSOR, SHOW_CURSOR, Color } from "../tui/ansi";
import type { SecretResolver, UnifiedChatRequest, UnifiedMessage } from "../core/contracts";

export const VERSION = "0.1.0";
const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";

/** Sentinel printed by /clear; the interactive loop resets the transcript. */
export const CLEAR_SENTINEL = "__clear__";
/** Lone-ESC disambiguation window (ms) before it is treated as Escape. */
export const ESCAPE_TIMEOUT_MS = 30;

const USAGE = `Usage: lgcy [options]

Options:
  -h, --help       Show this help
  -V, --version    Show the version

Environment:
  LGCY_BASE_URL    OpenAI-compatible endpoint, e.g. http://127.0.0.1:11434/v1
                   (OPENAI_BASE_URL is also accepted)
  LGCY_API_KEY     API key for that endpoint (optional for local servers)
  LGCY_MODEL       Default model when none is saved, e.g. qwen2.5:7b-instruct
  OPENAI_API_KEY, ANTHROPIC_API_KEY  keys for the hosted providers`;

export interface AppContext {
  version: string;
  cwd: string;
  registry: ProviderRegistry;
  broker: BrokerClient;
  relay: GatewayRelay;
  secretResolver: SecretResolver;
  settings: SettingsStore;
  sessions: SessionStore;
  files: FileService;
  project: ProjectService;
  git: GitService;
  tasks: TaskStore;
  commands: CommandRegistry<CommandState>;
}

export interface CommandState {
  settings: SettingsStore;
  registry: ProviderRegistry;
  tasks: TaskStore;
  output: string[];
}

export interface CreateAppOptions {
  cwd?: string;
  settingsPath?: string;
  sessionsDir?: string;
  broker?: BrokerClient;
  /** Environment used for the custom endpoint; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export function createApp(opts: CreateAppOptions = {}): AppContext {
  const cwd = opts.cwd ?? process.cwd();
  const broker = opts.broker ?? new BrokerClient();
  const secretResolver = createSecretResolver({ broker });
  const custom = customProviderFromEnv(opts.env ?? process.env);
  // A configured custom endpoint is listed first so it is the default route.
  const registry = new ProviderRegistry(custom ? [custom, ...BUILT_IN_PROVIDERS] : BUILT_IN_PROVIDERS);
  const relay = new GatewayRelay(registry);
  const settings = new SettingsStore({ path: opts.settingsPath });
  const sessions = new SessionStore({ baseDir: opts.sessionsDir });
  const files = new FileService({ root: cwd });
  const project = new ProjectService();
  const git = new GitService(cwd);
  const tasks = new TaskStore();

  const state: CommandState = { settings, registry, tasks, output: [] };
  const commands = new CommandRegistry<CommandState>();
  registerBuiltinCommands(commands);

  return {
    version: VERSION,
    cwd,
    registry,
    broker,
    relay,
    secretResolver,
    settings,
    sessions,
    files,
    project,
    git,
    tasks,
    commands,
  };
}

/* --------------------------- Built-in commands ---------------------------- */

function registerBuiltinCommands(reg: CommandRegistry<CommandState>): void {
  reg.register({
    id: "help",
    description: "List available commands",
    run: (_argv, ctx) => {
      ctx.print("Commands: /help /providers /provider <id> /model <id> /tasks /clear /exit");
    },
  });
  reg.register({
    id: "providers",
    description: "List configured providers",
    run: (_argv, ctx) => {
      const list = ctx.state.registry.list();
      const width = Math.max(...list.map((p) => p.id.length));
      for (const p of list) {
        ctx.print(`${p.id.padEnd(width)}  ${credentialStatus(p)}  ${p.baseUrl}`);
      }
      if (!list.some((p) => p.id === CUSTOM_PROVIDER_ID)) {
        ctx.print("local endpoint: set LGCY_BASE_URL=http://127.0.0.1:11434/v1 to add one");
      }
    },
  });
  reg.register({
    id: "provider",
    description: "Set default provider",
    run: async (argv, ctx) => {
      if (argv.length < 2) {
        ctx.print("usage: /provider <id>");
        return;
      }
      const found = ctx.state.registry.list().find((p) => p.id === argv[1]);
      if (!found) {
        ctx.print(`unknown provider: ${argv[1]}`);
        return;
      }
      await ctx.state.settings.update({ defaultProviderId: found.id });
      ctx.print(`default provider set to ${found.id}`);
    },
  });
  reg.register({
    id: "model",
    description: "Set default model",
    run: async (argv, ctx) => {
      if (argv.length < 2) {
        ctx.print("usage: /model <name>");
        return;
      }
      await ctx.state.settings.update({ defaultModel: argv[1] });
      ctx.print(`default model set to ${argv[1]}`);
    },
  });
  reg.register({
    id: "tasks",
    description: "List tasks",
    run: (_argv, ctx) => {
      const list = ctx.state.tasks.list({ grouped: true });
      if (list.length === 0) {
        ctx.print("(no tasks)");
        return;
      }
      for (const t of list) {
        const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
        ctx.print(`[${mark}] ${t.content}`);
      }
    },
  });
  reg.register({
    id: "clear",
    description: "Clear the conversation",
    run: (_argv, ctx) => ctx.print(CLEAR_SENTINEL),
  });
  reg.register({
    id: "exit",
    description: "Quit lgcy",
    run: (_argv, ctx) => ctx.print("__exit__"),
  });
}

/* ------------------------------ Banner ------------------------------------ */

export function banner(ctx: AppContext, brokerHealthy: boolean | null, project?: ProjectInfo): string {
  const lines: string[] = [];
  lines.push(`lgcy v${ctx.version}`);
  // The optional auth broker is only mentioned when it is actually running.
  if (brokerHealthy === true) lines.push("auth broker: online");
  if (project) lines.push(`project: ${project.name} (${project.kind}) @ ${project.root}`);
  const providerSummary = ctx.registry.list().map((p) => p.id).join(", ");
  lines.push(`providers: ${providerSummary}`);
  lines.push("Type a message and press Enter. /help lists commands.");
  return lines.join("\n");
}

/** Compact status label shown on the divider above the input line. */
export function statusLine(providerId: string, model?: string): string {
  return ` LGCY  ${providerId}${model ? `  ${model}` : ""} `;
}

/* --------------------------- Interactive loop ----------------------------- */

export interface MainOptions {
  args?: string[];
  createApplication?: typeof createApp;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

/**
 * Run the command entrypoint. Command-only options are handled before the
 * application is created, so help/version/error paths cannot touch projects,
 * sessions, terminals, or the auth broker.
 */
export async function main(options: MainOptions = {}): Promise<number> {
  const args = options.args ?? Bun.argv.slice(2);
  const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));

  if (args.length > 0) {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      writeStdout(`${USAGE}\n`);
      return 0;
    }
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
      writeStdout(`lgcy ${VERSION}\n`);
      return 0;
    }
    writeStderr(`lgcy: unknown option: ${args[0]}\nTry 'lgcy --help' for usage.\n`);
    return 64;
  }

  const ctx = (options.createApplication ?? createApp)();
  const projectInfo = await ctx.project.discover(ctx.cwd).catch(() => undefined);
  const brokerHealthy = await ctx.broker.health().catch(() => null);

  if (!process.stdin.isTTY) {
    process.stdout.write(banner(ctx, brokerHealthy, projectInfo) + "\n");
    process.stdout.write("(no tty — interactive shell unavailable)\n");
    return 0;
  }

  await runInteractive(ctx, brokerHealthy, projectInfo).catch((e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  });
  return 0;
}

async function runInteractive(
  ctx: AppContext,
  brokerHealthy: boolean | null,
  projectInfo: ProjectInfo | undefined,
): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdin.setRawMode(true);
  stdin.resume();
  // Terminal dimensions are re-read on every SIGWINCH — never cached once.
  let cols = stdout.columns || 80;
  let rows = stdout.rows || 24;

  const decoder = new KeyDecoder();
  const renderer = new Renderer();
  const bannerText = () => banner(ctx, brokerHealthy, projectInfo);
  const log: string[] = [bannerText()];
  // Conversation sent to the model on every turn (multi-turn context).
  let history: UnifiedMessage[] = [];
  let input = "";
  let busy = false;
  let settings: AppSettings = await ctx.settings.load();
  const envModel = process.env.LGCY_MODEL?.trim() || undefined;
  // Provider is resolved lazily from the LATEST settings on every prompt, so
  // /provider takes effect immediately instead of being fixed at startup.
  const providerId = () => {
    const saved = settings.defaultProviderId;
    if (saved && ctx.registry.has(saved)) return saved;
    return ctx.registry.list()[0]?.id ?? "openai";
  };
  const model = () => settings.defaultModel ?? envModel;

  const render = () => {
    const buf = new ScreenBuffer(cols, rows);
    buf.clear();
    // Every log entry is word-wrapped to the current width; the newest rows win.
    const lines = log.flatMap((entry) => wrapText(entry, cols));
    let y = 0;
    for (const line of lines.slice(-Math.max(0, rows - 2))) {
      buf.writeText(0, y, line);
      y++;
    }
    // Status rule: a quiet divider carrying the product name and active route.
    buf.fillRow(rows - 2, 0, cols - 1, "─", { dim: true });
    const status = statusLine(providerId(), model()) + (busy ? " waiting " : "");
    if (cols > status.length + 4) {
      buf.writeText(2, rows - 2, status, { fg: Color.blue, bold: true });
    }
    // Input line: keep the tail (where the cursor is) visible.
    buf.writeText(0, rows - 1, inputWindow(input, cols), { bold: true });
    stdout.write(renderer.render(buf));
    stdout.write(cursorToEnd(rows));
  };

  const onResize = () => {
    cols = stdout.columns || 80;
    rows = stdout.rows || 24;
    renderer.reset(); // dimension change → full repaint
    render();
  };
  stdout.on("resize", onResize);

  const state: CommandState = { settings: ctx.settings, registry: ctx.registry, tasks: ctx.tasks, output: [] };

  // Chat messages are persisted to a session (scrubbed at the boundary).
  // The session is created lazily on the first SUCCESSFUL exchange, so failed
  // or unsent prompts never reach disk.
  let sessionId: string | undefined;
  const ensureSession = async (titleSeed: string): Promise<string> => {
    if (!sessionId) {
      sessionId = `chat-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      await ctx.sessions.create(sessionId, {
        title: truncate(titleSeed, 40),
        providerId: providerId(),
        createdAt: Date.now(),
      });
    }
    return sessionId;
  };

  let escTimer: ReturnType<typeof setTimeout> | undefined;
  const armEscape = () => {
    if (escTimer) clearTimeout(escTimer);
    escTimer = undefined;
    if (!decoder.hasPendingEscape()) return;
    escTimer = setTimeout(() => {
      escTimer = undefined;
      if (decoder.takePendingEscape().length > 0) {
        input = "";
        render();
      }
    }, ESCAPE_TIMEOUT_MS);
  };

  stdout.write(ALT_ENTER + HIDE_CURSOR);
  try {
    render();

    let exiting = false;
    for await (const chunk of stdin) {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = undefined;
      }
      const keys = decoder.feed(chunk as Uint8Array);
      for (const key of keys) {
        if (key.ctrl && key.key === "c") {
          exiting = true;
          break;
        }
        // Ctrl+D (EOT) on an empty input line exits, matching REPL convention.
        if (key.ctrl && key.key === "d" && input.length === 0) {
          exiting = true;
          break;
        }
        if (key.key === "Enter") {
          const line = input;
          input = "";
          if (line.trim().length === 0) {
            render();
            continue;
          }
          if (line.startsWith("/")) {
            state.output = [];
            await ctx.commands.execute(line, { state, print: (t) => state.output.push(t) });
            if (state.output.includes("__exit__")) {
              exiting = true;
              break;
            }
            if (state.output.includes(CLEAR_SENTINEL)) {
              // Reset the transcript and conversation; chrome is redrawn in full.
              log.length = 0;
              log.push(bannerText());
              history = [];
              sessionId = undefined;
              renderer.reset();
            } else {
              log.push(`${line}`);
              for (const o of state.output) log.push(o);
            }
          } else {
            log.push(`› ${line}`);
            busy = true;
            render();
            const turn: UnifiedMessage[] = [...history, { role: "user", content: line }];
            const reply = await sendAndStream(ctx, providerId(), model(), line, log, render, history);
            busy = false;
            if (reply !== undefined) {
              history = [...turn, { role: "assistant", content: reply }];
              try {
                const sid = await ensureSession(line);
                await ctx.sessions.append(sid, "message", { role: "user", content: line });
                await ctx.sessions.append(sid, "message", { role: "assistant", content: reply });
              } catch (e) {
                log.push(`warning: session persistence failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
          settings = await ctx.settings.load();
          render();
          continue;
        }
        if (key.key === "Backspace") {
          input = input.slice(0, -1);
          render();
          continue;
        }
        if (key.key === "Escape") {
          input = "";
          render();
          continue;
        }
        if (key.key === "Space") {
          input += " ";
          render();
          continue;
        }
        if (key.alt || key.ctrl) continue;
        if (key.key.length === 1 || (key.key.length > 1 && !isControlName(key.key))) {
          input += key.key;
          render();
        }
      }
      if (exiting) break;
      armEscape();
    }
  } finally {
    if (escTimer) clearTimeout(escTimer);
    // Alt-screen + cursor + raw mode are restored on EVERY exit path
    // (Ctrl+C, Ctrl+D, /exit, stream close, or an exception in the loop).
    stdout.off("resize", onResize);
    try {
      stdin.setRawMode(false);
    } catch {
      // stdin may already be detached/closed — restoration is best-effort.
    }
    stdout.write(SHOW_CURSOR + ALT_LEAVE);
  }
}

/**
 * Stream a chat response into the log. Returns the accumulated assistant
 * text on success (so callers can persist it), or undefined when no text
 * was produced (error or empty stream). `history` carries earlier turns so
 * the model sees the whole conversation.
 */
export async function sendAndStream(
  ctx: AppContext,
  providerId: string,
  model: string | undefined,
  text: string,
  log: string[],
  render: () => void,
  history: UnifiedMessage[] = [],
): Promise<string | undefined> {
  if (!model) {
    log.push("(no model set: use /model <name> or set LGCY_MODEL)");
    render();
    return undefined;
  }
  const messages: UnifiedMessage[] = [...history, { role: "user", content: text }];
  const request: UnifiedChatRequest = { providerId, model, messages, stream: true };
  const responseIndex = log.length;
  let acc = "";
  try {
    for await (const ev of ctx.relay.stream(request, { secretResolver: ctx.secretResolver })) {
      if (ev.type === "text-delta") {
        acc += (ev.data as { text: string }).text ?? "";
        if (acc.length > 0) log[responseIndex] = acc;
        render();
      } else if (ev.type === "error") {
        const err = ev.data as { message: string };
        log.push(`error: ${err.message}`);
        render();
        return undefined;
      }
    }
  } catch (e) {
    log.push(`error: ${e instanceof Error ? e.message : String(e)}`);
    render();
    return undefined;
  }
  if (acc.length > 0) log[responseIndex] = acc;
  render();
  return acc.length > 0 ? acc : undefined;
}

/**
 * Word-wrap one log entry to `width` columns. Embedded newlines are kept;
 * words longer than the width are hard-split. Never truncates.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const para = raw.replace(/\t/g, "  ");
    if (para.length <= w) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(/( +)/)) {
      if (word.length === 0) continue;
      if (line.length + word.length <= w) {
        line += word;
        continue;
      }
      if (line.trim().length > 0) out.push(line.replace(/ +$/, ""));
      line = "";
      if (/^ +$/.test(word)) continue;
      let rest = word;
      while (rest.length > w) {
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      line = rest;
    }
    if (line.length > 0) out.push(line.replace(/ +$/, ""));
  }
  return out;
}

/** Prompt text for the input row, scrolled so the newest characters stay visible. */
export function inputWindow(input: string, width: number): string {
  const full = `› ${input}`;
  if (full.length <= width) return full;
  const room = Math.max(1, width - 3);
  return `› …${input.slice(-room)}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function isControlName(key: string): boolean {
  return ["Enter", "Tab", "Backspace", "Escape", "Space"].includes(key) || key.startsWith("Arrow") || key.startsWith("F");
}

function cursorToEnd(rows: number): string {
  return `\x1b[${rows};1H`;
}

// Entry point guard.
if (import.meta.main) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
