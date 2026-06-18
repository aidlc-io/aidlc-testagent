/**
 * UI perception (shared by playwright-web and playwright-electron).
 *
 * Produces a normalized {@link PerceptionSnapshot}: an accessibility/DOM view
 * plus a list of concrete, interactable elements with stable selector hints.
 * This is the ONLY thing the generator reasons over for locating things — kept
 * separate from raw pixels to cut hallucination and token cost (PRD §5, §6).
 */

import type { Frame, Page } from 'playwright';
import type { PerceivedElement, PerceptionSnapshot, TargetConfig } from '../adapter.js';

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

/**
 * Manual explore mode — passive DOM watcher.
 *
 * A MutationObserver inside the page fires whenever the DOM settles after
 * user interaction. After `idleTimeoutMs` of inactivity the observer calls
 * back into Node.js via an exposed function, triggering a PerceptionSnapshot.
 * Navigation events (hash/SPA routing) also schedule a snapshot. The user
 * clicks "✅ Done" in the injected toolbar to finish.
 *
 * This approach captures the full app flow without any manual "Snapshot"
 * clicks — every settled UI state after an interaction is recorded.
 *
 * Returns a PerceptionSnapshot for the final state with all intermediate
 * steps attached so the planner can reason over the whole journey.
 */
/** Simple fingerprint to skip duplicate snapshots (same element count + first few labels). */
function snapFingerprint(snap: PerceptionSnapshot): string {
  const els = snap.elements ?? [];
  return `${els.length}:${els.slice(0, 8).map((e) => (e.name ?? e.role).slice(0, 20)).join('|')}`;
}

export async function exploreManual(page: Page, target: TargetConfig): Promise<PerceptionSnapshot> {
  const debounceMs = target.explore?.idleTimeoutMs ?? 2_000;
  const steps: PerceptionSnapshot[] = [];
  let snapInProgress = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let exploringDone = false; // set true on Done click; stops all further captures

  const snapNow = async (reason: string) => {
    if (exploringDone || snapInProgress) return;
    snapInProgress = true;
    try {
      if (exploringDone) return; // re-check after async gap
      const snap = await perceive(page, target.name);
      if (exploringDone) return; // done was clicked while perceive was running

      // Skip if identical to the previous step
      const fp = snapFingerprint(snap);
      const prev = steps.at(-1);
      if (prev && snapFingerprint(prev) === fp) return;

      const stepNum = steps.length + 1;
      steps.push({ ...snap, notes: [...(snap.notes ?? []), `step ${stepNum}: ${reason}`] });
      process.stderr.write(`  [explore] step ${stepNum}: ${snap.url ?? '?'} — ${snap.title ?? '(no title)'}\n`);
    } finally {
      snapInProgress = false;
    }
  };

  const scheduleSnap = (reason: string) => {
    if (exploringDone) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void snapNow(reason), debounceMs);
  };

  // Expose a function the in-page MutationObserver can call back into Node.js.
  // exposeFunction persists across SPA navigations in Playwright.
  await page.exposeFunction('__ataOnDomIdle__', () => scheduleSnap('dom idle'));

  const injectToolbarAndObserver = () =>
    page.evaluate((ms: number) => {
      // --- toolbar (Done button only; auto-snapshot handles the rest) ---
      if (!document.getElementById('__ata_toolbar__')) {
        const bar = document.createElement('div');
        bar.id = '__ata_toolbar__';
        Object.assign(bar.style, {
          position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
          display: 'flex', gap: '6px', fontFamily: 'sans-serif', alignItems: 'center',
        });
        const label = document.createElement('span');
        label.textContent = 'ATA';
        Object.assign(label.style, {
          fontSize: '11px', color: '#94a3b8', fontWeight: 'bold', letterSpacing: '1px',
        });
        const done = document.createElement('button');
        done.id = '__ata_done_btn__';
        done.textContent = '✅ Done';
        Object.assign(done.style, {
          padding: '7px 14px', background: '#22c55e', color: '#fff',
          border: 'none', borderRadius: '6px', cursor: 'pointer',
          fontSize: '13px', boxShadow: '0 2px 8px rgba(0,0,0,.4)',
        });
        done.addEventListener('click', () => { (window as any).__ataDone = true; });
        bar.appendChild(label);
        bar.appendChild(done);
        document.body?.appendChild(bar);
      }

      // --- MutationObserver (one per page; survives SPA route changes) ---
      if (!(window as any).__ataObserver) {
        let timer: ReturnType<typeof setTimeout>;
        const observer = new MutationObserver((mutations) => {
          // Ignore mutations originating from our own toolbar overlay
          const allOurs = mutations.every((m) => {
            let node: Node | null = m.target;
            while (node) {
              if ((node as Element).id === '__ata_toolbar__') return true;
              node = node.parentNode;
            }
            return false;
          });
          if (allOurs) return;
          if ((window as any).__ataDone) return;
          clearTimeout(timer);
          timer = setTimeout(() => (window as any).__ataOnDomIdle__(), ms);
        });
        observer.observe(document.documentElement, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ['class', 'style', 'aria-expanded', 'hidden', 'disabled'],
          characterData: false,
        });
        (window as any).__ataObserver = observer;
      }
    }, debounceMs).catch(() => {});

  // Navigate to start URL and take initial snapshot.
  if (target.url) {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }
  await snapNow('initial');
  await injectToolbarAndObserver();

  // Re-inject toolbar + observer after hard navigations (SPA route changes
  // keep window intact so the observer survives; only hard reloads need this).
  const onNav = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    void injectToolbarAndObserver();
  };
  page.on('framenavigated', onNav);

  process.stderr.write('\n[explore] Manual mode — navigate the app freely in the browser.\n');
  process.stderr.write('[explore] Every interaction is auto-snapshotted after DOM settles.\n');
  process.stderr.write('[explore] Click "✅ Done" (top-right of the app) when finished.\n\n');

  // Wait for Done click.
  await new Promise<void>((resolve) => {
    const poll = setInterval(async () => {
      try {
        const done = await page.evaluate(() => (window as any).__ataDone === true);
        if (done) {
          exploringDone = true;           // stop all further captures immediately
          if (debounceTimer) clearTimeout(debounceTimer);
          clearInterval(poll);
          resolve();
        }
      } catch { /* mid-navigation, retry */ }
    }, 400);
  });

  page.off('framenavigated', onNav);

  await page.evaluate(() => {
    (window as any).__ataObserver?.disconnect();
    document.getElementById('__ata_toolbar__')?.remove();
  }).catch(() => {});

  const last = steps.at(-1) ?? (await perceive(page, target.name));
  return { ...last, steps };
}
