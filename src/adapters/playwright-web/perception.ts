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
  // Include URL + title so SPA route changes always produce a new step.
  return `${snap.url ?? ''}|${snap.title ?? ''}|${els.length}:${els.slice(0, 8).map((e) => (e.name ?? e.role).slice(0, 20)).join('|')}`;
}

/** Infer a human-readable step name from DOM snapshot elements.
 *  Priority: open dialog title → main heading → URL path → page title. */
function autoStepName(snap: PerceptionSnapshot, index: number): string {
  const els = snap.elements ?? [];

  // 1. Open dialog/modal — use its name (aria-label or first child text)
  const dialog = els.find((e) => e.role === 'dialog' && e.name);
  if (dialog?.name) return dialog.name.slice(0, 60);

  // 2. Main heading visible on the page
  const heading = els.find((e) => e.role === 'heading' && e.name);
  if (heading?.name) return heading.name.slice(0, 60);

  // 3. URL path segment (meaningful for SPAs: /dashboard, /studio, etc.)
  if (snap.url) {
    try {
      const segs = new URL(snap.url).pathname.split('/').filter(Boolean);
      if (segs.length) return segs.at(-1)!.replace(/[-_]/g, ' ').slice(0, 60);
    } catch { /* ignore */ }
  }

  // 4. Page title (first part before separator)
  if (snap.title) {
    const t = (snap.title.split(/\s*[|—–\-]\s*/)[0] ?? '').trim();
    if (t) return t.slice(0, 60);
  }

  return `step ${index + 1}`;
}

export async function exploreManual(page: Page, target: TargetConfig): Promise<PerceptionSnapshot> {
  const debounceMs = target.explore?.idleTimeoutMs ?? 2_000;
  const steps: PerceptionSnapshot[] = [];
  const stepNames: string[] = [];
  const stepScreenshots: string[] = [];  // base64 JPEG per step (in-memory only, not persisted)
  const checkpoints: ExploreCheckpoint[] = [];
  const useCases: ExploreUseCase[] = [];
  let pendingActionName: string | undefined;
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
      const idx = steps.length;
      const action = pendingActionName;
      pendingActionName = undefined;
      const context = autoStepName(snap, idx);
      const name = action ? `${action} — ${context}` : context;
      steps.push({ ...snap, notes: [...(snap.notes ?? []), `step ${idx + 1}: ${reason}`] });
      stepNames.push(name);
      // Screenshot at 55% JPEG — compact enough for in-memory storage across ~20 steps
      const shot = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false }).catch(() => null);
      stepScreenshots.push(shot ? shot.toString('base64') : '');
      process.stderr.write(`  [explore] step ${idx + 1} [${name}]: ${snap.url ?? '?'}\n`);
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
  await page.exposeFunction('__ataGetStepCount__', () => steps.length);
  // Force-snap current state (called before opening popups so list is fresh).
  await page.exposeFunction('__ataSnapNow__', async () => { await snapNow('manual trigger'); });
  // Returns all steps with their current names (auto-generated or user-edited).
  await page.exposeFunction('__ataGetSteps__', () =>
    steps.map((s, i) => ({ index: i, url: s.url ?? '', title: s.title ?? '', name: stepNames[i] ?? `step ${i + 1}` })),
  );
  // Called from the review panel when user renames a step.
  await page.exposeFunction('__ataSetStepName__', (index: number, name: string) => {
    const n = name.trim();
    if (n) stepNames[index] = n;
  });
  // Called by the in-page click listener with the action text.
  await page.exposeFunction('__ataSetPendingAction__', (text: string) => {
    pendingActionName = text;
  });
  // Returns base64 JPEG for the preview overlay.
  await page.exposeFunction('__ataGetScreenshot__', (index: number) => stepScreenshots[index] ?? '');
  await page.exposeFunction('__ataAddCheckpoint__', (name: string, isCommon: boolean, stepIndex: number) => {
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-') || `checkpoint-${checkpoints.length + 1}`;
    const idx = Math.min(Math.max(0, stepIndex), Math.max(0, steps.length - 1));
    checkpoints.push({ name: slug, stepIndex: idx, isCommonPrecondition: isCommon, capturedAt: new Date().toISOString() });
    process.stderr.write(`  [explore] 📌 checkpoint "${slug}" (step ${idx + 1}${isCommon ? ', common' : ''})\n`);
  });
  await page.exposeFunction('__ataAddUseCase__', (name: string, fromStepIndex: number, toStepIndex: number) => {
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-') || `use-case-${useCases.length + 1}`;
    const from = Math.min(Math.max(0, fromStepIndex), Math.max(0, steps.length - 1));
    const to = Math.min(Math.max(from, toStepIndex), Math.max(0, steps.length - 1));
    useCases.push({ name: slug, fromStepIndex: from, toStepIndex: to });
    process.stderr.write(`  [explore] 🎬 use case "${slug}" (steps ${from + 1}–${to + 1})\n`);
  });

  // --- Toolbar + popup + MutationObserver ----------------------------------
  const injectToolbarAndObserver = () =>
    page.evaluate((ms: number) => {

      // Show a full-screen screenshot preview overlay.
      function previewScreenshot(index: number) {
        (window as any).__ataGetScreenshot__(index).then((b64: string) => {
          if (!b64) return;
          document.getElementById('__ata_preview__')?.remove();
          const ov = document.createElement('div');
          ov.id = '__ata_preview__';
          Object.assign(ov.style, {
            position: 'fixed', inset: '0', zIndex: '2147483645',
            background: 'rgba(0,0,0,0.85)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '10px',
          });
          const img = document.createElement('img');
          img.src = `data:image/jpeg;base64,${b64}`;
          Object.assign(img.style, { maxWidth: '90vw', maxHeight: '82vh', borderRadius: '6px', boxShadow: '0 4px 32px rgba(0,0,0,.8)' });
          const close = document.createElement('button');
          close.textContent = '✕ Close';
          Object.assign(close.style, { padding: '6px 18px', background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '13px' });
          close.addEventListener('click', () => ov.remove());
          ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
          ov.appendChild(img); ov.appendChild(close);
          document.body.appendChild(ov);
        }).catch(() => {});
      }

      // Returns true if a DOM node belongs to our injected overlay/toolbar.
      function isOurs(node: Node | null): boolean {
        while (node) {
          const id = (node as Element).id;
          if (id === '__ata_toolbar__' || id === '__ata_overlay__' || id === '__ata_preview__') return true;
          node = node.parentNode;
        }
        return false;
      }

      // Open a modal popup; `builder` receives the dialog element for wiring events.
      function openPopup(html: string, builder: (dlg: HTMLElement) => void) {
        document.getElementById('__ata_overlay__')?.remove();
        const overlay = document.createElement('div');
        overlay.id = '__ata_overlay__';
        Object.assign(overlay.style, {
          position: 'fixed', inset: '0', zIndex: '2147483646',
          background: 'rgba(0,0,0,0.6)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        });
        const dlg = document.createElement('div');
        Object.assign(dlg.style, {
          background: '#1e293b', borderRadius: '10px', padding: '16px',
          width: '380px', maxWidth: '92vw', maxHeight: '80vh',
          boxShadow: '0 8px 32px rgba(0,0,0,.7)',
          fontFamily: 'system-ui,sans-serif', color: '#e2e8f0',
          display: 'flex', flexDirection: 'column', gap: '10px',
          overflowY: 'auto',
        });
        dlg.innerHTML = html;
        overlay.appendChild(dlg);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
        builder(dlg);
      }

      if (!document.getElementById('__ata_toolbar__')) {
        // ── compact horizontal toolbar ────────────────────────────────────
        const bar = document.createElement('div');
        bar.id = '__ata_toolbar__';
        Object.assign(bar.style, {
          position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
          background: 'rgba(15,23,42,0.95)', borderRadius: '8px', padding: '7px 10px',
          fontFamily: 'system-ui,sans-serif', display: 'flex', alignItems: 'center',
          gap: '6px', boxShadow: '0 4px 20px rgba(0,0,0,.6)',
        });

        const lbl = document.createElement('span');
        lbl.textContent = 'ATA';
        Object.assign(lbl.style, { fontSize: '10px', color: '#475569', fontWeight: '700', letterSpacing: '1px' });

        const stepLbl = document.createElement('span');
        stepLbl.id = '__ata_step_lbl__';
        stepLbl.textContent = 'step 0';
        Object.assign(stepLbl.style, {
          fontSize: '11px', color: '#38bdf8', fontWeight: '600',
          background: '#0f172a', padding: '2px 7px', borderRadius: '4px',
        });
        setInterval(() => {
          (window as any).__ataGetStepCount__()
            .then((n: number) => { stepLbl.textContent = `step ${n}`; })
            .catch(() => {});
        }, 800);

        function mkBtn(text: string, bg: string): HTMLButtonElement {
          const b = document.createElement('button');
          b.textContent = text;
          Object.assign(b.style, {
            padding: '5px 10px', background: bg, color: '#fff',
            border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '12px',
          });
          return b;
        }

        // ── 📌 Checkpoint button → popup with step list ───────────────────
        const cpBtn = mkBtn('📌 Checkpoint', '#1e40af');
        cpBtn.addEventListener('click', () => {
          (window as any).__ataSnapNow__().catch(() => {}).finally(() => {
          (window as any).__ataGetSteps__().then((list: {index: number; url: string; title: string; name: string}[]) => {
            if (!list.length) { alert('No steps captured yet — navigate around first.'); return; }
            const lastIdx = list.length - 1;
            const rows = list.map((s) =>
              `<div style="display:flex;gap:6px;align-items:flex-start;padding:3px 4px;border-radius:5px">
                <label style="display:flex;gap:8px;align-items:flex-start;flex:1;cursor:pointer">
                  <input type="radio" name="cpstep" value="${s.index}" ${s.index === lastIdx ? 'checked' : ''} style="margin-top:3px;flex-shrink:0">
                  <span style="font-size:12px;line-height:1.4">
                    <strong style="color:#f1f5f9">Step ${s.index + 1}</strong>
                    <span style="color:#94a3b8"> — ${s.name.slice(0, 55)}</span><br>
                    <span style="font-size:10px;color:#475569">${(() => { try { return new URL(s.url).pathname.slice(0,40)||'/'; } catch { return s.url.slice(0,40); } })()}</span>
                  </span>
                </label>
                <button data-preview="${s.index}" title="Preview" style="flex-shrink:0;margin-top:2px;padding:2px 5px;background:transparent;border:1px solid #334155;border-radius:4px;cursor:pointer;font-size:12px;color:#94a3b8">👁</button>
              </div>`,
            ).join('');
            openPopup(`
              <div style="font-size:13px;font-weight:700;color:#f8fafc">📌 Pin Checkpoint</div>
              <div style="font-size:11px;color:#94a3b8">Select which step to pin as a named checkpoint:</div>
              <div style="overflow-y:auto;max-height:220px;display:flex;flex-direction:column;gap:2px;padding-right:2px">${rows}</div>
              <div style="height:1px;background:#334155"></div>
              <input id="cpName" placeholder="Name, e.g. after-login or studio-ready"
                style="padding:7px 9px;border-radius:5px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px;outline:none;width:100%;box-sizing:border-box">
              <label style="display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer">
                <input type="checkbox" id="cpCommon">
                <span>Mark as <strong>common precondition</strong> <span style="color:#64748b">(shared setup, e.g. login)</span></span>
              </label>
              <div style="display:flex;gap:6px;justify-content:flex-end">
                <button id="cpCancel" style="padding:5px 14px;background:#334155;color:#e2e8f0;border:none;border-radius:5px;cursor:pointer;font-size:12px">Cancel</button>
                <button id="cpSave" style="padding:5px 14px;background:#1e40af;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px">📌 Pin</button>
              </div>
            `, (dlg) => {
              (dlg.querySelector('#cpName') as HTMLInputElement).focus();
              dlg.querySelectorAll('[data-preview]').forEach((btn) => {
                btn.addEventListener('click', (e) => { e.preventDefault(); previewScreenshot(parseInt((btn as HTMLElement).dataset.preview!, 10)); });
              });
              dlg.querySelector('#cpCancel')!.addEventListener('click', () => document.getElementById('__ata_overlay__')?.remove());
              dlg.querySelector('#cpSave')!.addEventListener('click', () => {
                const name = (dlg.querySelector('#cpName') as HTMLInputElement).value.trim();
                const isCommon = (dlg.querySelector('#cpCommon') as HTMLInputElement).checked;
                const sel = dlg.querySelector('input[name="cpstep"]:checked') as HTMLInputElement | null;
                const idx = sel ? parseInt(sel.value, 10) : lastIdx;
                if (!name) { (dlg.querySelector('#cpName') as HTMLInputElement).style.borderColor = '#ef4444'; return; }
                (window as any).__ataAddCheckpoint__(name, isCommon, idx);
                document.getElementById('__ata_overlay__')?.remove();
              });
            });
          }).catch(() => {});
          }); // end finally
        });

        // ── 🎬 Use case button → popup with from/to selects ───────────────
        const ucBtn = mkBtn('🎬 Use case', '#7c3aed');
        ucBtn.addEventListener('click', () => {
          (window as any).__ataSnapNow__().catch(() => {}).finally(() => {
          (window as any).__ataGetSteps__().then((list: {index: number; url: string; title: string; name: string}[]) => {
            if (list.length < 2) { alert('Need at least 2 steps — navigate more, then try again.'); return; }
            const mkOpts = (preferLast: boolean) => list.map((s, i) =>
              `<option value="${s.index}" ${(preferLast ? i === list.length - 1 : i === 0) ? 'selected' : ''}>
                Step ${s.index + 1}: ${s.name.slice(0, 45)}
              </option>`,
            ).join('');
            openPopup(`
              <div style="font-size:13px;font-weight:700;color:#f8fafc">🎬 Define Use Case</div>
              <div style="font-size:11px;color:#94a3b8">Select the step range that covers this user flow:</div>
              <div style="display:flex;flex-direction:column;gap:6px">
                <label style="font-size:11px;color:#94a3b8;font-weight:600">From step:</label>
                <select id="ucFrom" style="padding:6px;border-radius:5px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px">${mkOpts(false)}</select>
                <label style="font-size:11px;color:#94a3b8;font-weight:600">To step:</label>
                <select id="ucTo" style="padding:6px;border-radius:5px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px">${mkOpts(true)}</select>
              </div>
              <input id="ucName" placeholder="Name, e.g. model-generation or checkout"
                style="padding:7px 9px;border-radius:5px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px;outline:none;width:100%;box-sizing:border-box">
              <div style="display:flex;gap:6px;justify-content:flex-end">
                <button id="ucCancel" style="padding:5px 14px;background:#334155;color:#e2e8f0;border:none;border-radius:5px;cursor:pointer;font-size:12px">Cancel</button>
                <button id="ucSave" style="padding:5px 14px;background:#7c3aed;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px">🎬 Save</button>
              </div>
            `, (dlg) => {
              (dlg.querySelector('#ucName') as HTMLInputElement).focus();
              dlg.querySelector('#ucCancel')!.addEventListener('click', () => document.getElementById('__ata_overlay__')?.remove());
              dlg.querySelector('#ucSave')!.addEventListener('click', () => {
                const name = (dlg.querySelector('#ucName') as HTMLInputElement).value.trim();
                const from = parseInt((dlg.querySelector('#ucFrom') as HTMLSelectElement).value, 10);
                const to = parseInt((dlg.querySelector('#ucTo') as HTMLSelectElement).value, 10);
                if (!name) { (dlg.querySelector('#ucName') as HTMLInputElement).style.borderColor = '#ef4444'; return; }
                (window as any).__ataAddUseCase__(name, from, to);
                document.getElementById('__ata_overlay__')?.remove();
              });
            });
          }).catch(() => {});
          }); // end finally
        });

        const doneBtn = mkBtn('✅ Done', '#22c55e');
        doneBtn.addEventListener('click', () => { (window as any).__ataDone = true; });

        // Done → review panel (not immediate)
        doneBtn.removeEventListener('click', doneBtn as any);
        doneBtn.addEventListener('click', () => {
          (window as any).__ataSnapNow__().catch(() => {}).finally(() => {
            (window as any).__ataGetSteps__().then((list: {index: number; url: string; title: string; name: string}[]) => {
              document.getElementById('__ata_overlay__')?.remove();
              const overlay = document.createElement('div');
              overlay.id = '__ata_overlay__';
              Object.assign(overlay.style, {
                position: 'fixed', inset: '0', zIndex: '2147483646',
                background: 'rgba(0,0,0,0.7)', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              });
              const dlg = document.createElement('div');
              Object.assign(dlg.style, {
                background: '#1e293b', borderRadius: '10px', padding: '16px',
                width: '440px', maxWidth: '94vw', maxHeight: '85vh',
                boxShadow: '0 8px 32px rgba(0,0,0,.7)',
                fontFamily: 'system-ui,sans-serif', color: '#e2e8f0',
                display: 'flex', flexDirection: 'column', gap: '10px',
              });

              const hdrTxt = document.createElement('div');
              hdrTxt.innerHTML = `<span style="font-size:14px;font-weight:700;color:#f8fafc">✅ Review Steps</span>
                <span style="font-size:11px;color:#64748b;margin-left:8px">${list.length} captured — rename any before saving</span>`;

              const scroll = document.createElement('div');
              Object.assign(scroll.style, { overflowY: 'auto', flex: '1', display: 'flex', flexDirection: 'column', gap: '4px', paddingRight: '2px' });

              list.forEach((s) => {
                const row = document.createElement('div');
                Object.assign(row.style, { display: 'flex', gap: '6px', alignItems: 'center' });
                const num = document.createElement('span');
                num.textContent = `${s.index + 1}.`;
                Object.assign(num.style, { fontSize: '11px', color: '#475569', width: '22px', flexShrink: '0', textAlign: 'right' });
                const inp = document.createElement('input');
                inp.value = s.name;
                inp.dataset.idx = String(s.index);
                Object.assign(inp.style, {
                  flex: '1', padding: '5px 7px', borderRadius: '4px',
                  border: '1px solid #334155', background: '#0f172a',
                  color: '#e2e8f0', fontSize: '12px', outline: 'none',
                });
                inp.addEventListener('change', () => {
                  (window as any).__ataSetStepName__(s.index, inp.value).catch(() => {});
                });
                const urlSpan = document.createElement('span');
                urlSpan.textContent = (() => { try { return new URL(s.url).pathname.slice(0, 20) || '/'; } catch { return s.url.slice(0, 20); } })();
                Object.assign(urlSpan.style, { fontSize: '10px', color: '#475569', width: '90px', flexShrink: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
                const eyeBtn = document.createElement('button');
                eyeBtn.textContent = '👁';
                eyeBtn.title = 'Preview screenshot';
                Object.assign(eyeBtn.style, { flexShrink: '0', padding: '2px 5px', background: 'transparent', border: '1px solid #334155', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', color: '#94a3b8' });
                eyeBtn.addEventListener('click', () => previewScreenshot(s.index));
                row.appendChild(num); row.appendChild(inp); row.appendChild(urlSpan); row.appendChild(eyeBtn);
                scroll.appendChild(row);
              });

              const sep2 = document.createElement('div');
              Object.assign(sep2.style, { height: '1px', background: '#334155' });

              const footer = document.createElement('div');
              Object.assign(footer.style, { display: 'flex', gap: '6px', justifyContent: 'flex-end' });
              const cancelBtn2 = document.createElement('button');
              cancelBtn2.textContent = 'Keep exploring';
              Object.assign(cancelBtn2.style, { padding: '6px 14px', background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '12px' });
              cancelBtn2.addEventListener('click', () => overlay.remove());
              const confirmBtn = document.createElement('button');
              confirmBtn.textContent = '✅ Save & Done';
              Object.assign(confirmBtn.style, { padding: '6px 14px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '12px' });
              confirmBtn.addEventListener('click', () => {
                // Flush all edited inputs before confirming
                scroll.querySelectorAll('input[data-idx]').forEach((el) => {
                  const inp2 = el as HTMLInputElement;
                  (window as any).__ataSetStepName__(parseInt(inp2.dataset.idx!, 10), inp2.value).catch(() => {});
                });
                overlay.remove();
                (window as any).__ataDone = true;
              });
              footer.appendChild(cancelBtn2); footer.appendChild(confirmBtn);

              dlg.appendChild(hdrTxt); dlg.appendChild(scroll); dlg.appendChild(sep2); dlg.appendChild(footer);
              overlay.appendChild(dlg);
              document.body.appendChild(overlay);
            }).catch(() => { (window as any).__ataDone = true; });
          });
        });

        bar.appendChild(lbl); bar.appendChild(stepLbl);
        bar.appendChild(cpBtn); bar.appendChild(ucBtn); bar.appendChild(doneBtn);
        document.body?.appendChild(bar);
      }

      // ── Click/change listener — capture action names automatically ───────
      if (!(window as any).__ataClickListener) {
        const clickHandler = (e: Event) => {
          if (isOurs(e.target as Node)) return;
          // Walk up from the click target to find the nearest element with a useful label.
          // Skip purely structural/decorative tags (svg, path, span, div without aria).
          const INTERACTIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'LI', 'OPTION', 'SUMMARY']);
          let best: Element | null = null;
          let node: Element | null = e.target as Element;
          while (node && node !== document.body) {
            const tag = node.tagName;
            const aria = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-testid');
            const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (aria) { best = node; break; }
            if (INTERACTIVE.has(tag) && text.length > 0 && text.length <= 60) { best = node; break; }
            if (INTERACTIVE.has(tag)) { best = node; } // keep as fallback, keep walking
            node = node.parentElement;
          }
          const el = best ?? (e.target as Element);
          const label = (
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('data-testid') ||
            (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) ||
            el.getAttribute('placeholder')
          );
          if (label) (window as any).__ataSetPendingAction__(`click "${label}"`).catch(() => {});
        };
        document.addEventListener('click', clickHandler, true);
        (window as any).__ataClickListener = clickHandler;
      }

      // ── MutationObserver ─────────────────────────────────────────────────
      if (!(window as any).__ataObserver) {
        let timer: ReturnType<typeof setTimeout>;
        const observer = new MutationObserver((mutations) => {
          if (mutations.every((m) => isOurs(m.target)) || (window as any).__ataDone) return;
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
  process.stderr.write('[explore] Toolbar (top-right): 📌 Checkpoint  🎬 Use case  ✅ Done\n\n');

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

  await page.evaluate(() => {
    (window as any).__ataObserver?.disconnect();
    document.getElementById('__ata_overlay__')?.remove();
    document.getElementById('__ata_preview__')?.remove();
    document.getElementById('__ata_toolbar__')?.remove();
  }).catch(() => {});

  // Bake final (possibly user-edited) names into each step's notes.
  const namedSteps = steps.map((s, i) => ({
    ...s,
    notes: [...(s.notes?.filter((n) => !n.startsWith(`step ${i + 1}:`)) ?? []), `step ${i + 1}: ${stepNames[i] ?? autoStepName(s, i)}`],
  }));

  const last = namedSteps.at(-1) ?? (await perceive(page, target.name));
  return {
    ...last,
    steps: namedSteps,
    checkpoints: checkpoints.length ? checkpoints : undefined,
    useCases: useCases.length ? useCases : undefined,
  };
}
