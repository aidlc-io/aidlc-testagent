/**
 * MCP server configuration types, shared between the LLM provider layer and
 * adapter MCP integrations. Kept here (core/mcp/) so neither adapter/ nor
 * llm/ owns the definition.
 */

export interface McpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Playwright MCP server — runs via npx, defaults to stdio transport. */
export const PLAYWRIGHT_MCP_SERVER: McpServerConfig = {
  type: 'stdio',
  command: 'npx',
  args: ['@playwright/mcp'],
};
