# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-06-18

### Added

- **`output_dir` target config** — write generated specs directly into an external repo (e.g. a separate `lhappautotest` directory) instead of `generated/<target>/tests/`. The runner automatically sets `testDir` to the external path and resolves that repo's `node_modules`.
- **`--reuse` flag for `ata run`** — skip plan + generate if spec files already exist under the target's output dir; jump straight to execution. Useful for iterating on tests without re-spending LLM budget.
- **`ata ask <prompt>` command** — ask the AI a natural-language question about `ata` config or setup. Falls back to `claude-cli` even if no project config exists yet.
- **`ata guide` command** — print a step-by-step getting-started reference in the terminal.
- **`surface_guide` per-target config** — override the adapter's default LLM surface-guide prompt when you need custom page-acquisition instructions.
- **Oracle spec injection for Electron** — the Electron adapter now loads up to 8 real spec files from `context.manual_tests` and injects them into the generator prompt so the LLM learns real selector patterns and `PageHelper` usage from your existing test suite.
- **`llm.timeout_ms` config** — per-provider LLM call timeout (ms), wired through to `ClaudeCliProvider`.
- **`omitEnv` in `runCommand`** — strip specific env vars before spawning child processes. Used to strip `ANTHROPIC_API_KEY` (prevents "Invalid API key" when running inside environments that set it) and `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` (prevents Playwright's Electron launcher from being hijacked by the parent shell).
- **npm package metadata** — added `homepage`, `repository`, and `bugs` fields pointing to the GitHub repo.

### Fixed

- **`auth.strategy: external` now runs via an interactive login shell** (`-ilc` instead of `-lc`) so that PATH-managed tools (e.g. `npx`, `yarn`) and user-exported env vars are available during pre-auth commands.
- **Electron: kill lingering process before launch** — a leftover process from a previous interrupted run caused `electron.launch()` to fail with "Process failed to launch!". The adapter now runs `pkill -f <appName>` (macOS/Linux) or `taskkill` (Windows) and waits 2 s before re-launching.
- **Electron: strip `ELECTRON_RUN_AS_NODE` from launch env** — when `ata` is invoked from Claude Code (which sets this var), Electron was treating itself as a bare Node.js process instead of launching the GUI. The adapter and Playwright runner now strip this variable.
- **Electron + `output_dir`: close `ata`-managed window before fixture-managed run** — when specs live in an external repo that manages its own Electron fixture, `ata` closes its own window first to avoid a race with an already-running instance.
- **Healer reads specs from absolute path when `output_dir` is set** — previously the healer always joined `workdir + filePath`, causing a read error for externally-written specs.
- **`bin` paths in `package.json`** — removed superfluous `./` prefix (`./dist/cli/index.js` → `dist/cli/index.js`) for compatibility with all npm versions.

### Changed

- `AdapterDeps` now includes `baseDir` so adapters can resolve context globs (e.g. oracle spec loading) without coupling to the orchestrator.
- `ExecOpts` now includes `outputDir` so the Playwright runner can set `testDir` correctly for external-repo specs.
- Orchestrator log messages use bracketed stage prefixes (`[auth]`, `[explore]`, `[plan]`, `[generate]`, `[execute]`, `[heal]`) for easier log scanning.

---

## [0.1.0] - 2026-06-01

### Added

- **Phase 1 initial release.**
- `playwright-web` adapter — any Chromium-based web target.
- `playwright-electron` adapter — Electron desktop apps.
- Core agent loop: `explore → plan → [CONFIRM] → generate → execute (+stability gate) → heal`.
- Planner with context grounding (requirements → manual tests → business rules → source).
- Generator: one LLM call per scenario (concurrency 4), `@playwright/test` specs with POMs.
- Stability gate: each test runs N times; flaky → quarantined, not green suite.
- Self-healer: failing specs fed back to LLM to repair selectors/assertions, up to `max_heal_attempts`.
- Cost guard: per-run `max_budget_usd` ceiling, meters every LLM call.
- Auth: `form`, `none`, `api`, `reuse-state` strategies; session stored under `.auth/` (gitignored).
- `auth.strategy: external` — run a pre-auth shell command before the app launches.
- CLI commands: `validate`, `plan`, `run`, `list`, `config` (interactive wizard), `report` (Phase 2 stub).
- Flags: `--feature`, `--scope`, `--diff`, `--yes`, `--plan`, `--dry-run`, `--headed`, `--refresh-auth`.
- Config: `testagent.config.yaml` + per-target `targets/*.target.yaml`; Zod validation throughout.
- `env: staging-only` host guard — blocks production-looking URLs unless explicitly allowlisted.
- Action guardrail stub: destructive verbs flagged/blocked via `onDestructive` config.
- No telemetry, no model API keys — all reasoning delegated to a locally-logged-in CLI.

[0.2.0]: https://github.com/aidlc-io/aidlc-testagent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aidlc-io/aidlc-testagent/releases/tag/v0.1.0
