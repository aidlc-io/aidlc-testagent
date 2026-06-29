# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.0] - 2026-06-29

### Added

- **MCP server** (`ata-mcp` / `aidlc-testagent-mcp` binary) — exposes `ata_list`, `ata_plan`, `ata_run`, `ata_validate`, and `ata_explore` as MCP tools so any MCP-compatible client (Claude Desktop, Claude Code) can drive the agent without a terminal. Install via `npx aidlc-testagent-mcp` and configure in your client's MCP settings with `cwd` pointing to your project. See `integrations/README.md` for setup instructions.

---

## [0.4.3] - 2026-06-19

### Added

- **Live API call counter (`🌐 N`) in explore toolbar** — a new button in the manual explore toolbar tracks XHR/fetch requests in real time. The counter increments as you navigate; click it to open a popup table showing the last 50 API calls with method, URL path, status (colour-coded green/amber/red), and round-trip time.
- **HAR export on "Save & Done"** — clicking Save & Done automatically writes a [HAR 1.2](https://www.softwareishard.com/blog/har-12-spec/) file containing all XHR/fetch requests captured during the session. When use cases are defined, one file is written per use case (e.g. `dreem-dashboard.har`), sliced to that use case's step-time window; otherwise a single `<target>-explore.har` is written. Files land alongside `perception.json` in `generated/<target>/`.
- **Output paths shown in review panel** — the Done → review panel now displays a `📁 generated/<target>/` info block listing exactly where `perception.json`, HAR file(s), and use-case docs will be written. The HAR filename updates live as you type the test case name.

---

## [0.4.2] - 2026-06-19

### Added

- **Test case name field in Done → review panel** — a prominent input at the top of the review panel lets you name the entire session as a use case. Filling it in automatically creates a use case spanning all captured steps and triggers the LLM to generate a markdown test doc under `use-cases/<name>.md`. Leaving it empty saves without creating a use case.

### Fixed

- **Done button closed the review panel immediately** — a duplicate `click` listener set `__ataDone = true` before the review panel could open, causing the session to exit before the user could rename steps or fill in the test case name. Removed the premature listener; `__ataDone` is now only set when the user clicks "✅ Save & Done" inside the review panel.
- **Checkpoint popup row layout** — step rows now use `min-width: 0` + `white-space: nowrap` + `text-overflow: ellipsis` on the text block so long step names never wrap and the 👁 button stays pinned to the right edge regardless of content length.
- **Eye icon toggle state** — eye buttons now have three states: dim by default (closed), highlighted blue when a preview is open (active), and reset to dim when the preview is dismissed (via ✕ button, ESC, background click, or clicking the same eye button again). Only one preview can be open at a time; opening a new one auto-closes the previous. Closing the checkpoint popup also resets any open preview.

---

## [0.4.1] - 2026-06-19

### Added

- **Screenshot preview in review panel** — the Done→review step list now shows a 👁 eye icon on every row. Click to see a full-screen overlay of that step's screenshot, same as in the checkpoint popup.
- **`__ata_preview__` excluded from DOM observer** — the screenshot preview overlay no longer triggers a phantom DOM-idle snapshot.

---

## [0.4.0] - 2026-06-18

### Added

- **Named checkpoints (`📌`)** — click the 📌 button in the manual explore toolbar to open a popup listing all captured steps. Select a step, give it a name, and mark it as a *common precondition* (e.g. "logged in"). The checkpoint is saved as `generated/<target>/checkpoints/<name>.json` after Done.
- **Use-case recording (`🎬 / 🏁`)** — click 🎬 to mark the start of a use case, name it, navigate through the flow, then click 🏁 to close the range. The agent calls the LLM to produce a structured markdown manual-test document saved to `generated/<target>/use-cases/<name>.md`.
- **Auto step naming from DOM** — instead of generic "step N" labels, steps are named from the current DOM context in priority order: open dialog title → page heading → URL path segment → page title. Composite names combine the click action with context (e.g. `click "Save" — Edit Profile`).
- **Click-capture action names** — an in-page click listener (`capture: true` phase) sets the pending action name from the clicked element's `aria-label`, visible text, or `data-testid` before each snap. The walk-up logic skips inner SVG/icon nodes to find the nearest meaningful interactive ancestor.
- **Done → review panel** — clicking ✅ Done opens a scrollable review panel showing every step with an editable name input and the URL path. Rename any step before confirming; click "Keep exploring" to continue without saving.
- **Per-step screenshots** — a JPEG screenshot (quality 55, viewport only) is captured alongside each DOM snapshot and kept in memory for the session. Rendered in the checkpoint popup and review panel via 👁 eye icon → full-screen overlay.
- **SPA-safe fingerprinting** — step deduplication now includes URL + page title so single-page app route changes always produce a distinct step even when element counts are similar.
- **`ExploreCheckpoint` / `ExploreUseCase` types** added to `adapter.ts` and returned from `exploreManual()`.
- **`checkpointCount` / `useCaseCount`** surfaced in the CLI summary line after an explore session.

---

## [0.3.1] - 2026-06-18

### Changed

- `ata ask` and `ata guide` updated to cover the new `--manual`, `--reuse-perception`, and `ata explore` features introduced in v0.3.0.

---

## [0.3.0] - 2026-06-18

### Added

- **`ata explore <target>` command** — dedicated explore-only command; saves `perception.json` for later reuse without running the full agent loop.
- **`--manual` flag** — open a headed browser and navigate the app yourself. The agent watches via `MutationObserver` + `page.exposeFunction` callbacks, auto-snapping each DOM-idle state. A toolbar in the top-right corner (📌 Checkpoint / 🎬 Use case / ✅ Done) controls the session.
- **`--reuse-perception` flag** — skip the explore phase entirely and reuse the last saved `perception.json` on `ata plan` and `ata run`.
- **Session artefacts** — manual explore saves `.auth/<target>.json` (browser storage state captured after auth) and `generated/<target>/perception.json` (multi-step accessibility journey). Generated specs load the auth state automatically.
- **`explore.strategy: manual`** — target-level config to default a target to manual explore mode.
- **`explore.idle_timeout_ms`** — configurable debounce for DOM-idle snap triggering (default 2000 ms).

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

[0.4.2]: https://github.com/aidlc-io/aidlc-testagent/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/aidlc-io/aidlc-testagent/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/aidlc-io/aidlc-testagent/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/aidlc-io/aidlc-testagent/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/aidlc-io/aidlc-testagent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aidlc-io/aidlc-testagent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aidlc-io/aidlc-testagent/releases/tag/v0.1.0
