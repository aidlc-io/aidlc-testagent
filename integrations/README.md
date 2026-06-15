# integrations/ — AIDLC ecosystem packaging (Phase 3, not implemented)

Reserved for Phase 3 (PRD §10, §15):

- `skill/` — Claude Code skill packaging, so the agent installs as an AIDLC skill.
- `mcp/` — an MCP server entrypoint exposing `plan` / `run` / `validate` as tools.

These are intentionally empty in Phase 1. The core loop already depends only on
the `LlmProvider` interface and the adapter contract, so packaging it as a skill
or MCP server is additive — no core changes required.
