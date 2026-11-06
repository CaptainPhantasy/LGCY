# ADR-0001: Runtime, language, package boundary, and TUI rendering approach

Status: Accepted (cycle 2, 2026-07-17)

## Context

Greenfield standalone TUI ("LGCY") for OpenAI-compatible, Anthropic-compatible,
and OpenCode-routed model providers with optional local auth-broker integration.

- The surrounding toolchain is Bun + TypeScript with compiled single-binary
  packaging.
- An optional local auth broker (default 127.0.0.1:17384) can supply
  credentials; LGCY talks to it over a small documented wire schema and never
  stores secrets itself.
- The directive requires a zero-dependency provider-network core (standard
  runtime facilities only — fetch, streams, AbortController), but allows a
  TUI framework.

## Decision

1. **Runtime: Bun 1.3 + TypeScript (strict).** Matches the platform, native
   TS execution, built-in test runner (`bun test`), and single-binary
   packaging (`bun build --compile`). Node 26 remains a compatibility target
   for the provider core (it uses only WHATWG fetch/streams APIs).
2. **Single package, layered by directory** rather than a workspace monorepo:
   - `src/core/` — shared domain contracts, events, lifecycle. No imports
     from other layers. Zero runtime dependencies.
   - `src/gateway/` — loopback HTTP relay, provider adapters, SSE parser,
     stream normalization. Imports `core` only. Zero runtime dependencies.
   - `src/broker/` — optional auth-broker client (credential references). Imports
     `core` only.
   - `src/services/` — sessions, projects, git, files, PTY, tasks. Imports
     `core`, `broker`, `gateway`. Sibling imports WITHIN services/ are
     explicitly permitted (e.g. `TaskStore` persists through the `SessionStore`
     type); the boundary test enforces this as an intentional carve-out, not
     an oversight.
   - `src/tui/` — renderer, layout, focus, keymap, command registry,
     surfaces. Imports `core` + `services` events only; never provider wire
     types.
   - `src/app/` — entry point and composition root.
   Dependency direction is enforced by review + an architecture-boundary test
   that greps imports (cheap, no extra tooling).
3. **TUI rendering: custom differential ANSI renderer** (no Ink/React, no
   external TUI framework). Rationale: the surfaces required are dense,
   stream-heavy, and need exact control over repaint regions ("no
   full-screen redraw per token"); a row-diff renderer over an in-memory
   screen buffer is small (~500 lines), dependency-free, testable
   (render-to-string), and works over SSH/tmux. This also keeps the whole
   application at zero runtime dependencies, matching platform packaging.
4. **PTY strategy**: prefer Bun's native PTY support if empirically verified;
   fallback is spawning through `/usr/bin/script -q /dev/null <shell>`
   (macOS) / `script -qfc` (Linux), which allocates a real kernel PTY with
   no native modules. Decision finalized in the PTY cycle with receipts.
5. **Persistence**: append-only JSONL session records with schema version
   headers under `~/.lgcy/sessions/` (crash-safe appends, migration hook at
   load). No secrets ever persisted.

## Consequences

- No React ecosystem for UI; components are plain functions over a screen
  buffer. Focus/layout logic is bespoke but fully unit-testable.
- Provider core is portable to future platform surfaces unchanged.
- Single package keeps 5-minute build cycles fast (no workspace plumbing).
