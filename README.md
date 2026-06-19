# aidlc-testagent

[![npm](https://img.shields.io/npm/v/aidlc-testagent)](https://www.npmjs.com/package/aidlc-testagent)
[![license](https://img.shields.io/npm/l/aidlc-testagent)](LICENSE)

> **Point it at a target, approve the plan, get a passing test suite back.**

An open-source AI test agent for **web**, **Electron desktop**, **REST API**, and
**mobile** targets. Grounded on your project's existing requirements, manual test
cases, and business rules, it **proposes a test pipeline, lets you confirm it,
then generates, executes, and self-heals** real, committable Playwright specs.

- 🧠 **One shared agent loop**, surface-agnostic: `explore → plan → [confirm] → generate → execute (+stability) → heal`.
- 🕹️ **Manual explore mode**: navigate the app yourself while the agent watches, auto-snapping each DOM-idle state — then reuse the recorded session for plan/run without re-opening the browser.
- 🔌 **Pluggable adapters** behind one contract. Phase 1 ships `playwright-web` and `playwright-electron` (shared driver + perception).
- 📚 **Context-grounded**: human intent (requirements → manual tests → business rules) outranks source code; intent/implementation disagreements are surfaced as findings, not silently coded around.
- 🙋 **Human-in-the-loop**: a confirmation gate shows the proposed pipeline and writes `plan.md` before any code is generated.
- 🧪 **Reliability built in**: auth/session reuse, a flaky-test **stability gate**, and a **cost budget guard** are first-class.
- 🔐 **No telemetry. No model API keys.** See [Security & Privacy](#security--privacy).

> **Phase 1 (this build):** Web + Electron desktop + the reliability core.
> REST and iOS adapters, the traceability report, `--diff` mode, and Claude
> Code skill / MCP packaging arrive in later phases (see [Roadmap](#roadmap)).

---

## No telemetry

`aidlc-testagent` collects and transmits **no usage data of any kind** — no
analytics SDK, no phone-home, by default or otherwise. It also stores **no model
API keys**: all reasoning is delegated to a locally logged-in LLM CLI (e.g.
`claude`), whose auth and billing are entirely its own responsibility. This is a
stated product promise, not just a default.

## How it works

```
                ┌─────────────────────────────────────────────┐
                │              CORE (shared brain)              │
                │  orchestrator → planner →[CONFIRM]→ generator │
                │       → executor (+stability gate) → healer   │
                └───────────────────┬───────────────────────────┘
                                    │  ADAPTER CONTRACT
        ┌───────────────┬───────────┼───────────┬───────────────┐
        ▼               ▼           ▼           ▼               ▼
  playwright-web  playwright-    rest-api    appium-ios     (future:
                  electron       (Phase 2)   (Phase 4)       android, …)
```

The core never imports Playwright or any surface library — it talks only to an
**adapter** (which owns *perception* and *driving*) and to an **`LlmProvider`**
(which shells out to a local CLI). Swapping the reasoning engine is a one-line
config change.

## Quickstart

```bash
# 1. Install
npm install
npx playwright install chromium

# 2. Make sure a local LLM CLI is logged in (default: Claude Code)
claude --version        # https://docs.claude.com/claude-code

# 3. Configure interactively (or hand-write testagent.config.yaml)
npx ata config

# 4. Propose a plan (no code generated)
npx ata plan todomvc

# 5. Run the full loop: plan → confirm → generate → execute → heal
npx ata run todomvc

# 6. Gate CI: run every target, PASS/FAIL table, non-zero exit on failure
npx ata validate
```

(`ata` is the short alias for the `aidlc-testagent` binary.)

### Scoped runs

```bash
ata run saucedemo --feature docs/requirements/checkout.md   # one requirement file
ata run saucedemo --scope checkout                          # a declared feature
ata run saucedemo --diff main                               # flows near a git diff (Phase 3)
ata run todomvc --yes                                       # skip the confirmation prompt
ata run todomvc --dry-run                                   # generate only, skip execution
ata run todomvc --plan generated/todomvc/plan.json          # generate from an approved/edited plan
ata run todomvc --reuse                                     # skip plan+generate, run existing specs
```

### Manual explore — navigate once, plan many times

> **Drive the browser yourself — the agent turns it into a test.**
>
> Navigate your app freely while `ata` watches silently. Every DOM idle and every click is auto-snapped with a meaningful name (`click "Generate" — studio`). Pin checkpoints, record use-case flows, preview each step's screenshot. Hit Done, name the session, and the agent writes the test doc.

```bash
# Step 1 — Open the browser, navigate freely, click "✅ Done" when finished.
ata explore myapp --manual --headed

# Step 2 — Plan and run using the recorded session. No browser reopened.
ata plan myapp --reuse-perception
ata run  myapp --reuse-perception --yes
```

Record once, run many times — including in CI.

`--manual` also works inline on `plan` and `run`:

```bash
ata plan myapp --manual --headed          # explore → plan in one shot
ata run  myapp --manual --headed --yes    # explore → plan → generate → execute
```

#### Auto step naming

Every step is named automatically from the DOM — no typing required as you navigate:

- **Click actions** — prefixed with the element label: `click "Save" — Edit Profile`
- **DOM context** — falls back in order: open dialog title → page heading → URL path segment → page title

#### In-browser toolbar

| Button | What it does |
| --- | --- |
| **📌 Checkpoint** | Lists all captured steps. Select one, name it, optionally mark as *common precondition* (e.g. "after-login"). Saved to `checkpoints/<name>.json`. Each step shows a **👁** eye button to preview its screenshot. |
| **🎬 Use case** | Pick a start step and name the flow, navigate through it, then click **🏁 End**. The agent calls the LLM and produces a markdown manual-test doc under `use-cases/<name>.md`. |
| **✅ Done** | Opens the review panel. |

#### Done → review panel

1. **Test case name** *(optional)* — name the entire session as a use case. The agent generates a markdown test doc covering all steps.
2. **Step list** — every captured step with an editable name input and its URL path.
3. **👁 eye toggle** — dim by default; click to preview that step's screenshot full-screen (icon turns blue). Click again, press **ESC**, or click the dark background to close.
4. **Keep exploring** to continue, **✅ Save & Done** to save everything.

#### Saved artefacts

| Path | Description |
| --- | --- |
| `generated/<target>/perception.json` | Full journey (accessibility tree + step names). Reuse with `--reuse-perception`. |
| `generated/<target>/use-cases/<name>.md` | LLM-generated markdown test doc for each recorded use case. |
| `generated/<target>/checkpoints/<name>.json` | Named checkpoints (common preconditions). |
| `.auth/<target>.json` | Browser `storageState` captured after auth. Generated specs load it automatically. |

Target-level config:

```yaml
explore:
  strategy: manual          # auto (default) | manual
  idle_timeout_ms: 2000     # ms of DOM quiet before auto-snap (default 2000)

auth:
  strategy: reuse-state     # load session saved by the last explore run
  store_state: .auth/myapp.json
```

## Configuration

A root `testagent.config.yaml` plus one file per target. Credentials are **never**
in YAML — `credentials_env` names the env vars to read at run time.

```yaml
# testagent.config.yaml
version: 1
env: staging-only          # refuse non-staging/non-public hosts (allowlist enforced)
llm:
  provider: claude-cli     # shell out to a locally logged-in CLI
  model: claude-sonnet-4-6
  bare: true               # reproducible CI runs
defaults:
  max_heal_attempts: 2
  approval: prompt         # prompt | auto | manual-edit
  max_budget_usd: 2.00     # cost guard per target run; 0 = unlimited
  stability:
    runs: 3                # run each new test N times; accept only if all pass
    quarantine: true       # flaky tests → quarantine, not the green suite
targets:
  - include: targets/public/*.target.yaml
  - include: targets/private/*.target.yaml   # gitignored; optional
```

```yaml
# targets/public/saucedemo.target.yaml
name: saucedemo
adapter: playwright-web
url: https://www.saucedemo.com
auth:
  strategy: form
  credentials_env: SAUCE_USER, SAUCE_PASS    # read from env, never YAML
  store_state: .auth/saucedemo.json          # reusable session (gitignored)
context:                                     # grounding, in trust order
  requirements: [docs/requirements/checkout.md]
  manual_tests: [test-cases/checkout.md]
scope:
  feature: checkout
success:
  min_scenarios: 3
  must_pass: true
# output_dir: ../other-repo/tests/ata-generated   # write specs to an external repo
# surface_guide: "Custom Playwright guidance…"    # override LLM surface prompt
```

Don't want to learn the schema? Run `ata config` — it auto-detects your stack
(Electron dep → `playwright-electron`, OpenAPI file → `rest-api`, else
`playwright-web`; prefills context globs from `docs/requirements/`,
`test-cases/`, `docs/domain/`), prompts for the rest, validates with the **same
Zod schema** the loader uses, and never overwrites files silently.

## CLI

| Command | What it does |
| --- | --- |
| `ata explore <target>` | Observe the target and save `perception.json` for reuse (supports `--manual`) |
| `ata validate` | Run all targets, print a PASS/FAIL table, exit non-zero on failure (CI gate) |
| `ata plan <target>` | Propose a pipeline + write `plan.md` (never generates) |
| `ata run <target>` | `plan → confirm → generate → execute → heal` |
| `ata list` | List configured targets and adapters |
| `ata config [add\|target <name>\|show]` | Interactive wizard / inspect effective config |
| `ata ask <prompt>` | Ask the AI a question about config or setup (answers in plain language) |
| `ata guide` | Print a step-by-step getting-started reference |
| `ata report <target>` | Requirement → test traceability matrix (Phase 2) |

Flags: `--feature <file>`, `--scope <name>`, `--diff <ref>`, `--yes`,
`--plan <file>`, `--dry-run`, `--reuse`, `--manual`, `--reuse-perception`,
`--headed`, `--refresh-auth`, `-c/--config <path>`.

Approval: an interactive TTY prompts to confirm/edit/abort; `--yes` (or
`approval: auto`) skips it; CI / non-TTY auto-approve so pipelines never hang on
stdin. `plan` never generates.

## Definition of done (per target)

A target **PASSES** when it produced ≥ `min_scenarios` scenarios, the generated
suite executes green (`must_pass`) and survives the stability gate (no accepted
test is flaky), any healing stayed within `max_heal_attempts`, and the run stayed
within `max_budget_usd`. `ata validate` aggregates all targets and exits non-zero
if any required target fails.

## Generated output

Each run writes to `generated/<target>/`:

- `perception.json` — recorded journey (multi-step accessibility snapshots). Reuse with `--reuse-perception`.
- `plan.md` — the human-readable, editable plan (review it; re-run with `--plan`).
- `plan.json` — the machine plan the generator consumes.
- `tests/*.spec.ts` + `pages/*` — **real, committable** `@playwright/test` specs.
- `checkpoints/<name>.json` — named checkpoints captured during manual explore (common preconditions).
- `use-cases/<name>.md` — LLM-generated manual-test docs for each recorded use case.

Whether to commit `generated/` is your call (it's gitignored by default).
Recommendation: commit for public targets, ignore for private.

## Security & Privacy

- **No telemetry**, ever (see above).
- **No model API keys** in the repo — reasoning is delegated to a local CLI.
- **`env: staging-only`** is enforced in code: production-looking hosts are
  refused unless explicitly allowlisted (`allow_hosts`) or `env: any`.
- **Public repo = public targets only.** Internal apps, staging URLs, binaries,
  and flows live in `targets/private/` (gitignored). Credentials come from env
  vars / CI secrets, never YAML; saved sessions live under `.auth/` (gitignored).
- **Action guardrails** (Phase 1 stub): destructive verbs (delete/pay/send) are
  flagged/blocked by a conservative default policy + config hook; a full policy
  engine comes later.

## Architecture notes

- `src/adapters/adapter.ts` — the contract (interface + shared types). The most
  important file; everything depends on it.
- `src/core/` — orchestrator, planner, pipeline (confirm gate), generator,
  executor (stability gate), healer, budget, and the provider-agnostic LLM client.
  **`core/` never imports Playwright** and depends only on the `LlmProvider`
  interface.
- `src/config/` — Zod schema + loader + grounding-context reader + the wizard.
- `src/auth/` — credential resolution (env), session storage, reuse.

## Roadmap

| Phase | Scope |
| --- | --- |
| **1 (this build)** | Web + Electron + reliability core (auth, stability gate, cost guard, grounding, scope, wizard, CLI, CI) + manual explore mode + `ata explore` command |
| 2 | REST API adapter (OpenAPI → request+assertion tests) + requirement→test traceability report |
| 3 | `--diff` scoped mode + Claude Code skill / MCP packaging |
| 4 | iOS (`appium-ios`, simulator) |
| 5+ | Android, native desktop, vision-fallback perception, self-eval harness, action-guardrail policy engine |

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint
npm run build       # compile to dist/
```

## License

MIT — see [LICENSE](LICENSE).
