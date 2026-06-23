/**
 * MCP-driven exploration: instead of the adapter taking a static snapshot,
 * Claude drives the browser interactively via Playwright MCP tools, discovering
 * dynamic states, multi-step flows, and off-the-beaten-path UI that a single
 * accessibility-tree capture would miss.
 *
 * The adapter calls `mcpExplore()` when `explore.strategy === 'mcp'`.
 * The rest of the pipeline (planner, generator, executor) is unchanged — it
 * still receives a standard `PerceptionSnapshot`.
 */

import type { Logger, PerceivedElement, PerceptionSnapshot, TargetConfig } from '../adapter.js';
import type { LlmProvider } from '../../core/llm/provider.js';
import { PLAYWRIGHT_MCP_SERVER } from '../../core/mcp/types.js';

const MCP_EXPLORE_SYSTEM = `\
You are an AI test agent performing interactive exploration of a web application.
Your task is to navigate the app, discover its features, and return a structured
perception snapshot that will be used to generate automated tests.

Use the browser tools to:
1. Navigate to the target URL
2. Take a screenshot to see the initial state
3. Capture the accessibility snapshot to understand the element structure
4. Click through major navigation links and discover key flows
5. Identify the most important interactive elements (buttons, forms, inputs, links)
6. Note any dynamic states (modals, dropdowns, multi-step flows)

Return ONLY a JSON object matching this structure — no prose, no markdown fences:
{
  "title": "<page title>",
  "accessibilityTree": "<full text of accessibility tree / key UI description>",
  "elements": [
    { "role": "<role>", "name": "<accessible name>", "selector": "<stable selector or empty>" }
  ],
  "notes": ["<key observation about the app or flows>"]
}

Rules:
- Include every interactive element you find (buttons, links, inputs, selects).
- Prefer data-testid selectors; fall back to role+name or CSS.
- notes[] should capture flows, auth patterns, and anything else useful for test authoring.
- Do not fabricate elements you did not observe with the browser tools.`;

interface McpSnapshotOutput {
  title?: string;
  accessibilityTree?: string;
  elements?: Array<{ role: string; name?: string; selector?: string }>;
  notes?: string[];
}

function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith('{')) return t;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}

export async function mcpExplore(
  target: TargetConfig,
  llm: LlmProvider,
  logger: Logger,
): Promise<PerceptionSnapshot> {
  logger.info(`[mcp-explore] Starting interactive MCP exploration of ${target.url ?? target.name}`);

  const prompt = [
    `Explore the following web application and return a JSON perception snapshot.`,
    ``,
    `Target name: ${target.name}`,
    `URL: ${target.url ?? '(no URL — check config)'}`,
    ...(target.context?.requirements?.length
      ? [`Context hint: requirements are available; focus on core user-facing flows.`]
      : []),
    ``,
    `Begin by navigating to the URL, then explore methodically.`,
  ].join('\n');

  const res = await llm.complete({
    system: MCP_EXPLORE_SYSTEM,
    prompt,
    mcpServers: { playwright: PLAYWRIGHT_MCP_SERVER },
  });

  let parsed: McpSnapshotOutput = {};
  try {
    parsed = JSON.parse(extractJson(res.text)) as McpSnapshotOutput;
  } catch {
    logger.warn('[mcp-explore] Could not parse JSON from MCP explore response; using raw text as accessibilityTree.');
    parsed = { accessibilityTree: res.text };
  }

  const elements: PerceivedElement[] = (parsed.elements ?? []).map((e) => ({
    role: e.role,
    name: e.name,
    selector: e.selector,
  }));

  const snapshot: PerceptionSnapshot = {
    target: target.name,
    kind: 'ui',
    url: target.url,
    title: parsed.title,
    accessibilityTree: parsed.accessibilityTree,
    elements,
    notes: parsed.notes,
    capturedAt: new Date().toISOString(),
  };

  logger.info(
    `[mcp-explore] Done. Found ${elements.length} element(s).` +
      (parsed.notes?.length ? ` Notes: ${parsed.notes.length}.` : ''),
  );

  return snapshot;
}
