/**
 * Config loader (PRD §7, §13).
 *
 * Reads `testagent.config.yaml`, resolves `include:` globs into per-target
 * files, validates everything with the same Zod schemas the wizard uses, and
 * enforces the `env: staging-only` host allowlist. Fails loudly with readable
 * messages on any malformed input or disallowed host.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
import { globSync } from 'glob';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { TargetConfig } from '../adapters/adapter.js';
import {
  rootSchema,
  targetSchema,
  type DefaultsConfig,
  type LlmConfig,
} from './schema.js';
import { checkHost } from './hosts.js';

export const DEFAULT_CONFIG_FILENAME = 'testagent.config.yaml';

export interface ResolvedConfig {
  /** Absolute path to the root manifest. */
  configPath: string;
  /** Directory the manifest lives in; all relative paths resolve from here. */
  baseDir: string;
  version: 1;
  env: 'staging-only' | 'any';
  allowHosts: string[];
  llm: LlmConfig;
  defaults: DefaultsConfig;
  targets: TargetConfig[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Turn a ZodError into a readable, multi-line message keyed by path. */
function formatZodError(err: z.ZodError, label: string): string {
  const lines = err.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `  • ${path}: ${i.message}`;
  });
  return `Invalid ${label}:\n${lines.join('\n')}`;
}

function readYamlFile(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read ${label}: ${path}`);
  }
  try {
    return parseYaml(raw);
  } catch (e) {
    throw new ConfigError(`Malformed YAML in ${label} (${path}): ${(e as Error).message}`);
  }
}

/** Locate the config file: explicit path, else walk up from cwd. */
export function findConfigPath(cwd: string, explicit?: string): string {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(p)) throw new ConfigError(`Config file not found: ${p}`);
    return p;
  }
  let dir = cwd;
  // Walk up to the filesystem root looking for the manifest.
  for (;;) {
    const candidate = resolve(dir, DEFAULT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(
    `No ${DEFAULT_CONFIG_FILENAME} found in ${cwd} or any parent directory. ` +
      `Run "ata config" to create one.`,
  );
}

/** Load and validate a single per-target file. */
export function loadTargetFile(path: string): TargetConfig {
  const data = readYamlFile(path, 'target file');
  const parsed = targetSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error, `target file ${relative(process.cwd(), path)}`));
  }
  return parsed.data;
}

/** Load the full resolved configuration. */
export function loadConfig(cwd: string, explicitPath?: string): ResolvedConfig {
  const configPath = findConfigPath(cwd, explicitPath);
  const baseDir = dirname(configPath);

  const rootData = readYamlFile(configPath, DEFAULT_CONFIG_FILENAME);
  const rootParsed = rootSchema.safeParse(rootData);
  if (!rootParsed.success) {
    throw new ConfigError(formatZodError(rootParsed.error, DEFAULT_CONFIG_FILENAME));
  }
  const root = rootParsed.data;

  // Resolve include: globs -> per-target files. An include that matches nothing
  // is fine (e.g. you have only public or only private targets); we only fail if
  // NO include matched anything at all.
  const targetPaths: string[] = [];
  const emptyIncludes: string[] = [];
  for (const { include } of root.targets) {
    const matches = globSync(include, { cwd: baseDir, absolute: true, nodir: true });
    if (matches.length === 0) {
      emptyIncludes.push(include);
      continue;
    }
    targetPaths.push(...matches);
  }
  if (targetPaths.length === 0 && root.targets.length > 0) {
    throw new ConfigError(
      `No target files matched any include (resolved from ${baseDir}):\n` +
        emptyIncludes.map((i) => `  • ${i}`).join('\n') +
        `\nAdd a target (e.g. \`ata config add\`) or fix the globs.`,
    );
  }

  const seen = new Set<string>();
  const targets: TargetConfig[] = [];
  for (const p of targetPaths.sort()) {
    const t = loadTargetFile(p);
    if (seen.has(t.name)) {
      throw new ConfigError(`Duplicate target name "${t.name}" (from ${p}).`);
    }
    seen.add(t.name);
    targets.push(t);
  }

  const resolved: ResolvedConfig = {
    configPath,
    baseDir,
    version: root.version,
    env: root.env,
    allowHosts: root.allow_hosts ?? [],
    llm: root.llm,
    defaults: root.defaults,
    targets,
  };

  enforceHostAllowlist(resolved);
  return resolved;
}

/** Enforce env: staging-only across every target with a network host. */
export function enforceHostAllowlist(cfg: ResolvedConfig): void {
  const offenders: string[] = [];
  for (const t of cfg.targets) {
    const urls = [t.url, t.baseUrl].filter((u): u is string => !!u);
    for (const u of urls) {
      const check = checkHost(u, cfg.env, cfg.allowHosts);
      if (!check.allowed) offenders.push(`  • ${t.name}: ${check.reason}`);
    }
  }
  if (offenders.length > 0) {
    throw new ConfigError(
      `env: ${cfg.env} refused ${offenders.length} host(s):\n${offenders.join('\n')}`,
    );
  }
}

/** Resolve a possibly-relative path against the config base dir. */
export function resolveFromBase(cfg: ResolvedConfig, p: string): string {
  return isAbsolute(p) ? p : resolve(cfg.baseDir, p);
}
