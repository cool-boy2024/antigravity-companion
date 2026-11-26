# CLAUDE.md

Instructions for Claude Code working in the **Gravity Companion** (`gravity-companion`) repository.

## Start Here

- **Installing or onboarding for a user**: Read and execute [`AI_INSTALL.md`](AI_INSTALL.md) verbatim.
- **Repository architecture & engineering rules**: Read [`docs/AGENTS.md`](docs/AGENTS.md) and [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Essential Commands (from Repository Root)

```sh
npm test                                # Full Node.js 22+ built-in test suite
npm run check                           # Syntax, JSON, manifest/UI version & zero-dep check
npm run demo                            # Launch isolated temporary demo workbench
npm run package                         # Build dist/gravity-companion-<version>.zip + SHA256SUMS
agy plugin validate --strict . --json   # Validate native plugin when agy CLI is available
```

## Non-Negotiable Constraints

- Requires **Node.js 22+** with **zero runtime dependencies** (do not run `npm install` or add `dependencies`).
- Keep hooks opt-in: never edit `hooks.json` to force `"enabled": true`, never touch host binaries or user credentials, and never read `transcriptPath` or prompt text.
- Point `--workspace <target_dir>` at the user's actual project directory, not this plugin repository, unless explicitly requested.
- Do not infer test passage from hook events; only explicit `node src/cli.js check` executions produce local verification receipts.
