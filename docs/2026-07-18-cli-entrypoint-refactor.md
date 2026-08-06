# LGCY command-line entrypoint refactor

## Outcome

Make LGCY behave like a normal installed command before it enters its interactive terminal interface. The interactive client, provider behavior, broker integration, and secret handling must remain unchanged.

## Confirmed gap

The compiled client works in a real terminal, but command-line flags are currently ignored. `lgcy --help </dev/null` probes the project and auth broker, prints the non-interactive status, and exits 0 instead of showing help. There is also no `lgcy` launcher in the user's normal local binary directory.

## Allowed refactor

- Parse process arguments before creating the application or contacting the broker.
- Support `--help` and `-h` with concise usage text.
- Support `--version` and `-V` using the application's single version constant.
- Reject unknown flags with a short error, usage hint, and a conventional nonzero usage exit code.
- Install or link the compiled binary as `~/.local/bin/lgcy` through a repeatable project script or documented build/install command.
- Add focused tests proving the early command path performs no broker, project, session, or terminal work.
- An optional read-only `doctor` or `status` command is allowed only if it is small, secret-free, and covered by deterministic tests. It is not required for acceptance.

## Acceptance metrics

The refactor is useful only when all checks below pass:

1. `lgcy --help </dev/null` exits 0, contains `Usage`, and contains neither broker status nor the `no tty` message.
2. `lgcy --version </dev/null` exits 0 and prints exactly one stable version line.
3. An unknown option exits nonzero and prints a concise usage error.
4. Unit tests prove help, version, and unknown-option handling short-circuit before any broker health call or project discovery.
5. `bun test` passes with no failures and at least the existing 281-test baseline plus new entrypoint tests.
6. `bunx tsc --noEmit` exits 0.
7. `bun run build` exits 0 and produces `dist/lgcy`.
8. `~/.local/bin/lgcy` resolves to the freshly built command and `~/.local/bin/lgcy --version` passes.
9. A real terminal smoke run of `/help`, `/providers`, and `/exit` exits 0 and restores normal cursor, raw-mode, and alternate-screen state.

## Boundaries

- Never print credentials, bearer tokens, broker snapshots, or secret-bearing environment values.
- Do not alter the provider registry, streaming pipeline, stored-session format, or TUI command meanings.
- Preserve unrelated existing local edits.
- Do not commit or push.

## Verification receipt

The implementing agent must report exact changed files, focused entrypoint test output, total test counts, typecheck and build exit codes, installed-path resolution, and the real-terminal restoration result.
