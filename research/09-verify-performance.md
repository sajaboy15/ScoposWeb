# 09 · Verify: performance on weak hardware and long sessions

Scope: `extension/core/pointer.js`, `scan.js`, `guide.js`, `explore.js`, `guard.js`, `sdk/widget.js`, `extension/content.js`.
Line numbers are from the working tree as of 2026-10-17 14:02. The sources were re-synced during this review; the code was re-read and the simulations were re-run on the new copy.

How this was checked:
- Careful reading of every loop, observer, listener, timer and cache.
- A Node simulation with a fake DOM and a virtual clock (fake `requestAnimationFrame`, timers, `requestIdleCallback`, and MO/IO/RO). It loads the real `pointer.js`, `guide.js` and `scan.js` and counts what is still alive after each cycle. The script ran from the scratchpad and is deleted; nothing was left in `dev/verify`.
- Micro-benchmarks of the pure-JS parts of `scan.js` and `explore.js`.
- No browser was used. DOM costs (layout, `elementFromPoint`, `querySelectorAll`) are **estimates** and are marked as such.

The benchmark machine is an **Intel i3-8145U (2 cores, 4 threads, 15 W)**. That is exactly the "weak 4-core laptop" class, and `IS_LITE` is true on it. The measured numbers are the weak-hardware numbers.

## Ranked list

| # | Severity | Where | What |
|---|---|---|---|
| 1 | HIGH | pointer.js:781, 645 | A target that keeps moving never "lands". The rAF loop runs every frame forever and the frame is never shown. |
| 2 | HIGH | guide.js:312-329, 360-369; scan.js:592-620, 1258-1290 | One `resolve()` is a 150–500 ms long task at 3000 controls. `wait()` runs it 33×/min, and after give-up once per ~0.46 s while the user types. |
| 3 | HIGH | guide.js:85-130, 150-160, 290-297 | Every `show()` resolves synchronously. Mashing «Далее/Назад» queues N full resolves, and a vanished control triggers 4 resolves in 1 s. |
| 4 | MEDIUM | pointer.js:548, 564 | The window-wide scroll catch-all wakes the frame loop for unrelated scrollers (carousels, tickers, chat lists). |
| 5 | MEDIUM | guide.js:195-211, 290-298 | Forced synchronous layouts: `sameControl()` on every key, input, click and focus event anywhere on the page, and the arm MO every 300 ms (background tabs included). |
| 6 | MEDIUM | explore.js:469-477, 610, 334; scan.js:1196-1205, 946 | Explorer: `captureView` is a 0.5–1.5 s single task on big pages. Each probe does 2–3 full-page passes. |
| 7 | MEDIUM | explore.js:409, 479-480, 570-617; widget.js:104-105; background.js:779 | Explorer state: `size()` allocates ~35 MB per call, and the whole state (≤1.5 MB) is serialized 2–3× per probe (~400×/walk). |
| 8 | LOW | pointer.js:50, 79, 92; widget.js:180-204, 256-266 | Infinite animations: the pulse runs for the whole step, dots run while waiting and inside the hidden card, and the widget spinner keeps going in the closed panel and restarts 4×/s. |
| 9 | LOW | pointer.js:42, 48, 50, 57, 65 | `will-change` stays on for the whole step: 5–6 persistent layers, and the frame layer can be viewport-sized. |
| 10 | LOW | pointer.js:609-612 | After give-up, IO and RO keep observing the detached target, and `target`/`levels` keep the removed subtree alive. |
| 11 | LOW | scan.js:1028, 1042-1049, 1146 | `everyId` grows without bound on virtualized lists, the prune runs O(n) on every scan, and a stale id can return a recycled row. |
| 12 | LOW | scan.js:615 | `textContent` of big generic containers (`[jsaction*=click]`, `[tabindex]` roots) is computed per scan. |
| 13 | LOW | widget.js:133-135 | `post('/learn')` has no deadline. A hung request re-renders every second forever. |
| 14 | LOW | content.js:11; background.js:141-147 | After an extension reload, the orphaned content script keeps its observers running, and a second copy gets injected. |

Everything else checked is fine; see "Verified fine" at the end.

---

## 1. HIGH: a moving target makes the flight re-aim forever (infinite rAF, frame never shown)

**Where**
- `pointer.js:781`: `if (!ringAt || Math.abs(rx - ringAt.x) > 0.5 || …) { setRing(rx, ry); if (!start) flyEnd = t + FLY_MS; }`
- `pointer.js:645`: `busy = … || phase === 'flying' || …`
- `pointer.js:790` (frame visibility): `frameEl.classList.toggle('on', geo && (phase === 'landed' || t >= flyEnd - FLY_MS * 0.4))`

**Scenario.** The target moves by more than 0.5 px within any 620 ms window. Small drifts add up until they cross the threshold. Common cases:
- a CTA with a CSS `scale` pulse, or a parent with an infinite transform animation;
- a carousel or marquee;
- a button whose label is a live counter, so its width changes;
- a layout that is still settling.

Every re-aim pushes `flyEnd` another 620 ms into the future, so `phase` never becomes `landed`.

**Verified in the simulation.** A target oscillating ±20 px produced **625 frames in 10 s** (every frame). The end state was `state: "flying"` and `frameOn: false`: the highlight frame never appeared.

**Impact on weak hardware**
- `measure()` + `write()` run 60×/s with no end.
- The occlusion probe runs every 300 ms on lite (5–10 `elementFromPoint`, plus `elementsFromPoint` when the hit is our card).
- `--x/--y` are rewritten every frame, which restarts the 0.62 s cursor transition every frame. That means main-thread style and transition work plus a new compositor animation each frame.
- The ring chases the target and the frame never shows, so this is also a visible functional bug.

**Fix**
- Bound the flight:
  - record `flyStart` in `fly()`;
  - when re-aiming, use `flyEnd = Math.min(t + FLY_MS, flyStart + FLY_MS * 1.5)`;
  - only re-aim for jumps over ~8 px. The CSS transition already retargets small moves.
- Once landed, a target that moves continuously is followed through IO and `settle()`, which is correct. On `IS_LITE`, cap that work: after `stable` has stayed 0 for over 2 s, measure every 2nd frame (or switch to a 66 ms `setTimeout` poll) and keep `.snap` on.

## 2. HIGH: `resolve()` costs 150–500 ms at 3000 controls and runs up to 33×/min, plus once per keystroke after give-up

**Cost of one `resolve()`** (`scan.js:1299` → `context` → `controls(null)` → `rank`). Each step:
1. `topModal()` + `controls()`: `rootsOf(document)` runs `querySelectorAll('*')` over the whole document and visits every element (scan.js:416-446), then `querySelectorAll(CONTROL+POINTERISH)` on every root.
2. Per raw control: `matches(CONTROL)`, then `isVisible()` (`getBoundingClientRect` + `checkVisibility({opacity…})` + `getComputedStyle`), then a `pointer-events` read (scan.js:592-620).
3. `rank()`: `worth()` → `base()` (name, container) for **every** control, then `cand()` → `feats()` (classes, ancestry, `new URL` for href, 3× `normText`), then the cheap `scoreFeatures` (scan.js:1258-1275).
4. Full context (heading, neighbors, row) for the top 20, or up to 200 when the target sits in a row. In-viewport candidates also get `isOccluded` (5 hit tests each).

Measured on the i3-8145U (pure JS only):
- `normText` ×3000: **16 ms**.
- Cheap + full `scoreFeatures` over 3000 candidates: **39 ms**.

Estimated DOM part:
- `rootsOf` + selector query over ~40k nodes: 30–60 ms.
- Visibility/style pass over ~5000 raw hits: 50–100 ms.
- `base()`: 30 ms warm (`nameMemo` hit) or 90–150 ms cold (`innerText` per control).
- `feats` attrs: 60–90 ms.

**Total: ~150–250 ms on a typical big page and ~300–500 ms in the worst case.** The worst case is a 3000-row table where every row has «Удалить» in the same container, so every row passes `worth()` and `inRow` widens full scoring to 200. That is a single long task each time; `requestIdleCallback` only delays the start, and `check` ignores `deadline.timeRemaining()`.

**How often it runs**
- `wait()`, verified in the simulation with constant DOM churn: **33 resolves in the 60 s wait** (backoff 250 → 500 → 1000 → 2000 ms; guide.js:323). On the worst-case page that is ~1 s of blocking in the first 2 s, then a 300–500 ms freeze every 2 s for the rest of the minute.
- After give-up (guide.js:366-368), `poke = throttle(() => schedule(true), 400)` is attached to **keyup** and pointerup, and `schedule(true)` resets the delay to 250 → 60 ms. Typing anywhere therefore runs a full resolve every ~460 ms. This is exactly when the card says «сделайте шаг сами», so the user is likely to be typing into a field, and the input lag shows on every keystroke.
- In background tabs the MO keeps firing and timers are clamped to 1/s, so resolves continue until give-up. `GIVE_UP` (guide.js:360) and `LOST_MAX_MS` (pointer.js:612) also count hidden time, so a user who comes back after a minute finds the step already given up.

**Fix**
1. **Adaptive backoff by measured cost**, which keeps the main-thread duty cycle at ≤10%:
   ```js
   const t0 = performance.now(); const el = find(step); const cost = performance.now() - t0;
   delay = Math.min(Math.max(delay * 2, cost * 10), 5000);
   ```
2. **Cheap relevance pre-filter in the MO** (guide.js:330-336): only schedule a check when an added or changed subtree could hold the target. Two tests:
   - its text contains the first word of the target's name: `(n.textContent || '').toLowerCase().includes(firstWord)`;
   - it matches the descriptor's simple selectors (`d.sel` entries without combinators).

   Fall back to the timed check every 5–10 s.
3. **After give-up, drop `keyup`** (or throttle to ≥3 s and ignore events whose target is a text field). Keep pointerup, `hashchange` and `popstate`.
4. **Pause while hidden.** On `visibilitychange` → hidden, disconnect the MO and freeze both clocks (`GIVE_UP`, `LOST_MAX_MS`); on visible, reconnect and run one urgent check.
5. Optional, and larger: cache `controls(null)` across tasks behind a "DOM generation" counter that the MO bumps. A resolve with no relevant mutation then costs only `rank`.

## 3. HIGH: every step change resolves synchronously; spam and vanish paths repeat it

**Where:** `guide.js:85-92` (`go`) → `118-130` (`show` → `find` → `S.resolve`).

**Verified.** `guide.go()` ×20 performed **20 synchronous resolves**. No observers or timers piled up, since `clearWatch()` runs every time. Mashing «Далее/Назад» five times on a big page is therefore 0.75–2.5 s of frozen UI.

**Vanish path.** Verified: a control that disappears costs **4 resolves within 1 s**, from three sources that all hunt for it:
- the pointer's `relocate` (pointer.js:609-621) → `guide.relocate` (guide.js:150-160), whose deferred `show()` (guide.js:158) adds another `find`;
- the arm MO (guide.js:290-297) → `find`, then `show()` → `find` again.

**Fix**
- Make `show()` draw the card immediately in a "searching" state. Defer `find()` to one rAF or idle callback keyed by `(run, index)`, so a burst of `go()` calls resolves only the final index.
- Make the arm MO stop hunting:
  - replace `if (shown(cur())) return;` with `if (cur() && cur().isConnected) return;`;
  - drop the `find()` there, because the pointer already detects removal and hiding through IO/RO and calls `relocate`;
  - or remove the MO entirely (see #5).
- In `relocate()`, skip the deferred `show()` when the arm MO has already switched the step to `wait()`. For example, keep a `me.waiting` flag set in `wait()`.

## 4. MEDIUM: the window-wide scroll listener wakes the loop for scrollers unrelated to the target

**Where**
- `pointer.js:548`: `g(root, 'scroll', onScroll, { capture: true, passive: true })`
- `pointer.js:564`: `const onScroll = () => { scrollActiveUntil = now() + 150; settle(); };`

The capture listener on `window` sees **every** element scroll in the light DOM. An auto-scrolling carousel, a news ticker, a chat list receiving messages, or a virtualized table the user scrolls in another panel each starts a 600 ms frame loop per scroll event. That means continuous frames while it scrolls: `measure()` plus occlusion probes every 300 ms, all for a target that did not move.

**Fix.** Ancestor scrollers already get direct listeners (pointer.js:518), so the catch-all only needs the document scroll:
```js
const onAnyScroll = e => { const t = e.target; if (t === DOC || t === DOC.documentElement || t === DOC.body || (target && t.nodeType === 1 && holds(t, target))) onScroll(); };
```
If a scroller added after `attach()` must be caught, `holds(t, target)` already covers it.

## 5. MEDIUM: forced synchronous layouts in `guide.arm()`

**Event handlers.** `inside(e)` runs on **every** `keydown`, `pointerdown`, `click`, `change` and `focusout` anywhere on the page, and on every `input` during a type step (guide.js:217-264). When the event is not on the target, it falls through to `sameControl(t)` (guide.js:195-199). That function calls `shown(cur())` (`getBoundingClientRect` + `checkVisibility` + `getComputedStyle`) **before** its cheap checks, and then `S.labelOf(c)`, which can read `innerText`.

On `input` events the DOM has just changed, so this forces a synchronous layout on **every keystroke in any other field** while a type step is shown. Cost: 5–30 ms per key on a big page on this laptop (estimate).

**The arm MO** (guide.js:290-298) observes `childList, subtree` on `documentElement` for as long as a step is shown, which can be hours. Every 300 ms, after mutations, it calls `shown(cur())`, which is a forced layout because the DOM is dirty. On chat or live-dashboard pages that is ~3 extra layouts/s. In background tabs it is still ~1/s because of timer clamping; nothing checks `document.hidden`.

**Fix**
- `sameControl`: start with `const c0 = cur(); if (c0 && c0.isConnected) return false;`. That catches the common case without layout. Only a replaced, disconnected control gets the label comparison.
- Arm MO: use `cur() && cur().isConnected` instead of `shown()`, since `childList` can only detect removal and hiding is handled by the pointer's IO/RO → relocate. Also `if (document.hidden) return;`. Better still, delete the MO and rely on the pointer's relocate path (see #3).

## 6. MEDIUM: explorer cost per view and per probe on big pages

**`captureView`** (explore.js:469-477) → `control()` → `S.describe(x.el)` for up to 150 controls in **one synchronous task**. Each `describe` does:
- `feats(full)`;
- `twinOf(el, controls(null))`, which is O(pool) for each new role/name key (scan.js:946-959);
- `selectorsFor` (scan.js:1196-1205), which runs `deepQueryAll(s)` over **all roots** for each candidate selector until one is unique.

Each control also gets `pressKind` → `danger` → `textOf`, which reads `innerText` (explore.js:162-170), and `linkView` → `safeHref` → `danger` again.

Estimate on the i3 at 3000 controls: **0.5–1.5 s single long task per captured view**.

**Per probe** (explore.js:597-674):
- `before = new Set(inventory().map(...))` is a full controls pass (explore.js:610);
- `refind` → `resolveDetailed` is a second full pass in a separate task (explore.js:334);
- `appearedAfter` runs `inventory(root)` for each changed root.

Estimate: **0.3–0.8 s of main-thread work per probe**, up to 160 probes, which is 1–2 min of CPU over a 5-minute walk.

**Fix**
- Yield inside `captureView` every ~10 controls: `await new Promise(r => setTimeout(r))`, or `scheduler.yield()` where available. This makes `captureView` async.
- Check selector uniqueness in one pass per view. Build `Map<attr=value, count>` for `data-testid`, `id`, `name` and `aria-label` from a single `deepQueryAll('[data-testid],[id],[name],[aria-label]')`, then look counts up instead of querying per selector.
- Reuse `before` from the previous probe's post-press inventory when `watchChanges` saw no mutation.
- Call `pressKind()` once per control and cache the result. `pick()` and `control()` both call it.

## 7. MEDIUM: explorer state serialization and `size()` allocations

**`size()`** (explore.js:479-480): `s.length + (s.match(/[^\x00-\x7f]/g) || []).length`. The global match builds an array of one string per non-ASCII character, and Cyrillic is almost all non-ASCII.

| State | `size()` regex | `TextEncoder` |
|---|---|---|
| 2.1 M chars | **54 ms, ~35 MB transient heap** | — |
| 1.6 M chars | 35 ms | 8 ms, no garbage |

`fit()` calls `size()` once per new view and up to 5× while over the limit.

**`save()`** (explore.js:409) ships the whole state:
- through `chrome.runtime.sendMessage` into `chrome.storage.session` (background.js:779);
- in the SDK, synchronously into `sessionStorage` (widget.js:104-105).

It runs before every press (explore.js:617), after every probe (explore.js:585), and after every captured view and navigation step. That is ~2–3 full-state saves per probe and **~400 per walk**. At the limit (1.5 M "bytes", about 1.1 M chars), one save is `JSON.stringify` (~10 ms) plus message serialization and parsing (~10–20 ms) plus the storage structured clone (~25 ms, measured 35 ms for 1.6 M chars). In total that is **~16–24 s of CPU per walk** spread over the content script and the service worker, plus GC churn.

**Fix**
- `size()`: `new TextEncoder().encode(s).length`, or a `charCodeAt` loop (9 ms, no allocation).
- Save before a press only a small delta (`{ pending, probes, cur, nav }`) under a second key, and merge it in `boot()`.
- Save the full state only after `captureView`, when a view is added, and before `location.href`/`reload()`. Otherwise debounce to ≥1 s.

## 8. LOW: infinite animations

What is respected:
- `pulse` (pointer.js:50) is limited to 2 iterations under `.lite` (pointer.js:51) and turned off under reduced motion (pointer.js:101).
- `.dots i` and `.rec .dot` are limited to 3 iterations under `.lite` (pointer.js:93) and turned off under reduced motion.
- The widget `.spin` is turned off under reduced motion (widget.js:218).

What remains:
- **Pulse is infinite on non-lite machines** for as long as a step is shown, which can be hours. It is compositor-only (transform and opacity), but it keeps producing 60 fps frames and stops the GPU from idling, which costs battery.
- **The `.dots` blink is infinite while waiting or "away"** (pointer.js:79, card.innerHTML at 259). It is **not gated by `.card.on`**, and `card.innerHTML` is never cleared on `hide()`. The animation therefore keeps running inside the hidden card until `park()` (260 ms). Where `popover` is unsupported (the SDK on Safari < 17 or Firefox < 125), `park()` cannot `display:none` the host, so it runs forever after the guide ends.
- **Widget `.spin`** (widget.js:204):
  - there is no lite rule;
  - it keeps spinning while the panel is closed, because `.panel` is only `opacity: 0` (widget.js:180-183), not hidden;
  - `render()` rebuilds `body.innerHTML` on every NDJSON progress line, which the server sends every 250 ms (server.mjs:218). That re-creates the spinner 4×/s, restarting its animation each time, so it visibly stutters.

**Fix**
- `.cursor.on.landed .ring::after { animation-iteration-count: 4 }` for everyone, or stop the pulse after ~7 s.
- Change the selector to `.card.on .dots i { animation: … }`, and set `card.innerHTML = ''` in `park()`.
- Widget:
  - `.w:not(.open) .panel { visibility: hidden; transition: opacity .2s, transform .3s, visibility 0s .3s; }`. This stops the hidden spinner and also takes the closed panel's buttons out of the tab order and the accessibility tree.
  - On progress, update only the `<span>` text instead of `body.innerHTML`.

## 9. LOW: `will-change` held for the whole step

**Where:** pointer.js:42, 48, 50, 57, 65 (`.cursor.on`, `.cy`, `.ring`, `.ring::after` while landed, `.frame.on`, `.card.on`).

These rules keep 5–6 composited layers alive for as long as a step is on screen. The frame layer is the size of the control's visible part, which is up to the viewport: about 16 MB of GPU memory at DPR 2 for a 1280×800 panel. Nothing is left on after `hide()`, because the rules are class-gated.

**Fix:** keep `will-change` only under `.cursor.flying` and `.layer.snap`. Transform and opacity transitions promote their layers automatically while they run.

## 10. LOW: detached target retained after give-up

**Where:** `pointer.js:609-612`. After `LOST_MAX_MS` the code sets `gaveUp = true; unwatchLost();` but never calls `detach()`.

**Verified in the simulation:** after give-up, `io: 1, ro: 1` are still observing. `target` and `levels` (clippers, scrollers, iframe documents) keep the detached node and its whole removed subtree until `hide()` or the next `point()`. Whole SPA route views can stay alive this way.

In the guide this is brief, because `draw(null)` follows. Explorer `flash()` has no `relocate`, so a removed target is held until the next probe.

**Fix:** on give-up, `detach(); target = null;`. `stateOf()` still reports `gone` through `current.relocate`.

## 11. LOW: `everyId` growth and stale ids

**Where:** `scan.js:1028`, `remember` (1037-1041), prune (1146).

Each scan adds up to 260 entries and each `candidatesFor` up to 8. The prune only removes dead or disconnected nodes. In virtualized lists the recycled rows stay connected and get a new id whenever their name changes. The map therefore grows without bound, and once it passes 4000 the O(n) prune loop runs on every `scan()` without shrinking it.

There is also a correctness problem: `byId(oldId)` (1042-1049) returns a recycled row that now shows another record.

**Fix**
- In `byId` and in the prune, reject an entry when `idMap.get(el)?.id !== id`.
- Cap the map at 4000 by deleting the oldest entries (a `Map` keeps insertion order).

## 12. LOW: `textContent` of big generic containers per scan

**Where:** `scan.js:615`: `if (generic(el) && (el.textContent || '').length > 200) continue;`

It runs for every visible generic control, which includes `[jsaction*="click"]`, `[tabindex]` and `[onclick]` wrappers. Google-style apps put these on large nested containers, so every scan builds full-subtree strings for each of them: O(nodes × depth) characters.

**Fix:** use a bounded check. Cheap shortcut first: `el.childElementCount > 30 → skip`. Otherwise walk the text nodes with a `TreeWalker`, summing `.length`, and stop at 200.

## 13. LOW: the learn request has no deadline

**Where:** `widget.js:133-135`. `learnTimer` re-renders every second while `learning.status === 'writing'`, but `post('/learn', …)` has no `AbortController`. If the connection hangs, the panel and launcher `innerHTML` are rebuilt every second forever.

**Fix:** use `const ctl = new AbortController(), clear = deadline(ctl, 5 * 60e3)` and pass `signal`, the same way `ask()` does.

## 14. LOW: orphaned content script after an extension reload or update

**Where:** `content.js:11`. `send()` swallows "Extension context invalidated".

A guide, `wait()` or explorer running at reload time keeps its MOs, timers and window listeners in the old isolated world for the rest of the page's life.

The new service worker's `toTab()` (background.js:141-147) then gets no ping answer and injects `CORE_FILES` again in a new world. The tab ends up with two `scopos-layer` hosts and two sets of observers. Long-lived SPA tabs (CRMs, mail) are where this happens.

**Fix:** in `send`'s catch, check `!chrome.runtime?.id`. If it is gone, tear down once: `S.guide.stop(false); S.recorder.stop(); S.explore.stop(); S.pointer.hide(); S.guard.off();`.

---

## Cost model: `scan` / `inventory` / `resolve` at 3000 controls (i3-8145U)

| Operation | Estimated cost (measured JS part) | When it runs | Worst frequency |
|---|---|---|---|
| `scan({query})` | cold 250–400 ms, warm 150–250 ms (`normText` ×3000 = 16 ms) | each question (side panel, widget), each heal (`onMissing`) | per user action. Never per mutation or per frame. A query names **all** far controls (scan.js:1099), so the cold first call pays `innerText` for every control. |
| `resolve(d)` | typical 150–250 ms, worst 300–500 ms (scoring 3000 = 39 ms) | every `show()`/`go()`; `wait()` checks; pointer `relocate`; explorer `refind` | `wait()`: 33 per 60 s under churn, then once per ~0.46 s while typing after give-up. `relocate`: 19 per 30 s, until the guide falls back to `wait()`. |
| `inventory()` | 100–200 ms | explorer only: before each press, per changed root after it, per captured view | 2–3 per probe |
| `describe(el)` | 1–8 ms each (dominated by `selectorsFor` `deepQueryAll`) | per recorded click, per healed step, per Claude step id, ×150 per explorer view | 150 in one task per view |
| Pointer frame | O(1) in page size: target and clipper rects, iframe offsets; 5–10 `elementFromPoint` every 300 ms (lite) | only while flying, scrolling, settling (600 ms after a trigger) or animating (≤2 s) | every frame only in case #1 or with #4 |

On weak hardware the risk is not "per mutation" or "per frame" work. Nothing in `scan.js` runs at that rate. The risk is **a few hundred-millisecond long tasks repeated by `wait()`, `poke`, `go()` and explorer probes**.

---

## Verified fine

Checked against the simulation counters:
- **`hide()` releases everything.** Across point/hide, 20× `point()`, a moving target, the lost path, and guide start/stop/wait/give-up, the counts after `hide()`/`stop()` are always **0 rAF, 0 timers, 0 MO/IO/RO, 0 listeners**. The card's own 4 listeners are permanent by design. This includes scrollers in shadow roots and iframes: same `on()` → `offs` path, removed by `detach()`.
- **`point()` ×20:** no pile-up. 1 IO, 1 RO and 1 MO are alive at any time; 20 IO and 20 RO were created and each was disconnected. Popover re-raising is rate-limited to 6/s (pointer.js:225-227).
- **Stable target:** the rAF loop stops by itself (40 frames in 3 s for flight + settle, then none). Reads come before writes in each frame. The occlusion probe is rate-limited to 150 ms, or 300 ms on lite (pointer.js:677).
- **Hidden tab:** no frames (sim: 0 in 5 s). `schedule()` and `frame()` check `DOC.hidden` (pointer.js:632-637), and `onVisibility` cancels the pending rAF.
- **Lost target:** backoff 100 ms → 2 s, 19 `relocate` calls in 40 s, then give-up with the lost MO and the timer released (sim). The `style` attribute is observed, but only for those ≤30 s.
- **Global MO:** `attributeFilter: ['open']` only (pointer.js:558), so it is cheap.
- **Guide `wait()`:** the MO exists only while waiting and `style` is not observed. Backoff 250 ms → 2 s, idle callback, and give-up at 60 s disconnects the MO. `stop()` releases everything, including the post-give-up `poke` listeners.
- **Guide timers:** `advance()` and `optionPicked` timers are not in cleanup, but they are short and guarded by `alive(me, at)`.
- **No transitions on layout properties.** The frame's `width`/`height` are set without a transition (pointer.js:745, and `.frame` transitions only opacity and transform). Card, cursor and ring animate transform and opacity only, as do the widget panel and launcher.
- **`scan.js` caches:**
  - the per-task cache is dropped at the next microtask;
  - `nameMemo`, `idMap` and `lastFound` are WeakMaps;
  - `snapshot` is replaced on every scan.
- **`content.js`:** one `onMessage` listener, guarded by `__scoposContent`; top frame only (manifest has no `all_frames`). The `startExplore` poll loop is bounded (30×100 ms).
- **Explorer concurrency:**
  - the `settle()` and `watchChanges()` MOs are always disconnected (≤1.8 s);
  - the watchdog timer is cleared;
  - `looping` and `gen` prevent parallel walks under start/stop spam, and stale `navWatch` timers are inert;
  - the state is capped at 1.5 MB.
- **Guard:** listeners are added once (`active` flag) and removed on `off()`. The page-world patch installs once (`__scoposGuard`) and costs one attribute read per patched call. There are no timers or observers.
- **Widget:**
  - `chat` is capped at 6 turns × 600 chars;
  - `ask()` aborts the previous request, and every `deadline` timer is cleared in `finally`;
  - playbooks are de-duplicated by id;
  - no window listeners;
  - re-entrant `ask()` costs one synchronous `scan()` per call (0.15–0.35 s here), but piles nothing up.
- **Recorder:** `recStart` stops the previous recorder, and listeners are removed on stop.
