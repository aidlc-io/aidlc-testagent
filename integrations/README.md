# integrations/ — AIDLC ecosystem packaging

## MCP Server (Phase 3 — implemented)

Source: `src/integrations/mcp/index.ts`
Binary: `aidlc-testagent-mcp` / `ata-mcp` (also `npx aidlc-testagent-mcp`)

The MCP server exposes five tools so any MCP-compatible client
(Claude Desktop, Claude Code, etc.) can drive the agent without a terminal.

### Tools

| Tool | Equivalent CLI | Description |
|------|---------------|-------------|
| `ata_list` | `ata list` | List configured targets |
| `ata_plan` | `ata plan <target>` | Propose a plan, write plan.md |
| `ata_run` | `ata run <target> --yes` | Full loop: plan → generate → execute → heal |
| `ata_validate` | `ata validate` | Run all targets, return PASS/FAIL table |
| `ata_explore` | `ata explore <target>` | Observe target, save perception.json |

### Setup — Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aidlc-testagent": {
      "command": "npx",
      "args": ["aidlc-testagent-mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### Setup — Claude Code

```bash
claude mcp add aidlc-testagent npx aidlc-testagent-mcp --cwd /path/to/your/project
```

Or add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "aidlc-testagent": {
      "command": "npx",
      "args": ["aidlc-testagent-mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

The server reads `testagent.config.yaml` from the configured `cwd`.

## skill/ — Claude Code skill packaging (Phase 3, not yet implemented)

Reserved for packaging as a `/ata` slash command in Claude Code CLI.
