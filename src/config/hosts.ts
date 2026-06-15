/**
 * `env: staging-only` host allowlist enforcement (PRD §13).
 *
 * The agent drives real apps; by default it refuses to point at anything that
 * isn't clearly a staging/local/public-demo host, so a production URL can't
 * sneak into a run. Users widen the allowlist explicitly via `allow_hosts`.
 */

/** Public demo hosts the project itself ships targets for — always safe. */
const PUBLIC_DEMO_HOSTS = new Set([
  'www.saucedemo.com',
  'saucedemo.com',
  'demo.playwright.dev',
  'todomvc.com',
  'www.todomvc.com',
]);

function isLocal(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  );
}

function looksLikeStaging(host: string): boolean {
  return /(^|[.-])(staging|stage|stg|test|qa|dev|preview)([.-]|$)/i.test(host);
}

/** Does `host` match an allow pattern? Patterns support a single leading `*.`. */
function matchesAllow(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return host === p.slice(2) || host.endsWith(suffix);
  }
  return host === p;
}

export interface HostCheck {
  allowed: boolean;
  host: string;
  reason: string;
}

/** Check one URL against the staging-only policy. */
export function checkHost(
  rawUrl: string,
  env: 'staging-only' | 'any',
  allowHosts: string[] = [],
): HostCheck {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return { allowed: false, host: rawUrl, reason: `not a valid URL: ${rawUrl}` };
  }

  if (env === 'any') {
    return { allowed: true, host, reason: 'env: any (allowlist disabled)' };
  }

  if (isLocal(host)) return { allowed: true, host, reason: 'local host' };
  if (PUBLIC_DEMO_HOSTS.has(host)) return { allowed: true, host, reason: 'public demo host' };
  if (looksLikeStaging(host)) return { allowed: true, host, reason: 'matches staging pattern' };
  if (allowHosts.some((p) => matchesAllow(host, p))) {
    return { allowed: true, host, reason: 'explicitly allowed via allow_hosts' };
  }

  return {
    allowed: false,
    host,
    reason:
      `host "${host}" is not staging/local/public-demo. ` +
      `Under env: staging-only it is refused. Add it to allow_hosts or set env: any to override.`,
  };
}
