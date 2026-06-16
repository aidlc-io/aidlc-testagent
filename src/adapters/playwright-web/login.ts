/**
 * Best-effort generic form login, shared by playwright-web and playwright-electron.
 *
 * Handles the common shapes without per-app scripting:
 *  - single-page forms (username + password + submit on one screen, e.g. SauceDemo)
 *  - two-step / SSO forms (enter email → Continue/Next → enter password → submit,
 *    e.g. Auth0/Okta/Cognito-style identity providers)
 *
 * It is intentionally heuristic: real SSO varies, so callers should treat a
 * thrown error as "could not complete automatically" and surface it.
 */

import type { Page } from 'playwright';

const USER_SELECTOR =
  'input[type="email"], input[type="text"], input[name*="user" i], input[name*="email" i], input[autocomplete="username"], input[id*="user" i], input[id*="email" i]';
const PASSWORD_SELECTOR = 'input[type="password"]';

const SUBMIT_SELECTOR =
  'button[type="submit"], input[type="submit"], #login-button, ' +
  'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), ' +
  'button:has-text("Continue"), button:has-text("Next"), button:has-text("Submit")';

interface Logger {
  debug(msg: string): void;
  warn(msg: string): void;
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 1_000 });
  } catch {
    return false;
  }
}

async function clickSubmitOrEnter(page: Page, fallbackField: string): Promise<void> {
  const submit = page.locator(SUBMIT_SELECTOR).first();
  if (await submit.count()) {
    await submit.click().catch(() => undefined);
  } else {
    await page.locator(fallbackField).first().press('Enter').catch(() => undefined);
  }
}

/**
 * Drive a login form on `page` with the given credentials. Throws if no password
 * field ever appears (e.g. the flow handed off to an external browser).
 */
export async function formLogin(
  page: Page,
  username: string,
  password: string,
  logger?: Logger,
): Promise<void> {
  // Step 1 — if the password field isn't here yet, this is likely an
  // identifier-first (SSO) flow: fill the username and advance.
  if (!(await isVisible(page, PASSWORD_SELECTOR))) {
    if (await isVisible(page, USER_SELECTOR)) {
      logger?.debug('Login: identifier-first step — filling username and advancing.');
      await page.locator(USER_SELECTOR).first().fill(username);
      await clickSubmitOrEnter(page, USER_SELECTOR);
      await page.waitForTimeout(1_000);
    }
  }

  // Step 2 — the password field should now be present.
  await page
    .locator(PASSWORD_SELECTOR)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });

  // Some single-page forms show username + password together; fill username if
  // it's present and still empty.
  const userField = page.locator(USER_SELECTOR).first();
  if ((await userField.count()) && (await userField.inputValue().catch(() => 'x')) === '') {
    await userField.fill(username).catch(() => undefined);
  }

  await page.locator(PASSWORD_SELECTOR).first().fill(password);
  await clickSubmitOrEnter(page, PASSWORD_SELECTOR);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
}
