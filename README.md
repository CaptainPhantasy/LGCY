# lgcy

Operator-grade terminal interface for agentic development on the omp platform.

LGCY is a zero-runtime-dependency TUI that bridges the omp auth-broker
credential vault to OpenAI- and Anthropic-dialect providers, with a custom
differential ANSI renderer, append-only JSONL session persistence, and a
provider-neutral streaming pipeline.

## Architecture

Single package, layered by directory (ADR-0001). Dependency direction is
strictly downward; nothing above a layer imports its internals.

```
src/
  core/       domain contracts, lifecycle, resilience (zero deps)
  gateway/    provider adapters, SSE parser, stream normalization, relay
  broker/     omp auth-broker client + secret resolver
  services/   sessions, files, project, git, settings, tasks
  tui/        ANSI codes, screen buffer, differential renderer, key decoder, commands
  app/        composition root + interactive entry point
```

### Streaming pipeline

A `UnifiedChatRequest` flows through the gateway relay:

```
UnifiedChatRequest
  → providers.ts   (URL + auth headers, registry resolution)
  → translate.ts   (unified → OpenAI / Anthropic wire body)
  → fetch (abort + timeout)
  → sse.ts         (incremental SSE parser)
  → normalize.ts   (dialect normalizer, exactly-one-terminal guarantee)
  → UnifiedStreamEvent stream
```

Every failure mode maps to an `UpstreamError.source`
(`local-config | local-validation | gateway-transport | timeout | cancelled |
provider | stream-parser`) and is preserved end to end.

### Credentials

`CredentialReference` names *where* a secret lives; it never holds the value.
`createSecretResolver` resolves `env` / `auth-broker` / `none` references into
request-time secrets. OAuth access tokens and API keys are extracted from the
broker snapshot per its wire schema; refresh tokens are never used (they arrive
as the `__remote__` sentinel). No secrets are ever persisted — `scrubSecrets`
enforces this before any session write.

## Getting started

```bash
bun install
bun test          # 196+ tests
bunx tsc --noEmit # strict typecheck
bun run src/app/main.ts
```

### Build a single binary

```bash
bun run build     # → dist/lgcy (compiled)
```

## Slash commands

| Command | Action |
|---------|--------|
| `/help` | List commands |
| `/providers` | List configured providers |
| `/model <name>` | Set default model |
| `/tasks` | Show task list |
| `/clear` | Clear screen |
| `/exit` | Quit |

## Keybindings

- `Enter` — send message / run command
- `Ctrl+C` or `/exit` — quit
- `Esc` — clear input line
- `Backspace` — delete

## Design decisions

See `docs/adr/0001-runtime-and-architecture.md` for the full rationale:
Bun + TypeScript (strict), custom differential ANSI renderer (no Ink/React),
append-only JSONL sessions under `~/.lgcy/sessions/`, and a provider core that
uses only WHATWG fetch/streams (portable to Node).

## Status

The gateway, broker, services, TUI rendering core, and composition root are
implemented and tested. See `docs/loop/PROGRESS.md` for the cross-cycle ledger.
