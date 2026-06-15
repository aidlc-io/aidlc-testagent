/**
 * UI perception (shared by playwright-web and playwright-electron).
 *
 * Produces a normalized {@link PerceptionSnapshot}: an accessibility/DOM view
 * plus a list of concrete, interactable elements with stable selector hints.
 * This is the ONLY thing the generator reasons over for locating things — kept
 * separate from raw pixels to cut hallucination and token cost (PRD §5, §6).
 */

import type { Page } from 'playwright';
import type { PerceivedElement, PerceptionSnapshot } from '../adapter.js';

const MAX_ELEMENTS = 120;

/** Collected in the page context; must be self-contained (runs in the browser). */
function collectElements(max: number): PerceivedElement[] {
  function bestSelector(el: Element): string | undefined {
    const testId =
      el.getAttribute('data-testid') ||
      el.getAttribute('data-test') ||
      el.getAttribute('data-test-id');
    if (testId) return `[data-testid="${testId}"]`;
    const id = el.getAttribute('id');
    if (id) return `#${id}`;
    const name = el.getAttribute('name');
    if (name) return `[name="${name}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `[aria-label="${aria}"]`;
    return undefined;
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  }

  function nameOf(el: Element): string | undefined {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();
    const val = (el as HTMLInputElement).value;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 80) return text;
    if (val) return String(val).slice(0, 80);
    return undefined;
  }

  const selector =
    'a, button, input, select, textarea, [role], [data-testid], [data-test], h1, h2, h3, label';
  const out: PerceivedElement[] = [];
  const nodes = Array.from(document.querySelectorAll(selector));
  for (const el of nodes) {
    if (out.length >= max) break;
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    const visible = !rect || (rect.width > 0 && rect.height > 0);
    if (!visible) continue;
    const attributes: Record<string, string> = {};
    const type = el.getAttribute('type');
    if (type) attributes.type = type;
    const href = el.getAttribute('href');
    if (href) attributes.href = href.slice(0, 120);
    out.push({
      role: roleOf(el),
      name: nameOf(el),
      selector: bestSelector(el),
      attributes: Object.keys(attributes).length ? attributes : undefined,
    });
  }
  return out;
}

export async function perceive(page: Page, targetName: string): Promise<PerceptionSnapshot> {
  const url = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {
    /* some surfaces (electron splash) have no title yet */
  }

  let elements: PerceivedElement[] = [];
  try {
    elements = await page.evaluate(collectElements, MAX_ELEMENTS);
  } catch {
    elements = [];
  }

  let accessibilityTree: string | undefined;
  try {
    // Playwright's aria snapshot — concise, structured, version-stable enough.
    accessibilityTree = await page.locator('body').ariaSnapshot();
  } catch {
    accessibilityTree = undefined;
  }

  const notes: string[] = [];
  if (!accessibilityTree && elements.length === 0) {
    notes.push('No accessibility tree or interactive elements perceived; page may be blank or blocked.');
  }

  return {
    target: targetName,
    kind: 'ui',
    url,
    title,
    accessibilityTree,
    elements,
    capturedAt: new Date().toISOString(),
    notes: notes.length ? notes : undefined,
  };
}
