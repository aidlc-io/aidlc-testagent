/**
 * UI perception (shared by playwright-web and playwright-electron).
 *
 * Produces a normalized {@link PerceptionSnapshot}: an accessibility/DOM view
 * plus a list of concrete, interactable elements with stable selector hints.
 * This is the ONLY thing the generator reasons over for locating things — kept
 * separate from raw pixels to cut hallucination and token cost (PRD §5, §6).
 */

import type { Frame, Page } from 'playwright';
import type { ExploreCheckpoint, ExploreUseCase, PerceivedElement, PerceptionSnapshot, TargetConfig } from '../adapter.js';

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
  const checkpoints: ExploreCheckpoint[] = [];
  const useCases: ExploreUseCase[] = [];
  let activeUseCase: { name: string; fromStepIndex: number } | null = null;
  let snapInProgress = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let exploringDone = false;

  const snapNow = async (reason: string) => {
    if (exploringDone || snapInProgress) return;
    snapInProgress = true;
    try {
      if (exploringDone) return;
      const snap = await perceive(page, target.name);
      if (exploringDone) return;
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

  // --- Node.js callbacks exposed to the browser ----------------------------
  await page.exposeFunction('__ataOnDomIdle__', () => scheduleSnap('dom idle'));

  await page.exposeFunction('__ataAddCheckpoint__', (name: string, isCommon: boolean) => {
    const stepIndex = Math.max(0, steps.length - 1);
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-') || `checkpoint-${checkpoints.length + 1}`;
    checkpoints.push({ name: slug, stepIndex, isCommonPrecondition: isCommon, capturedAt: new Date().toISOString() });
    process.stderr.write(`  [explore] 📌 checkpoint "${slug}" (step ${stepIndex + 1}${isCommon ? ', common' : ''})\n`);
  });

  await page.exposeFunction('__ataStartUseCase__', (name: string) => {
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-') || `use-case-${useCases.length + 1}`;
    activeUseCase = { name: slug, fromStepIndex: Math.max(0, steps.length - 1) };
    process.stderr.write(`  [explore] 🎬 use case "${slug}" started (from step ${activeUseCase.fromStepIndex + 1})\n`);
  });

  await page.exposeFunction('__ataEndUseCase__', () => {
    if (!activeUseCase) return;
    const uc: ExploreUseCase = { ...activeUseCase, toStepIndex: Math.max(0, steps.length - 1) };
    useCases.push(uc);
    process.stderr.write(`  [explore] 🏁 use case "${uc.name}" ended (steps ${uc.fromStepIndex + 1}–${uc.toStepIndex + 1})\n`);
    activeUseCase = null;
  });

  // --- Toolbar + MutationObserver (injected/re-injected into the page) -----
  const injectToolbarAndObserver = () =>
    page.evaluate((ms: number) => {
      if (!document.getElementById('__ata_toolbar__')) {
        // ── outer container ──────────────────────────────────────────────
        const bar = document.createElement('div');
        bar.id = '__ata_toolbar__';
        Object.assign(bar.style, {
          position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
          background: 'rgba(15,23,42,0.93)', borderRadius: '8px', padding: '8px 10px',
          fontFamily: 'system-ui,sans-serif', display: 'flex', flexDirection: 'column',
          gap: '6px', boxShadow: '0 4px 20px rgba(0,0,0,.55)', minWidth: '270px',
        });

        // ── row 1: header ────────────────────────────────────────────────
        const hdr = document.createElement('div');
        Object.assign(hdr.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between' });
        const lbl = document.createElement('span');
        lbl.textContent = 'ATA EXPLORE';
        Object.assign(lbl.style, { fontSize: '10px', color: '#475569', fontWeight: '700', letterSpacing: '1px' });
        const doneBtn = document.createElement('button');
        doneBtn.id = '__ata_done_btn__';
        doneBtn.textContent = '✅ Done';
        Object.assign(doneBtn.style, {
          padding: '5px 12px', background: '#22c55e', color: '#fff',
          border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '12px',
        });
        doneBtn.addEventListener('click', () => { (window as any).__ataDone = true; });
        hdr.appendChild(lbl); hdr.appendChild(doneBtn);

        // ── divider ──────────────────────────────────────────────────────
        const div1 = document.createElement('div');
        Object.assign(div1.style, { height: '1px', background: '#1e293b' });

        // ── row 2: checkpoint ────────────────────────────────────────────
        const cpRow = document.createElement('div');
        Object.assign(cpRow.style, { display: 'flex', gap: '4px', alignItems: 'center' });
        const nameInput = document.createElement('input');
        nameInput.id = '__ata_name_input__';
        nameInput.placeholder = 'name…';
        Object.assign(nameInput.style, {
          flex: '1', padding: '4px 6px', borderRadius: '4px', border: '1px solid #334155',
          background: '#0f172a', color: '#e2e8f0', fontSize: '12px', outline: 'none',
        });
        const commonLbl = document.createElement('label');
        Object.assign(commonLbl.style, { display: 'flex', alignItems: 'center', gap: '3px', color: '#94a3b8', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' });
        const commonCb = document.createElement('input');
        commonCb.type = 'checkbox'; commonCb.id = '__ata_common_cb__';
        commonLbl.appendChild(commonCb);
        commonLbl.appendChild(document.createTextNode('common'));
        const cpBtn = document.createElement('button');
        cpBtn.title = 'Save as checkpoint'; cpBtn.textContent = '📌';
        Object.assign(cpBtn.style, {
          padding: '4px 8px', background: '#1e40af', color: '#fff',
          border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px',
        });
        cpBtn.addEventListener('click', () => {
          const name = nameInput.value.trim();
          if (!name) { nameInput.style.borderColor = '#ef4444'; setTimeout(() => { nameInput.style.borderColor = '#334155'; }, 800); return; }
          (window as any).__ataAddCheckpoint__(name, commonCb.checked);
          cpBtn.textContent = '✓'; setTimeout(() => { cpBtn.textContent = '📌'; }, 1000);
          nameInput.value = ''; commonCb.checked = false;
        });
        cpRow.appendChild(nameInput); cpRow.appendChild(commonLbl); cpRow.appendChild(cpBtn);

        // ── row 3: use case ──────────────────────────────────────────────
        const ucRow = document.createElement('div');
        Object.assign(ucRow.style, { display: 'flex', gap: '4px', alignItems: 'center' });
        const startBtn = document.createElement('button');
        startBtn.id = '__ata_uc_start__'; startBtn.textContent = '🎬 Start flow';
        Object.assign(startBtn.style, {
          flex: '1', padding: '4px 8px', background: '#7c3aed', color: '#fff',
          border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
        });
        const endBtn = document.createElement('button');
        endBtn.id = '__ata_uc_end__'; endBtn.textContent = '🏁 End flow';
        endBtn.style.display = 'none';
        Object.assign(endBtn.style, {
          flex: '1', padding: '4px 8px', background: '#b45309', color: '#fff',
          border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
        });
        const recLbl = document.createElement('span');
        recLbl.id = '__ata_uc_rec__';
        Object.assign(recLbl.style, { fontSize: '11px', color: '#fbbf24', display: 'none' });
        startBtn.addEventListener('click', () => {
          const name = nameInput.value.trim();
          if (!name) { nameInput.style.borderColor = '#ef4444'; nameInput.focus(); setTimeout(() => { nameInput.style.borderColor = '#334155'; }, 800); return; }
          (window as any).__ataStartUseCase__(name);
          recLbl.textContent = `● ${name}`; recLbl.style.display = '';
          startBtn.style.display = 'none'; endBtn.style.display = '';
          nameInput.value = '';
        });
        endBtn.addEventListener('click', () => {
          (window as any).__ataEndUseCase__();
          recLbl.style.display = 'none';
          endBtn.style.display = 'none'; startBtn.style.display = '';
        });
        ucRow.appendChild(startBtn); ucRow.appendChild(endBtn); ucRow.appendChild(recLbl);

        bar.appendChild(hdr); bar.appendChild(div1); bar.appendChild(cpRow); bar.appendChild(ucRow);
        document.body?.appendChild(bar);
      }

      // ── MutationObserver ─────────────────────────────────────────────────
      if (!(window as any).__ataObserver) {
        let timer: ReturnType<typeof setTimeout>;
        const observer = new MutationObserver((mutations) => {
          const allOurs = mutations.every((m) => {
            let node: Node | null = m.target;
            while (node) { if ((node as Element).id === '__ata_toolbar__') return true; node = node.parentNode; }
            return false;
          });
          if (allOurs || (window as any).__ataDone) return;
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

  // Navigate + initial snapshot
  if (target.url) {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }
  await snapNow('initial');
  await injectToolbarAndObserver();

  const onNav = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    void injectToolbarAndObserver();
  };
  page.on('framenavigated', onNav);

  process.stderr.write('\n[explore] Manual mode — navigate the app freely in the browser.\n');
  process.stderr.write('[explore] Toolbar (top-right): 📌 checkpoint  🎬/🏁 use case  ✅ Done\n\n');

  // Wait for Done click
  await new Promise<void>((resolve) => {
    const poll = setInterval(async () => {
      try {
        const done = await page.evaluate(() => (window as any).__ataDone === true);
        if (done) {
          exploringDone = true;
          if (debounceTimer) clearTimeout(debounceTimer);
          clearInterval(poll);
          resolve();
        }
      } catch { /* mid-navigation */ }
    }, 400);
  });

  page.off('framenavigated', onNav);

  // Close any open use case
  if (activeUseCase !== null) {
    const uc = activeUseCase as { name: string; fromStepIndex: number };
    useCases.push({ name: uc.name, fromStepIndex: uc.fromStepIndex, toStepIndex: Math.max(0, steps.length - 1) });
    process.stderr.write(`  [explore] 🏁 use case "${uc.name}" auto-closed at Done\n`);
  }

  await page.evaluate(() => {
    (window as any).__ataObserver?.disconnect();
    document.getElementById('__ata_toolbar__')?.remove();
  }).catch(() => {});

  const last = steps.at(-1) ?? (await perceive(page, target.name));
  return {
    ...last,
    steps,
    checkpoints: checkpoints.length ? checkpoints : undefined,
    useCases: useCases.length ? useCases : undefined,
  };
}
