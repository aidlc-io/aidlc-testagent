/**
 * Runtime environment detection for the CLI (TTY / CI), used to govern the
 * confirmation gate (PRD §11): interactive prompts when a human is present,
 * auto-approve in CI / non-TTY so pipelines never hang on stdin.
 */

export function isInteractiveTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export function isCi(): boolean {
  const env = process.env;
  return Boolean(
    env.CI ||
      env.CONTINUOUS_INTEGRATION ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.BUILDKITE ||
      env.CIRCLECI ||
      env.JENKINS_URL,
  );
}
