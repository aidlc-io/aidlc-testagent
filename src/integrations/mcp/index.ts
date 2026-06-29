#!/usr/bin/env node
/**
 * aidlc-testagent MCP server (Phase 3).
 *
 * Exposes plan / run / validate / explore / list as MCP tools so any
 * MCP-compatible client (Claude Desktop, Claude Code, etc.) can invoke
 * the agent without a terminal.
 *
 * Usage — add to your MCP client config:
 *   {
 *     "mcpServers": {
 *       "aidlc-testagent": {
 *         "command": "npx",
 *         "args": ["aidlc-testagent-mcp"],
 *         "cwd": "/path/to/your/project"
 *       }
 *     }
 *   }
 *
 * The server reads testagent.config.yaml from the working directory (cwd).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, ConfigError } from '../../config/loader.js';
import { createLlmProvider } from '../../core/llm/index.js';
import { runTarget, exploreTarget } from '../../core/orchestrator.js';
import { renderRunResult, renderValidateTable, renderTargetList } from '../../cli/render.js';
import { silentLogger, ConsoleLogger } from '../../core/logger.js';
import type { TargetRunResult } from '../../core/orchestrator.js';

const server = new McpServer({
  name: 'aidlc-testagent',
  version: '0.4.3',
});

function loadCfg(configPath?: string) {
  return loadConfig(process.cwd(), configPath);
}

function findTarget(cfg: ReturnType<typeof loadCfg>, name: string) {
  const t = cfg.targets.find((x) => x.name === name);
  if (!t) {
    const names = cfg.targets.map((x) => x.name).join(', ') || '(none)';
    throw new ConfigError(`No target named "${name}". Configured targets: ${names}`);
  }
  return t;
}

async function makeDeps(cfg: ReturnType<typeof loadCfg>, verbose = false) {
  const logger = verbose ? new ConsoleLogger(true) : silentLogger;
  const llm = createLlmProvider(cfg.llm);
  await llm.preflight();
  return { cfg, llm, logger };
}

// ── ata_list ────────────────────────────────────────────────────────────────

server.tool(
  'ata_list',
  'List all configured aidlc-testagent targets and their adapters',
  {},
  async () => {
    try {
      const cfg = loadCfg();
      return { content: [{ type: 'text', text: renderTargetList(cfg.targets) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ── ata_plan ────────────────────────────────────────────────────────────────

server.tool(
  'ata_plan',
  'Propose a test plan for a target and write plan.md — no test code is generated',
  {
    target: z.string().describe('Target name (must exist in testagent.config.yaml)'),
    scope: z.string().optional().describe('Restrict to a declared feature name'),
    feature: z.string().optional().describe('Restrict to flows described by this requirement file path'),
    reusePerception: z.boolean().optional().describe('Skip browser exploration; load saved perception.json'),
  },
  async ({ target: targetName, scope, feature, reusePerception }) => {
    try {
      const cfg = loadCfg();
      const target = findTarget(cfg, targetName);
      const deps = await makeDeps(cfg);
      const res = await runTarget(
        target,
        {
          mode: 'plan',
          isTty: false,
          isCi: false,
          scope: scope || feature ? { feature: scope, requirementFile: feature } : undefined,
          reusePerception,
        },
        deps,
      );
      return { content: [{ type: 'text', text: renderRunResult(res) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ── ata_run ─────────────────────────────────────────────────────────────────

server.tool(
  'ata_run',
  'Full agent loop for a target: plan → generate → execute → heal. Returns a pass/fail result.',
  {
    target: z.string().describe('Target name (must exist in testagent.config.yaml)'),
    yes: z.boolean().optional().describe('Auto-approve the plan without prompting (default true for MCP)'),
    scope: z.string().optional().describe('Restrict to a declared feature name'),
    feature: z.string().optional().describe('Restrict to flows described by this requirement file path'),
    dryRun: z.boolean().optional().describe('Generate specs only, skip execution'),
    reuse: z.boolean().optional().describe('Skip plan+generate if specs already exist; run existing scripts'),
    reusePerception: z.boolean().optional().describe('Skip browser exploration; load saved perception.json'),
    headed: z.boolean().optional().describe('Open a visible browser (useful with manual explore)'),
  },
  async ({ target: targetName, yes = true, scope, feature, dryRun, reuse, reusePerception, headed }) => {
    try {
      const cfg = loadCfg();
      const target = findTarget(cfg, targetName);
      const deps = await makeDeps(cfg);
      const res = await runTarget(
        target,
        {
          mode: 'run',
          isTty: false,
          isCi: true,
          yes,
          scope: scope || feature ? { feature: scope, requirementFile: feature } : undefined,
          dryRun,
          reuseScripts: reuse,
          reusePerception,
          headed,
        },
        deps,
      );
      return { content: [{ type: 'text', text: renderRunResult(res) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ── ata_validate ─────────────────────────────────────────────────────────────

server.tool(
  'ata_validate',
  'Run all configured targets and return a PASS/FAIL table. Mirrors `ata validate` in CI.',
  {
    headed: z.boolean().optional().describe('Open visible browsers (debug)'),
  },
  async ({ headed }) => {
    try {
      const cfg = loadCfg();
      if (cfg.targets.length === 0) {
        return {
          content: [{ type: 'text', text: 'No targets configured. Run `ata config` to add one.' }],
        };
      }
      const deps = await makeDeps(cfg);
      const results: TargetRunResult[] = [];
      for (const target of cfg.targets) {
        const res = await runTarget(
          target,
          { mode: 'run', isTty: false, isCi: true, yes: true, headed },
          deps,
        );
        results.push(res);
      }
      const table = renderValidateTable(results);
      const anyFail = results.some((r) => r.status === 'fail');
      return {
        content: [{ type: 'text', text: table }],
        isError: anyFail,
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ── ata_explore ──────────────────────────────────────────────────────────────

server.tool(
  'ata_explore',
  'Observe a target and save perception.json for later reuse by ata_plan / ata_run',
  {
    target: z.string().describe('Target name (must exist in testagent.config.yaml)'),
  },
  async ({ target: targetName }) => {
    try {
      const cfg = loadCfg();
      const target = findTarget(cfg, targetName);
      const logger = new ConsoleLogger(false);
      const llm = createLlmProvider(cfg.llm);
      await llm.preflight();
      const result = await exploreTarget(
        target,
        { logger },
        { cfg, llm, logger },
      );
      const extras: string[] = [];
      if (result.checkpointCount) extras.push(`${result.checkpointCount} checkpoint(s)`);
      if (result.useCaseCount) extras.push(`${result.useCaseCount} use-case doc(s)`);
      const extrasLine = extras.length ? `Extras: ${extras.join(', ')} saved.\n` : '';
      const text =
        `Explored "${result.target}" — ${result.stepCount} step(s) captured (${result.strategy}).\n` +
        `Saved to: ${result.perceptionPath}\n` +
        extrasLine +
        `Use reusePerception: true on ata_plan / ata_run to skip re-exploring.`;
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  },
);

// ── start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
