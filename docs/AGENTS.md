# AGENTS.md — Gravity Companion

Guidance for AI coding agents (Google Antigravity, Codex, Claude Code, etc.) working with or installing **Gravity Companion** (`gravity-companion`).

> **Note on file location**: This guide lives at `docs/AGENTS.md` (instead of the plugin root or `rules/AGENTS.md`) so `agy plugin validate --strict .` passes with zero warnings and installing the plugin never injects repository setup/dev instructions as an always-on global rule into unrelated user conversations.

## Installing or Setting Up for a User

Follow [`../AI_INSTALL.md`](../AI_INSTALL.md) step by step. Do not skip environment checks or local integrity verification, and never force-enable hooks on the user's behalf.

## Core Commands (Run from Repository Root)

- `npm test` — Run the full Node.js 22+ built-in test suite (`node --test`).
- `npm run check` — Verify JS syntax, JSON validity, `plugin.json`/`package.json`/`web/index.html` version consistency, required AI deployment docs (`AI_INSTALL.md`, `CLAUDE.md`, `docs/AGENTS.md`), and zero runtime dependencies.
- `npm run demo` — Start an isolated temporary demo workspace with 2 pre-seeded Chinese tasks and 1 real passing local check (`node src/cli.js demo --open`; omit `--open` via `node src/cli.js demo` in headless shells).
- `npm run package` — Build reproducible `dist/gravity-companion-<version>.zip` and `dist/SHA256SUMS`.
- `agy plugin validate --strict . --json` — Validate official Antigravity plugin manifest, hooks, and skills with zero errors and zero warnings (when `agy` CLI is installed).

## Architecture & Safety Invariants

- **Runtime**: Node.js `>= 22`, ESM, **zero third-party runtime dependencies** (`package.json` must have no `dependencies`; `npm install` is not required).
- **Opt-in hooks only**: `hooks.json` keeps `"enabled": false` by default, and `src/cli.js hook` refuses to write events unless the target workspace has `.antigravity-companion/opt-in` created by `node src/cli.js init --workspace <dir>`. Never silently enable hooks, patch host binaries, or read Google credentials / `transcriptPath` / prompts / raw tool args.
- **Evidence boundary**: `node src/cli.js check` executes exact `argv` with `shell: false` and records before/after workspace fingerprints. Never treat hook `PostToolUse` or `Stop` events as proof that tests passed.
- **Local-only UI**: `src/server.js` binds strictly to `127.0.0.1` with an ephemeral per-launch Bearer token and no command-execution HTTP endpoint. Never share `#token=...` URLs externally.

## Key Documentation

- [`../AI_INSTALL.md`](../AI_INSTALL.md) — Deterministic agent installation & uninstall runbook.
- [`../CLAUDE.md`](../CLAUDE.md) — Quick entrypoint for Claude Code.
- [`../README.md`](../README.md) — User overview, screenshots, and CLI reference.
- [`INTEGRATION.md`](INTEGRATION.md) — Official Antigravity plugin & lifecycle hook integration details.
- [`CONTRACT.md`](CONTRACT.md) — Core storage, verification receipt, and HTTP API contract.
- [`VALIDATION.md`](VALIDATION.md) — Release verification record and scope boundaries.
- [`../skills/task-handoff/SKILL.md`](../skills/task-handoff/SKILL.md) — Bundled task handoff skill instructions.
