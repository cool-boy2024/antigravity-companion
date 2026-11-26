# AI_INSTALL.md — Gravity Companion Agent Installation Runbook

Deterministic, safety-first installation runbook for AI coding agents (**Google Antigravity**, **Claude Code**, **Codex**, and similar CLI/IDE agents). See [`docs/AGENTS.md`](docs/AGENTS.md) for repository architecture and safety invariants.

## Hard Safety Rules (Non-Negotiable)

1. **Zero runtime dependencies**: Do **not** run `npm install` or install external packages. Gravity Companion runs exclusively on the Node.js 22+ standard library.
2. **Respect opt-in hooks**: **Never** edit `hooks.json` to set `"enabled": true`, **never** edit global host hook files on the user's behalf, **never** patch Antigravity application binaries, and **never** read, copy, or transmit Google credentials, tokens, or `transcriptPath` files.
3. **Use the right working directory**:
   - Run `npm test`, `npm run check`, and `agy plugin ...` from the **Gravity Companion repository root**.
   - Pass `--workspace "<target_dir>"` pointing to the **user's project directory**, not the plugin repository itself (unless the user explicitly asks to track this repository).
4. **Protect session tokens**: `demo` and `serve` listen strictly on `127.0.0.1` and generate an ephemeral `#token=...` URL per launch. Report the URL directly to the local user only and remind them not to share it.
5. **Be truthful about verification and hook state**:
   - Never claim host hooks are active until the user manually enables `gravity-companion` in Antigravity and confirms events arrive.
   - Never run unreviewed shell commands through `node src/cli.js check`.

---

## Step 0: Clone Repository (if not already present)

If the user has not cloned the repository yet, clone it into a clean directory (for example `~/antigravity-companion`, or ask if a directory already exists at the chosen path):

```sh
git clone https://github.com/cool-boy2024/antigravity-companion.git
cd antigravity-companion
```

All commands in Steps 1–3 assume the current working directory is the cloned repository root.

---

## Step 1: Check Local Environment

Check Node.js (required: `>= 22`) and the official Antigravity CLI `agy` (optional for standalone workbench, required for native plugin installation):

```sh
node --version
agy --version
```

Decision rules:

- **`node --version` is missing or major version `< 22`**: **STOP.** Do not proceed. Inform the user that Gravity Companion requires Node.js 22+ and ask them to install or switch to Node 22+ first.
- **`agy` is available**: Optionally verify `agy plugin --help` succeeds, then run Step 3A.
- **`agy` is missing or has no `plugin` subcommand**: Do **not** fail. Skip Step 3A, continue with Step 2 and Step 3B (standalone local workbench), and report in Step 4 that native plugin installation was skipped because `agy` CLI was unavailable.

---

## Step 2: Verify Local Integrity

Run the built-in test suite and consistency checks before installing or starting anything:

```sh
npm test && npm run check
```

Decision rules:

- Require all tests to pass (`fail 0`) and `npm run check` to print `OK`.
- If either fails, **STOP** and report the exact error output to the user.

---

## Step 3: Native Plugin Installation & Preview / Workspace Setup

### 3A. Official Antigravity Native Plugin (only when `agy` CLI with `plugin` is available)

```sh
agy plugin validate --strict . --json
agy plugin install .
agy plugin list --json
```

Verification checks:

1. Confirm `agy plugin validate --strict . --json` reports zero errors and zero warnings.
2. Confirm `agy plugin list --json` lists `gravity-companion`.
3. Inspect the installed plugin directory reported by `agy plugin list --json` and verify that runtime directories and files (`src/`, `web/`, `data/`, `assets/`, `skills/`, `hooks.json`, `plugin.json`) exist there.
4. Keep `hooks.json` unmodified (`gravity-companion.enabled` remains `false`).

### 3B. Launch Instant Demo OR Initialize Target Workspace

Pick the option matching the user's request. If the user did not specify a target workspace path, default to **Option 1 (Instant Demo)** or ask which workspace directory they want to initialize.

#### Option 1: Instant Isolated Demo (zero-impact preview)

- For interactive shells where auto-opening the browser is desired:
  ```sh
  npm run demo
  ```
- For headless/agent shells where printing the loopback URL without opening a browser is cleaner:
  ```sh
  node src/cli.js demo
  ```

What this does:
- Creates an isolated temporary workspace with 2 pre-seeded Chinese tasks and 1 real passing local verification check (`local-runner`).
- Starts the local workbench strictly on `127.0.0.1:<port>` with an ephemeral session token.
- Automatically cleans up the temporary directory when stopped via `Ctrl+C` or `SIGTERM`.

> **Agent lifecycle note**: `demo` and `serve` stay running until stopped. If your agent runtime supports persistent background daemons, start `node src/cli.js demo` (or `npm run demo`) as a background process and read the printed `http://127.0.0.1:<port>/#token=...` URL. If background processes terminate when your turn ends, do not leave an orphaned process—verify the command works or give the user the exact `npm run demo` command to run in their own terminal.

#### Option 2: Initialize & Serve a Real User Workspace

Replace `<target_dir>` with the user's actual project directory (quote paths containing spaces; on Windows use e.g. `--workspace "C:\Users\you\Projects\demo"`):

```sh
node src/cli.js init --workspace "<target_dir>"
node src/cli.js doctor --workspace "<target_dir>"
node src/cli.js serve --workspace "<target_dir>" --open
```

What `init` does:
- Creates `<target_dir>/.antigravity-companion/` (mode `0700`) with `.gitignore` (`*`) and `opt-in` (`local-events-v1`).
- Authorizes local hook event recording **only** for `<target_dir>`. Uninitialized workspaces remain untouched.

---

## Step 4: Report Status & Next Steps to the User

Always end with a clear, concise summary covering:

1. **Environment**: Detected `node` version and `agy` version (or note standalone mode if `agy` is unavailable).
2. **Verification**: `npm test` pass count, `npm run check` (`OK`), and `agy plugin validate --strict .` / `agy plugin install .` results (including installed path if installed).
3. **Workbench access**:
   - The active loopback URL (`http://127.0.0.1:<port>/#token=...`) if running, or the exact command (`npm run demo` / `node src/cli.js serve --workspace "<target_dir>" --open`) to start it locally.
   - Reminder: the URL contains a single-session access token and binds to `127.0.0.1` only — **do not share the link**.
4. **How to enable official hooks (explicit user opt-in)**:
   - Remind the user that event collection requires **both** opt-in gates:
     1. Run `node src/cli.js init --workspace "<target_dir>"` on each project they want to track.
     2. Manually enable the `gravity-companion` hook in Antigravity's **Customizations / Hooks** panel (exact menu wording may vary by client version; `node` must be on `PATH` for hook processes).
   - Recommend starting a new non-sensitive session to verify events appear in the workbench Activity panel, or checking `node src/cli.js doctor --workspace "<target_dir>"`.
   - Confirm explicitly that hooks were **not** force-enabled, no host binaries were modified, and no Google credentials were accessed.

---

## Step 5: Exact Uninstall & Cleanup

When the user wants to stop using or completely remove Gravity Companion:

1. **Disable the hook in Antigravity**: Toggle `gravity-companion` **OFF** in Antigravity's **Customizations / Hooks** panel.
2. **Stop any running local workbench**: Press `Ctrl+C` (or send `SIGTERM`) to stop `demo` or `serve`. (`demo` automatically deletes its temporary directory.)
3. **Uninstall the native plugin** (if installed via `agy`):
   ```sh
   agy plugin disable gravity-companion
   agy plugin uninstall gravity-companion
   agy plugin list --json
   ```
   Confirm `gravity-companion` no longer appears in `agy plugin list --json` (check `agy plugin --help` if your CLI version uses different flags).
4. **Remove local workspace data (optional)**: Only if the user no longer needs saved tasks, receipts, or event logs in `<target_dir>`:
   - macOS / Linux:
     ```sh
     rm -rf "<target_dir>/.antigravity-companion"
     ```
   - Windows (PowerShell):
     ```powershell
     Remove-Item -Recurse -Force "<target_dir>\.antigravity-companion"
     ```
5. **Remove the cloned repository (optional)**: Delete the cloned `antigravity-companion` folder. Because Gravity Companion never modifies host binaries or credentials, no Antigravity reinstall or rollback is needed.
