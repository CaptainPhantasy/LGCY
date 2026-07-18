/**
 * Composition root + entry point. Wires every layer per ADR-0001's dependency
 * direction (core ← broker ← gateway ← services ← app) and registers the
 * built-in slash commands. `createApp` is the testable factory; `main` is the
 * process entry that runs an interactive TUI loop when stdin is a TTY and a
 * status report otherwise.
 */

import { BUILT_IN_PROVIDERS, ProviderRegistry } from "../gateway/providers";
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
import { HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN, Color } from "../tui/ansi";
import type { SecretResolver, UnifiedChatRequest, UnifiedMessage } from "../core/contracts";

const VERSION = "0.1.0";
const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";

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
}

export function createApp(opts: CreateAppOptions = {}): AppContext {
  const cwd = opts.cwd ?? process.cwd();
  const broker = opts.broker ?? new BrokerClient();
  const secretResolver = createSecretResolver({ broker });
  const registry = new ProviderRegistry(BUILT_IN_PROVIDERS);
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
      ctx.print("Commands: /help /providers /model <id> /tasks /clear /exit");
    },
  });
  reg.register({
    id: "providers",
    description: "List configured providers",
    run: (_argv, ctx) => {
      for (const p of ctx.state.registry.list()) {
        const flag = p.enabled ? "\u2713" : "\u2717";
        ctx.print(`${flag} ${p.id} (${p.dialect}) → ${p.baseUrl}`);
      }
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
      const list = ctx.state.tasks.list();
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
    description: "Clear the screen",
    run: (_argv, ctx) => ctx.print(CLEAR_SCREEN),
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
  const status = brokerHealthy === null ? "broker: unknown" : brokerHealthy ? "broker: online" : "broker: offline";
  lines.push(status);
  if (project) lines.push(`project: ${project.name} (${project.kind}) @ ${project.root}`);
  const providerSummary = ctx.registry.list().map((p) => p.id).join(", ");
  lines.push(`providers: ${providerSummary}`);
  return lines.join("\n");
}

/* --------------------------- Interactive loop ----------------------------- */

export async function main(): Promise<void> {
  const ctx = createApp();
  const projectInfo = await ctx.project.discover(ctx.cwd).catch(() => undefined);
  const brokerHealthy = await ctx.broker.health().catch(() => null);

  if (!process.stdin.isTTY) {
    process.stdout.write(banner(ctx, brokerHealthy, projectInfo) + "\n");
    process.stdout.write("(no tty — interactive shell unavailable)\n");
    return;
  }

  await runInteractive(ctx, brokerHealthy, projectInfo).catch((e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  });
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
  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;

  const decoder = new KeyDecoder();
  const renderer = new Renderer();
  const log: string[] = [banner(ctx, brokerHealthy, projectInfo)];
  let input = "";
  let settings: AppSettings = await ctx.settings.load();
  const defaultProvider = settings.defaultProviderId ?? ctx.registry.list()[0]?.id ?? "openai";

  const render = () => {
    const buf = new ScreenBuffer(cols, rows);
    buf.clear();
    let y = 0;
    for (const line of log.slice(-rows + 3)) {
      buf.writeText(0, y, truncate(line, cols), { fg: Color.brightWhite });
      y++;
    }
    // Input line.
    buf.fillRow(rows - 2, 0, cols - 1, "─", { dim: true });
    const prompt = `\u276F ${input}`;
    buf.writeText(0, rows - 1, truncate(prompt, cols), { fg: Color.green, bold: true });
    stdout.write(renderer.render(buf));
    stdout.write(cursorToEnd(rows));
  };

  const state: CommandState = { settings: ctx.settings, registry: ctx.registry, tasks: ctx.tasks, output: [] };
  const print = (text: string) => log.push(text);

  stdout.write(ALT_ENTER + HIDE_CURSOR);
  render();

  let exiting = false;
  for await (const chunk of stdin) {
    const keys = decoder.feed(chunk as Uint8Array);
    for (const key of keys) {
      if (key.ctrl && key.key === "c") {
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
          const matched = await ctx.commands.execute(line, { state, print: (t) => state.output.push(t) });
          if (state.output.includes("__exit__")) {
            exiting = true;
            break;
          }
          log.push(`${line}`);
          for (const o of state.output) log.push(o);
          void matched;
        } else {
          log.push(`\u276F ${line}`);
          await sendAndStream(ctx, defaultProvider, settings.defaultModel, line, log, render);
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
      if (key.key.length === 1 || (key.key.length > 1 && !isControlName(key.key))) {
        input += key.key;
        render();
      }
    }
    if (exiting) break;
  }

  stdout.write(SHOW_CURSOR + ALT_LEAVE);
  stdin.setRawMode(false);
}

export async function sendAndStream(
  ctx: AppContext,
  providerId: string,
  model: string | undefined,
  text: string,
  log: string[],
  render: () => void,
): Promise<void> {
  if (!model) {
    log.push("(no default model set — use /model <name>)");
    render();
    return;
  }
  const messages: UnifiedMessage[] = [{ role: "user", content: text }];
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
        return;
      }
    }
  } catch (e) {
    log.push(`error: ${e instanceof Error ? e.message : String(e)}`);
    render();
    return;
  }
  if (acc.length > 0) log[responseIndex] = acc;
  render();
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
  main();
}
