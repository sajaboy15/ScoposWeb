# 05 · Audit of the core: scan.js, pointer.js, guide.js, explore.js

Scope: every line of `extension/core/scan.js`, `pointer.js`, `guide.js` and `explore.js`, read against README.md,
with `content.js`, `background.js` and `manifest.json` used for context. No source files were changed.

**Verified in a real browser.** I ran a test page that loads the three core files:

- (a) A `scroll` listener on `window` with `capture: true` **does** receive scrolls of nested light-DOM scrollers. It does **not** receive scrolls of a scroller inside an open shadow root.
- (b) `resolve({text:'Открыть счёт и пригласить'})` returned the unrelated button «Открыть».
- (c) After `pointer.hide()`, the invisible card still swallowed a real click on a page button under it.
- (d) While the page had a `<dialog>` open via `showModal()` (the demo uses the same pattern), the card's «Далее» button was inert. Clicks went to the DIALOG.
- (e) `norm('Счет') !== norm('Счёт')`.
- (f) The DANGER and FOREIGN_ID regexes were run against the sample lists below.

Severity: **High** means the guide is wrong or broken in common cases, or the explorer can change or destroy data or leave the site. **Medium** means it is wrong in plausible cases or wastes a lot of resources. **Low** covers polish and edge cases.

---

## A. Pointer / frame / card position (pointer.js)

### A1. HIGH: the hidden card still blocks clicks on the page (verified)
`pointer.js:46-51` (`.card { pointer-events:auto; opacity:0 }`) and `:197-205` (`hide()` only removes `.on`).
`opacity:0` does not turn off hit-testing. After a guide ends, is closed, or the explorer finishes, a transparent box about 320×140 px stays where the card last was. It eats every click there. By default that is the bottom-right corner, where chat widgets, "Save" bars and FABs usually sit. It can also be next to the last target. The host also stays an open popover in the top layer forever.
**Fix:**
```css
.card { visibility:hidden; pointer-events:none;
  transition: opacity .22s ease, transform .38s cubic-bezier(.22,.9,.24,1), visibility 0s linear .22s; }
.card.on { visibility:visible; pointer-events:auto; transition-delay:0s; }
```
```js
function hide() { …; if (host && host.matches && host.matches(':popover-open')) try { host.hidePopover(); } catch (e) {} }
```

### A2. HIGH: the card cannot be clicked while the site has a modal `<dialog>` open (verified)
`pointer.js:92-94, 138-141`. `showModal()` makes everything outside the dialog inert, and that includes a top-layer popover. The popover is drawn above the dialog, but hit-testing skips it: `elementFromPoint` on «Далее» returned `DIALOG`. In the demo's «Пригласить коллегу» dialog the user cannot press Далее, Назад or ×, and in explore mode cannot press «Остановить».
**Fix:** when a modal dialog is open, re-parent the host into it. In `raise()`:
```js
const modal = [...document.querySelectorAll('dialog')].reverse().find(d => d.matches(':modal'));
const parent = modal || document.documentElement;
if (host.parentNode !== parent) parent.appendChild(host);   // then hide/show popover as now
```
Also call `raise()` from `schedule()` when `document.querySelector('dialog:modal')` changes. Track this with a `toggle`/`close` listener or a cheap check in the rAF loop from A3.

### A3. HIGH: position is not tracked when the target moves without scrolling or resizing
`pointer.js:105-106, 156, 170-195`. Updates only happen on `scroll`, `resize` and a ResizeObserver on the target's own size. Nothing fires when:
- a menu, drawer or modal animates in with `transform`. guide.js calls `point()` 260 ms after the click, so it measures mid-animation, typically 8–20 px off, and the frame stays there.
- content above the target loads (table data, images, a banner, a validation error) and pushes it down.
- a sidebar collapses or a sticky header changes height.

That is the "frame drifting" users see.
**Fix:** while a target is shown, run one rAF loop that reads only the rect and writes only when it changed. One `getBoundingClientRect` per frame is cheap. In lite mode, drop to about 10 Hz.
```js
let last = '';
function track() {
  if (!current || !target) return;
  const r = target.getBoundingClientRect(), k = `${r.left|0},${r.top|0},${r.width|0},${r.height|0}`;
  if (k !== last) { last = k; place(false); }
  raf = requestAnimationFrame(track);
}
```
Stop the loop in `hide()` and on `visibilitychange` to hidden. The scroll and resize listeners then become optional.

### A4. HIGH: the frame and card lag behind during scrolling, and the frame "lands" before smooth scroll ends
`pointer.js:43, 50, 155, 162, 180-183`.
- The `.snap` class only turns off the cursor transition. `.frame` (transform .3 s) and `.card` (.38 s) animate on every scroll-driven `place(false)`, so they trail the target by about 300 ms while scrolling.
- `point()` calls `scrollIntoView({behavior:'smooth'})` and then immediately runs `place(true)` with the pre-scroll rect. The first scroll event adds `snap` and kills the arc flight, so the flight is never seen when a scroll was needed.
- `landedTimer` shows the frame at 600 ms, even when a long smooth scroll takes ~1 s.

**Fix:** put snap on the layer, `.layer.snap .frame, .layer.snap .card, .layer.snap .cursor, .layer.snap .cy { transition: opacity .22s ease; }`, and toggle it on `layer` in `place(false)`. Wait for the scroll to finish before flying:
```js
async function settleScroll() {
  if ('onscrollend' in window) await new Promise(r => { const t = setTimeout(r, 900); addEventListener('scrollend', () => { clearTimeout(t); r(); }, { once: true, capture: true }); });
  else { let prev; for (let i = 0; i < 20; i++) { await new Promise(requestAnimationFrame); const y = target.getBoundingClientRect().top; if (y === prev) break; prev = y; } }
}
```
Then call `place(true)` and start `landedTimer`. Guard it with a token (`const token = ++pointSeq`) so an older `point()` cannot land after a newer one.

### A5. HIGH: scrolls inside shadow roots and iframes are invisible (verified for shadow)
`pointer.js:105`. A capture listener on `window` does see element scrolls in the light DOM. `scroll` is not `composed`, though, so scrollers inside shadow DOM (Lightning, Shoelace, Ionic, Polymer, many design systems) never reach it, and neither do same-origin iframes. `visualViewport` scroll and resize are not handled either: pinch-zoom and the mobile keyboard shift the visible area without a window resize (this matters for the SDK).
**Fix:** the rAF tracking in A3 makes this moot. If you keep the listeners, also add `visualViewport.addEventListener('resize'|'scroll', schedule)`, and clamp the card to `visualViewport.offsetLeft/offsetTop/width/height` instead of `innerWidth/innerHeight`.

### A6. MEDIUM: targets clipped by overflow, offscreen sideways, or in sticky headers
`pointer.js:154-155`.
- Only vertical overflow is checked. A target in a wide table, a horizontal tab strip or a kanban board stays off-screen.
- A target scrolled out of a nested scroller can still have a rect inside the viewport. No scroll happens, and the frame is drawn over unrelated content, because the target is clipped by `overflow:hidden/auto`.
- The `r.top < 60` heuristic re-centres in-view elements and can jump the page.
- `scrollIntoView` on a `position:sticky` header button scrolls the page back to the header's static position.

**Fix:**
```js
function clipRect(el) { let r = el.getBoundingClientRect(), L = r.left, T = r.top, R = r.right, B = r.bottom;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p); if (cs.position === 'fixed') break;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const q = p.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); } }
  return { L, T, R, B, clipped: R - L < r.width * .6 || B - T < r.height * .6 }; }
const c = clipRect(target);
const off = c.clipped || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
if (off && !isStickyOrFixed(target)) target.scrollIntoView({ block: 'center', inline: 'center', behavior });
```
Draw the frame on the clipped rect.

### A7. MEDIUM: the card covers the target or the dropdown it opens
`pointer.js:188-194`. When the card fits neither below nor above (a tall textarea or panel, or a short viewport), line 191 places it overlapping the target. For select, combobox and menu-button targets the card sits exactly where the option list opens. Horizontal position always aligns to `r.left`, which is also wrong in RTL.
**Fix:** try, in order: below, above, right (`r.right+14`), left (`r.left-cw-14`), and only then the viewport corner farthest from the target. For `role in {combobox, select, button[aria-haspopup]}`, try above first. When the target gets `aria-expanded="true"`, set `card.style.opacity = .35; card.style.pointerEvents = 'none'` until it collapses. For RTL (`getComputedStyle(target).direction === 'rtl'`), align the card to `r.right - cw` and put the ring on `r.left + 2`. Set `direction:ltr` (or the UI locale's direction) on `.layer`, because `all: initial` does not reset the inherited `direction`.

### A8. MEDIUM: CSS `zoom` on html or body, and the host being mounted under `<body>`
`pointer.js:104`. The host is a child of `body`, so it inherits an effective `zoom` from body or html. Some dashboards set `body{zoom:.9}`. The `getBoundingClientRect` coordinates of the target are in viewport space, but the layer is drawn zoomed, so everything is off by the zoom factor. The top layer cancels transforms but not inherited zoom. Behaviour also differs between Chrome before and after 128, and the manifest allows 116. Separately, frameworks that wipe `body` children remove the host until the next `point()`.
**Fix:** append to `document.documentElement` (and with A2, to the open modal). Measure `const z = host.getBoundingClientRect().width / host.offsetWidth || 1` once per `place()` and divide all written coordinates by `z`. In `place()`, if `!host.isConnected`, call `mount(); raise();`.

### A9. LOW: when the target is detached, the frame and cursor stay behind
`pointer.js:172-176`. Only the card is parked. The frame stays outlined over empty space or over the replacement element until guide.js re-resolves (≥300 ms). **Fix:** in that branch also `frame.classList.remove('on'); cursor.classList.remove('on','landed');`.

### A10. LOW: smaller pointer issues
- Every `point()` calls `hidePopover()` and then `showPopover()`. This is fine, but clicking our card light-dismisses a site's open `popover="auto"` menu, which can be the very menu the step needs.
- Six permanent `will-change` layers, even while hidden. Set `will-change` only while `.on` is present.
- `cursor.querySelector('.cy')` runs on every frame. Cache it.

---

## B. Finding the element (scan.js `resolve`, `describe`, `visible`)

### B1. HIGH: fuzzy matching returns a wrong element instead of null, so wait and self-heal never run (verified)
`scan.js:214-218`. `want.includes(have)` or `want.startsWith(have)` with no length floor means any short label inside the wanted text scores 1. Examples: «Открыть», «Да», «1», «+», initials, pagination digits. `resolve({text:'Открыть счёт и пригласить'})` returned the «Открыть» button. Because `show()` received a non-null element, the guide points at the wrong control, auto-advances when it is clicked, and never enters `wait()` / `onMissing` (the self-heal path).
**Fix:** score by token overlap and require minimum similarity:
```js
const toks = s => s.split(' ').filter(w => w.length > 1);
function sim(have, want) {
  if (have === want) return 3;
  const a = toks(have), b = toks(want); if (!a.length || !b.length) return 0;
  const inter = a.filter(w => b.some(x => x === w || (Math.min(x.length, w.length) >= 4 && (x.startsWith(w.slice(0, -1)) || w.startsWith(x.slice(0, -1)))))).length;
  const ratio = inter / Math.max(a.length, b.length);
  return ratio >= .99 ? 2 : ratio >= .6 && Math.min(have.length, want.length) >= 4 ? 1 : 0;
}
```
The stem match `slice(0,-1)` handles Russian endings such as «Счета» vs «Счёт» after the ё fix in B2.

### B2. HIGH: `norm()` does not fold ё/е, invisible characters or counters (verified)
`scan.js:196`. The model and users often write «Счет» when the UI says «Счёт», and the two never match. NBSP is handled by `\s`, but soft hyphen `­`, zero-width characters and different dashes are not. Badge counters break matches on every new message: «Входящие (12)» becomes «входящие 12», which no longer matches «входящие 13».
**Fix:**
```js
const norm = s => clean(s).toLowerCase().replace(/ё/g, 'е').replace(/[­​-‍⁠﻿]/g, '')
  .replace(/[‐-―−]/g, '-').replace(/[«»"'“”„.,:;!?()[\]{}]/g, '').replace(/\s*\d+\s*$/, '').trim();
```
Strip the trailing number only for the fuzzy pass, not the exact pass.

### B3. HIGH: shadow DOM and iframes are not supported at all
- `scan.js:128, 159, 203, 210` use `document.querySelectorAll`, which does not pierce shadow roots.
- `manifest.json` has no `all_frames`.
- guide.js `MutationObserver`s watch only `document.body`.

Apps built on web components (Salesforce LWC, SAP UI5 Web Components, Ionic, Shoelace and similar) and apps whose main UI lives in an iframe (many CRMs and legacy admin panels) produce an empty map. Steps wait forever, then heal against a map that also lacks the element.
**Fix:** add a deep query helper and use it everywhere `CONTROL` is queried:
```js
function* deepAll(rootNode, sel) {
  for (const el of rootNode.querySelectorAll(sel)) yield el;
  for (const h of rootNode.querySelectorAll('*')) {
    const sr = h.shadowRoot || (globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(h));
    if (sr) yield* deepAll(sr, sel);
    if (h.tagName === 'IFRAME') try { if (h.contentDocument) yield* deepAll(h.contentDocument, sel); } catch (e) {}
  }
}
```
Cache the list of hosts and iframes per scan, because `querySelectorAll('*')` is expensive. Record the host chain in `describe()` (`hosts: [cssPath(host)…]`), and in `resolve()` walk into `host.shadowRoot` before applying `sel`. For iframe targets, the pointer must add `iframe.getBoundingClientRect()` plus `clientLeft/clientTop`. Add `"all_frames": true` to the manifest, or offset the coordinates as described.

### B4. MEDIUM: `visible()` accepts hidden duplicates, so resolve picks the off-canvas or behind-modal copy
`scan.js:41-46`. Only the element's own `opacity` is checked. These all pass as "visible":
- a mobile drawer moved off-screen with `transform: translateX(-100%)`
- a menu hidden by `opacity:0` on its container
- an accordion collapsed with `max-height:0; overflow:hidden`
- content under `inert` or `aria-hidden="true"`
- the page behind an open modal

Because resolve takes the first element in DOM order, a hidden mobile-nav «Счета» that precedes the desktop sidebar wins, and the pointer flies to x=-250.
**Fix:**
```js
function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.right <= 0 || r.bottom <= -scrollY || r.left >= document.documentElement.scrollWidth) return false;
  if (el.closest('[inert],[aria-hidden="true"]')) return false;
  if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
  const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
}
```
In `resolve()`, break score ties by preferring, in order:
1. elements inside the topmost open dialog (`dialog:modal`, `[aria-modal=true]`);
2. elements whose centre passes `document.elementFromPoint` (after a `clipRect` check);
3. the same `section` as the descriptor (store `section` in `describe()`);
4. elements in the viewport.

### B5. MEDIUM: `resolve()` ignores `d.path`, so a step for another page matches a look-alike here
`scan.js:193, 199-218`. When the user is still on `/clients` and step 3 targets «Создать» on `/invoices`, the text fallback finds `/clients`' «Создать». The guide then points at it and advances when it is clicked. Learned guides depend on this fallback heavily, because their descriptors come from the explorer.
**Fix:** in `resolve`, `const samePage = !d.path || pathKey(d.path) === pathKey(location.pathname + location.hash);`. If `!samePage`, accept only an exact selector hit whose name matches exactly, and return `null` otherwise so `wait()` shows "Ищу этот элемент". `pathKey` should template ids (see E7).

### B6. MEDIUM: selectors that look unique but are not stable; empty-name hits accepted blindly
`scan.js:175, 189, 204`.
- The id filter `/\d{3,}|[:.]/` lets generated ids through, such as `headlessui-menu-button-5`, `mui-7`, `rc-tabs-0-tab-1`, `downshift-0-toggle-button`, `react-select-2-input`. These are reassigned on every mount, so the selector hits a different button.
- `cssPath` with `:nth-of-type` inside list rows (`tr:nth-of-type(3) > td:nth-of-type(5) > button`) points at another row after sorting, and the text check passes because every row says «Изменить».
- Line 204 accepts a single hit whenever its name is empty (`!name(hits[0])`), so icon-only targets are taken with no check at all.
- The text check compares only the first 12 characters (`slice(0,12)`), so «Создать счёт» matches «Создать счёт-фактуру».

**Fix:**
- id filter: `/\d{2,}|[:.]|^(mui|headlessui|radix|rc-|react-select|downshift|ember|ext-gen|yui_|j_id|ng-|cdk-|mat-)/i`
- Drop `nth-of-type` parts at levels with more than 3 same-tag siblings (rows). Instead anchor on the nearest stable ancestor (`[data-testid]`, a stable `#id`, `[role=dialog][aria-label]`) and use the descriptor text.
- Require `norm(name(hit)) === norm(d.text)`, or `sim() >= 2` from B1, unless the selector came from `data-testid/data-test/data-cy/data-qa`.
- With an empty name, accept only test-id or stable-id selectors, never `cssPath`.

### B7. MEDIUM: `redundant()` drops real controls
`scan.js:120-123`. Any non-native control that contains `input` is skipped, and that includes **hidden** inputs. MUI Select, react-select, Ant Select and Headless UI Listbox render `div[role=combobox|button]` with a hidden or `opacity:0` input inside. The wrapper is dropped, and the input then fails `visible()`, so the select disappears from the map entirely. Tabs and chips with a close «×» button, and `[role=option]` rows with action buttons, are also dropped. Only the «×» survives.
**Fix:**
```js
function redundant(el) {
  if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return false;
  if (/^(combobox|tab|option|treeitem|menuitem|switch|checkbox|radio)$/.test(el.getAttribute('role') || '')) return false;
  const inner = [...el.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea')].filter(visible);
  return inner.length === 1 && norm(name(inner[0])) === norm(name(el));
}
```

### B8. MEDIUM: `label[for]` is listed next to its input; resolve picks the label, and type steps never advance
`scan.js:16, 210-216`. Both «Email» the label and «Email» the textbox score 3, and the label comes first in DOM order. For `action:'type'`, `arm()` listens for `change` inside the label. A change on the input is not inside a `for=`-associated label, so the step never auto-advances.
**Fix:** in `resolve` and `scan`, map `if (el.tagName === 'LABEL' && el.control) el = el.control;` and dedupe with a `Set`.

### B9. MEDIUM: `section()` returns the element's own aria-label
`scan.js:95`. `closest()` includes the element itself, so every control with an `aria-label` becomes its own section (`button "Удалить" · Удалить`). This adds noise to the model's map and to descriptors. **Fix:** `const box = el.parentElement && el.parentElement.closest(…)`.

### B10. MEDIUM: privacy leaks in descriptors and maps, despite the README's promise
- `scan.js:113`: `selected "…"` is the user's chosen value, for example a customer name.
- `scan.js:87`: `[role=combobox]` and non-editable `[role=textbox]` divs fall through to `innerText`, which is the current value the user typed or picked.
- `scan.js:166`: select `options` can list customers or emails.
- `scan.js:191`: `aria-label` selectors often embed record data («Открыть счёт ООО Ромашка»).
- `scan.js:193`: `path` includes `location.hash`. OAuth implicit flow puts `#access_token=…` there, and some apps put `#/customers/<email>`.
- `explore.js:102, 176`: `url: location.href` keeps the query string (`?token=`, `?email=`) and sends it to Claude and into playbooks that get exported to vendors.

**Fix:**
- For `role in {combobox, textbox}`, never use `innerText`. Use the label, placeholder or aria-label only.
- Keep `selected` and `options` only when the select has fewer than 30 options and none match `/@|\d{4,}/`. Otherwise use `selected` without the text.
- `path: location.pathname.replace(/\/[0-9a-f-]{6,}|\/\d+/gi, '/:id') + (location.hash.startsWith('#/') ? location.hash.split('?')[0] : '')`
- `url: origin + pathname` with an allow-list of query params.
- Drop the `aria-label` selector when it contains digits or `@`.

### B11. MEDIUM: cost of `scan`, `inventory` and `resolve` on big pages and weak hardware
`scan.js:128-134, 159-161, 210-216, 28-37, 87`.
- `scan()` runs `visible()` (rect plus `getComputedStyle`) on **all** controls before applying the 260 cap.
- The sort comparator calls `getBoundingClientRect` O(n log n) times.
- `foreign()` walks every ancestor and calls `getComputedStyle` on the same top-level node once per control.
- `name()` calls `innerText` on `[tabindex]` containers. A focusable grid or region serialises its whole subtree with layout.
- `resolve()` does all of this for every control, and `wait()` calls it every 250 ms (C1).

**Fix:**
- Compute the foreign top-level nodes once per call: `const foreignTop = new Set([...document.body.children].filter(n => …))`, then `isOurs = el => el.closest('[data-scopos-ui]') || foreignTop.has(topOf(el))`.
- Precompute rects into a `Map` before sorting.
- In `resolve`, pre-filter cheaply before any style read: `const first = want.split(' ')[0]; if (!(el.textContent + ' ' + (el.getAttribute('aria-label')||'') + ' ' + (el.getAttribute('placeholder')||'')).toLowerCase().replace(/ё/g,'е').includes(first)) continue;`.
- In `name()`, use `textContent` capped at 200 characters for non-native roles (`el.textContent.slice(0, 200)`) and use `innerText` only for `BUTTON`/`A`.

### B12. LOW: FOREIGN_ID false positives hide the product's own UI (verified)
`scan.js:27`. The prefix has no delimiter, so `lp-hero`, `lp-main` (the landing-page convention), `gr-grid`, `honeycomb`, `loom-player`, `sidereal` and `claude-docs` all match. `foreign()` walks ancestors, so the whole subtree under `#lp-main` vanishes. The `position:fixed && zIndex >= 2147480000` rule also hides sites' own max-z modal or toast roots.
**Fix:** `/^(claude-ext|grammarly|lastpass|onepassword|com-1password|bitwarden|dashlane|honey-|loom-companion|darkreader|monica-|merlin-|sider-|maxai)(?:$|[-_])/i`. Drop `gr-`, `lp-` and `1p-`. Apply the z-index rule only to elements that are custom elements (`tagName` contains `-`) or have a shadow root.

### B13. LOW: other scan issues
- `CONTROL` misses `contenteditable="plaintext-only"` and React click-divs (no `onclick` attribute).
- `state()` does not report `aria-checked` or `aria-pressed` (switches).
- `snapshot` holds strong references to detached DOM until the next scan.

---

## C. Guide runner (guide.js)

### C1. HIGH (performance): `wait()` runs a full `resolve()` up to 4×/s, forever
`guide.js:107-108`. The observer watches `childList` plus `class` and `style` attributes on the whole body. Live dashboards, spinners, carousels, clocks and JS animations write `style` every frame, so the 250 ms throttle fires continuously, and each tick is a full B11-cost `resolve()`. Nothing ever times out. On 4-core laptops this is constant jank for as long as a step waits (README: "MutationObserver lives only while the guide waits").
**Fix:**
- Drop `style` from `attributeFilter`.
- In the callback, first check that something relevant changed: `muts.some(m => m.type === 'attributes' || [...m.addedNodes].some(n => n.nodeType === 1))`.
- Use `requestIdleCallback(tryFind, {timeout: 500})`.
- Back off: 250 ms → 500 → 1000 → 2000 after each miss.
- After 60 s, disconnect and show "Не нашёл элемент" with a «Далее» button.

### C2. MEDIUM: auto-advance misses or fires wrongly
`guide.js:81-87`.
- **Enter in a `<textarea>` or rich editor** advances mid-typing (`onKey`). Contenteditable and `role=textbox` editors never fire `change`, so they never advance.
- **Custom selects** (`action:'select'` on a `div[role=combobox]`) never fire `change`, so they never advance.
- **Radix/Headless items that select on `pointerup`** unmount before `click`, so the click lands on whatever is underneath and is not "inside".
- **Keyboard activation** of `div[role=button]`: the site handles `keydown` Enter or Space without dispatching `click`.
- **Document-level capture listeners** run after the site's `window` capture listeners and after earlier `document` capture listeners that call `stopImmediatePropagation`. Outside-click handlers often do this.
- **`action:'select'`** advances even when the wrong option is chosen.

**Fix:**
```js
const T = el.tagName, editor = T === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox';
let pressedInside = false;
const onDown = e => { pressedInside = inside(e); };
const onUp = e => { if (pressedInside && (step.action === 'click' || step.action === 'look')) setTimeout(() => advance(260), 120); };   // advance() is idempotent via at
const onKey = e => {
  if (!inside(e)) return;
  if (step.action === 'type' && e.key === 'Enter' && !editor) advance(120);
  if (step.action === 'click' && (e.key === 'Enter' || e.key === ' ') && !/^(BUTTON|A|INPUT|SUMMARY)$/.test(T)) advance(260);
};
const onInput = debounce(e => { if (inside(e) && step.action === 'type' && editor) advance(0); }, 900);
const onBlur = e => { if (inside(e) && step.action === 'type' && (el.value || el.textContent).trim()) advance(0); };   // 'focusout'
// select on custom widgets: advance when aria-expanded goes true→false and the visible text changed
```
Register all of these on `window` with `{capture:true}`: `pointerdown`, `pointerup`, `click`, `change`, `input`, `focusout`, `keydown`. For `select`, compare the option text with `step.value` (via `norm`) when `step.value` is set.

### C3. MEDIUM: clicks are lost during a re-render, and a fresh copy of the target is never accepted
`guide.js:81, 89`. `inside` uses the identity of the old `el`. When a list refresh or React keyed re-render swaps the node, clicks on the new copy are ignored for up to 300 ms (the throttle), and also afterwards if `show()` resolves to a different duplicate.
**Fix:** also accept the click when `e.target.closest(CONTROL)` matches the descriptor (`norm(name) === norm(step.target.text)` and the same role), or when `e.clientX/Y` falls inside the frame's last rect.

### C4. MEDIUM: timers check `run.index` but not which run it is
`guide.js:75, 79, 103, 113-116`. If a guide is restarted, a `guide:start` arrives from the background, or the user picks another guide, the pending `setTimeout(go(next))` or a resolving `onMissing` from the old run can act on the new run when the indexes happen to match. That skips a step, or overwrites `step.target` and calls `show()`.
**Fix:** `const me = run;` at the top of `arm`, `wait` and `advance`, and test `run === me && run.index === at` everywhere.

### C5. LOW: smaller guide issues
- `start([])` gives `steps[0]` undefined, and `show()` throws a TypeError (`guide.js:24, 53`). **Fix:** `if (!steps.length) return;`.
- `arm()` and `wait()` call `mo.observe(document.body)`. With a null body (frameset or very early load) this throws. Use `document.documentElement`.
- «Назад» to a step that was on the previous page waits forever. When `d.path` differs, show "Вернитесь на страницу …" with a link.
- A click that opens a new tab (`target=_blank`, Ctrl-click) advances in the old tab, but the new tab has no session.
- The recorder records clicked labels, which contain row or customer data. Apply the B10 rules in `recStart`.

---

## D. Explorer safety (explore.js)

### D1. HIGH: links are followed with no safety check, including logout, delete and export, other origins via redirect, and settings changes
`explore.js:145, 60-67, 123`. Every same-origin `<a href>` is queued and visited with `location.href = url`. DANGER is never applied to links: `pressable()` returns `false` for `A` before DANGER matters, and line 145 queues all of them. Examples:
- `/logout`, `/users/sign_out` (GET logout is common) log the user out and break the run.
- `/invoices/5/delete`, `/notifications/read_all` and `/unsubscribe?t=…` change data.
- `/export.csv` without a `download` attribute triggers a download, and the explorer stalls (D7).
- `/switch?org=2`, `/locale/en` and `?theme=dark` change persistent settings.
- `/impersonate/…` acts as another user.

**Fix:**
```js
const BAD_HREF = /log-?out|sign[-_]?out|exit|delete|destroy|remove|unsubscribe|revoke|impersonat|switch|locale|lang=|theme=|export|download|\.(csv|xlsx?|pdf|zip|json|xml|png|jpe?g|docx?)(\?|$)|\/api\//i;
function linkTarget(el) { …; if (DANGER.test(textOf(el)) || BAD_HREF.test(u.pathname + u.search)
  || el.hasAttribute('data-method') || el.hasAttribute('data-turbo-method') || el.target === '_blank') return null; … }
```

### D2. HIGH: DANGER is tested only on the accessible name, misses most risky verbs, and toggles slip through (verified)
`explore.js:21, 71`. `name()` returns `aria-labelledby` or `aria-label` **before** visible text. A button with `aria-label="Действие"` (or an English label such as «More») whose visible text is «Удалить» passes. Icon-only «Trash», «Корзина» and «Bin» pass. Verified **not caught**:
- Duplicate / Дублировать / Копировать, Mark as paid, «Провести», «Выставить счёт»
- Одобрить / Утвердить / Отклонить / Approve, «Убрать», Trash / Корзина, Включить / Выключить
- «Обновить тариф» / Upgrade, «Перевести», Refund / «Вернуть деньги», Void / Аннулировать
- Restore / Восстановить, «Закрыть период», Print / Печать (`window.print()` blocks the content script)
- «Подписать», Leave workspace / Покинуть, «Передать владение», «Отметить прочитанным», «Создать черновик»

Toggle buttons (`<button aria-pressed>`, `aria-checked` on `role=button`, class `toggle|switch`) count as role `button`, so they are pressed. The verified false positives cost coverage: «Payments», «Saved views», «Important», «Blocks», «Sender», «Счета на оплату» and «Настройки отправки» are all blocked.
**Fix:**
1. Test the union of all labels, not just the name:
   ```js
   const allText = el => [S.labelOf(el), el.innerText, el.getAttribute('aria-label'), el.title, el.value, el.id, el.className, ...[...el.attributes].filter(a => a.name.startsWith('data-')).map(a => a.value)].join(' ');
   ```
2. Use an **allow-list** model: press only when the text matches `^(new|create|add|открыть|новый|новая|создать|добавить|ещё|more|меню|menu|настройки|settings|фильтр|filter|details|подробнее|view|просмотр|…)` **or** when the control declares `aria-haspopup`, `aria-expanded`, `aria-controls` or `role=tab`. Treat everything else as unsafe by default.
3. Extend DANGER with word starts so it stops matching inside words: `\b(pay|send|save|apply|import|block)\b` for the English verbs, and add `дублир|копир|провест|провод|выстав|одобр|утверд|отклон|убрать|корзин|включ|выключ|тариф|upgrade|downgrade|перевест|перевод|возврат|вернуть|refund|void|аннулир|сторн|восстанов|restore|закрыть|печат|print|подпис|sign\b|покинуть|leave|передать|transfer|отмет|mark|approve|reject|decline|accept|resend|retry|run|запуст|deploy|start|stop|pause|enable|activate|duplicate|clone|copy|trash|bin|discard|revert|merge|move|перемест`.
4. Skip `[aria-pressed]`, `[aria-checked]`, `.btn-danger`, and `[class*=destruct]`/`[class*=danger]`.

### D3. HIGH: the explorer clicks whatever fuzzy `resolve()` returns, with no safety re-check
`explore.js:161-171`. Selectors (`nth-of-type`) often fail after a reload. The text fallback then returns a partial match (B1). For control «Настройки» it can return «Удалить настройки» or «Сбросить настройки» (`have.includes(want)`), and `el.click()` runs on it without DANGER or `pressable` being checked again.
**Fix:**
```js
const el = S.resolve(c.d);
if (!el || norm(S.labelOf(el)) !== norm(c.name) || DANGER.test(allText(el)) || !pressable({ el, role: roleOf(el), name: S.labelOf(el), state: '' })) { c.probe = 'missing'; return; }
```

### D4. HIGH: closing a dialog can press «Отменить платёж», «Закрыть период» or «Cancel subscription»; an undismissable dialog leaves the explorer clicking behind it
`explore.js:56-57`. The close regex `закры|отмен|close|cancel` is a substring match against `aria-label || textContent`. If the dialog has an icon-only × with no label, the first match in DOM order can be «Отменить заказ» or «Закрыть счёт» (a destructive action). If nothing matches and Escape is ignored, `closeDialog` returns with the dialog still open. The loop continues, `inventory()` hides the dialog's controls, and `el.click()` (programmatic, so it bypasses the backdrop) presses controls behind the modal.
**Fix:**
```js
const CLOSE = /^(×|✕|✖|x|close|закрыть|cancel|отмена|отменить|dismiss|ок|ok|готово|done|назад|back)$/i;
const x = [...d.querySelectorAll('button,[role=button]')].find(b => { const t = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim(); return CLOSE.test(t) && !DANGER.test(allText(b)); })
  || d.querySelector('[aria-label*="close" i],[aria-label*="закры" i],[data-dismiss],[data-bs-dismiss]');
…
if (openDialogs().includes(d)) { st.probes++; await save(); location.reload(); return 'reload'; }   // caller must propagate
```

### D5. HIGH: no safety net for submit, confirm, print, or network writes
The explorer relies only on labels. JS `type=button` «Создать» buttons that POST immediately, one-click «Новый счёт» buttons that create a draft server-side, and site `confirm()` prompts («Удалить?», where the user may press OK) all get through.
**Fix:** during exploration, inject a MAIN-world guard with `chrome.scripting.executeScript({world:'MAIN'})` or a `world: "MAIN"` content script:
```js
const realFetch = fetch, realOpen = XMLHttpRequest.prototype.open, realSend = XMLHttpRequest.prototype.send;
window.confirm = () => false; window.alert = () => {}; window.prompt = () => null; window.print = () => {}; window.open = () => null;
window.fetch = (input, init = {}) => { const m = (init.method || (input && input.method) || 'GET').toUpperCase();
  if (!/^(GET|HEAD|OPTIONS)$/.test(m)) { dispatchEvent(new CustomEvent('scopos:blocked-write', { detail: String(input && input.url || input) })); return Promise.reject(new TypeError('blocked by Scopos explorer')); }
  return realFetch(input, init); };
XMLHttpRequest.prototype.open = function (m, ...a) { this.__m = String(m).toUpperCase(); return realOpen.call(this, m, ...a); };
XMLHttpRequest.prototype.send = function (b) { if (!/^(GET|HEAD|OPTIONS)$/.test(this.__m)) { this.abort(); return; } return realSend.call(this, b); };
navigator.sendBeacon = () => false;
document.addEventListener('submit', e => e.preventDefault(), true);
```
Allow-list GraphQL queries: POST bodies that start with `{"query":"query` or `{"operationName":…` with no `mutation`. Mark a control whose probe triggered `scopos:blocked-write` as `probe:'mutating'`, and show it in the map so the model knows that button changes data.

### D6. HIGH: the explorer leaves the site and can hijack the tab
`explore.js:176, 239-252, 99-106`.
- A probe click that redirects to another origin (OAuth «Подключить Google», Stripe Checkout behind «Upgrade», a help centre) unloads the page. `resume()` runs on the foreign origin and calls `addView(pageKey(), location.href)` with the **foreign URL**. The queue then visits and probes the external site.
- `resume()` never checks `st.origin`. If the user types another site into the same tab mid-run, the explorer loads its state and `goTo(v.url)` drags the user back to the original site, repeatedly, for up to 5 minutes.

**Fix:**
```js
// resume():
if (location.origin !== st.origin) {
  if (st.pending) { const v = st.views[st.pending.view], c = v && v.controls.find(x => x.ref === st.pending.ref); if (c) { c.probe = 'external'; c.to = undefined; } st.pending = null; await save(); history.length > 1 ? history.back() : (location.href = st.views[st.cur.key].url); return true; }
  return false; // user navigated away: leave the tab alone (or set status 'paused')
}
// addView(): if (new URL(url, location.href).origin !== st.origin) return null;
```

### D7. HIGH: a full-load redirect makes `goTo` reload in a loop for 5 minutes; downloads, PDFs and `beforeunload` stall the run forever
`explore.js:114-125, 140-141`. The redirect check (`pageKey() !== v.key`, line 141) only runs when `goTo` returned `true`, which happens only for same-document hash navigation. Example: `v.url = /reports` redirects to `/reports/overview` (or `/login`). Each load runs resume → loop → `goTo('/reports')`, the key differs, `location.href = '/reports'`, the redirect fires again, and the server is hammered until `LIMITS.ms`. A URL that serves a download (no navigation), a PDF (content scripts do not run in the PDF viewer), or a `beforeunload` prompt that the user cancels leaves `loop()` returned and the status stuck on `running`. The UI shows "exploring" forever.
**Fix:**
```js
// goTo(), before navigating:
st.nav = { key: pageKey(url), at: Date.now(), tries: ((st.nav && st.nav.key === pageKey(url)) ? st.nav.tries : 0) + 1 };
if (st.nav.tries > 2) { st.views[st.cur.key].redirected = true; st.cur = null; st.nav = null; await save(); return true; }  // caller re-checks key
await save(); location.href = url;
setTimeout(() => { if (st && st.nav && pageKey() !== st.nav.key) { st.views[st.cur.key].unreachable = true; st.cur = null; st.nav = null; loop(); } }, 8000); // watchdog
// resume(): if (st.nav) { if (pageKey() !== st.nav.key) { const v = st.views[st.cur.key]; v.redirectTo = pageKey(); addView(pageKey(), location.href); st.cur = null; } st.nav = null; }
```
Also skip hrefs with file extensions (D1).

### D8. MEDIUM: «Остановить» does not survive navigation; two loops can run at once
`explore.js:97, 128, 230-254`. `stopping` lives only in this document. If stop arrives while a navigation is pending (the loop has already returned), the state stays `running`, and the next page's `resume()` continues the walk. A second `explore:start`, a start during `resume()`, or a double click on «Изучить» starts a second `loop()`. Both share the global `st` and press controls concurrently.
**Fix:**
```js
let gen = 0;
async function loop(g) { while (!stopping && g === gen) { … } if (g === gen) await finish(…); }
function stop() { stopping = true; if (st) { st.status = 'stopped'; opts && opts.store.save(st); } }
async function start(o) { gen++; … return loop(gen); }
async function resume(o) { …; loop(++gen); }
```
Background `learn:stop` should also write `status:'stopped'` into `explore:<tab>`, so a reload cannot resume.

### D9. MEDIUM: `el.click()` does not open pointer-driven menus and bypasses hit-testing
`explore.js:171`. Radix DropdownMenu, Popover and Select triggers open on `pointerdown`, so `click()` alone yields `'nothing'` and the menus never get mapped. A programmatic click also reaches elements covered by overlays (see D4).
**Fix:**
```js
function press(el) {
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y); if (top && !el.contains(top) && !top.contains(el)) return false;   // covered
  const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.click(); return true;
}
```

### D10. MEDIUM: the view budget is consumed by record pages, in-page anchors and query-routed apps
`explore.js:28, 99-106, 145`.
- `/invoices/1` … `/invoices/40` are 40 distinct views, so a list page's row links exhaust `LIMITS.views` and nothing else gets explored.
- `#main-content` (skip link) and TOC anchors (`#section-2`) each become a "screen".
- Apps routed by query (`/index.php?page=invoices`, WordPress `admin.php?page=x`) collapse into a single key, because `pageKey` ignores `search`.
- BFS queues footer links such as `/terms` and `/blog` before the product's nav.

**Fix:**
```js
const pageKey = (u = location.href) => { const x = new URL(u, location.href);
  const path = x.pathname.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,})(?=\/|$)/gi, '/:id');
  const q = [...x.searchParams].filter(([k]) => /^(page|view|tab|section|module|route|p)$/i.test(k)).map(([k, v]) => `${k}=${v}`).join('&');
  const h = /^#[!/]/.test(x.hash) ? x.hash.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id') : '';
  return path + (q ? '?' + q : '') + h; };
```
Queue links from `nav`, `aside`, `header` and `[role=navigation]` first (a priority queue), and skip `footer` links.

### D11. MEDIUM: panel detection, the 400 cap, double-counted probes, and links in panels or dialogs never followed
- `explore.js:167, 193`: `inventory()` stops at 400. On a large page a menu portalled to the end of `<body>` falls past the cap, so `appeared` is empty and `probe='nothing'`, and the menu stays **open** for the following probes. **Fix:** diff with a `MutationObserver` that collects `addedNodes` during the click and `settle()`, then run `inventory(node)` on each added subtree. That is also cheaper than two full inventories per probe.
- Unrelated async changes (polling, toasts, lazy rows) also count as "appeared", so most probes on live pages end in a `location.reload()`. **Fix:** count only nodes added inside `el.getAttribute('aria-controls')`, in a new `[role=menu|listbox|tabpanel]`, or within 600 px of `el`.
- `explore.js:206` plus `:152`: a reload probe increments `st.probes` twice, halving the budget on menu-heavy apps. **Fix:** remove the `st.probes++` inside `probe()`.
- `explore.js:199` and `:91`: links inside opened panels, tabs and dialogs are set to `skip` and never queued, so pages reachable only through a menu are missed. **Fix:** for `x` in `appeared`, `const href = linkTarget(x.el); if (href) addView(pageKey(href), href)`.
- `explore.js:179`: `goTo(v.url)` returns `false` for a full load, but `probe` returns `undefined`. The loop keeps running during unload and calls `goTo` a second time. **Fix:** `if (!(await goTo(v.url))) return 'reload';`.

### D12. MEDIUM: whole state saved after every probe; storage quota and size
`explore.js:108, 147, 153, 170` and background `explore:save`. Up to 40 views × 400 controls × about 500 bytes of descriptors comes to roughly 8 MB. That is structured-cloned over messaging up to about 3 times per probe (160 probes), on weak machines too. `chrome.storage.session` has a 10 MB quota. Past it, `set` throws and the save is silently dropped (the background handler has no catch), so after the next reload the explorer resumes from stale state and repeats work. The map sent to Claude is also enormous.
**Fix:** store each captured view once under its own key (`explore:<tab>:<viewId>`). Per probe, save only the small cursor (`{cur, queue, probes, pending, nav, status, probeResults}`). Trim descriptors: keep at most 2 selectors, and drop `cssPath` when a test-id or stable id exists. Cap `controls` per view at 150, prioritising nav, header and toolbar controls.

### D13. LOW: `settle()` never settles on animated pages
`explore.js:31-39`. It observes every attribute on the whole document, so spinners, clocks and carousels keep it at `max` (1.8 s) on every call. That costs at least 3 × 1.8 s per probe and burns the 5-minute budget in about 30 probes. **Fix:** `attributeFilter: ['class','hidden','open','aria-expanded','aria-hidden','aria-modal','role']`, and ignore mutations whose target has no element children and only `style` changes.

### D14. LOW: other explorer issues
- `closeDialog` calls `d.close()` on React-controlled `<dialog>`s, which desyncs React state.
- `openDialogs()` treats cookie banners (`role=dialog`) as dialogs.
- Dialog and panel keys use titles that may contain record names (privacy, B10).
- `addView` counts dialogs and panels against the 40-view budget. Give them a separate budget.
- `flash()` calls `scrollIntoView({behavior:'smooth'})` before every probe. Use `'auto'` in explore mode.

---

## E. Direct answers to the specific questions

| Question | Answer |
|---|---|
| Does `addEventListener('scroll', …, {capture:true})` on window catch element scrolls? | **Yes for light-DOM scrollers (verified). No** for scrollers inside shadow roots (verified), same-origin iframes, or `visualViewport` (pinch, mobile keyboard). It also never fires for non-scroll movement (A3). |
| CSS transforms on ancestors | `getBoundingClientRect` includes transforms, so a static target is measured correctly. *Animated* transforms are not tracked (A3). The top layer protects the layer from ancestor transforms, but not from inherited `zoom` (A8). |
| Sticky/fixed targets | Positioning works, but `scrollIntoView` on sticky elements can jump the page (A6), and the 0.3 s frame transition lags during scroll (A4). |
| Same-origin iframes / open shadow roots | Not found at all (B3). |
| Smooth scrolling | Measured before scrolling finishes. The flight is cancelled by the first scroll event, and the frame lands at 600 ms regardless (A4). |
| overflow:hidden clipping / covered targets | Not detected (A6, B4). |
| Detached and replaced target | guide.js re-resolves within 300 ms. Meanwhile the frame stays on the dead rect (A9) and clicks on the new node are ignored (C3). |
| Resize / page zoom | Resize is handled. Browser zoom is consistent (CSS px). CSS `zoom` on body is not (A8). |
| RTL | The card aligns to the left edge, the ring sits on the label start, and the card inherits `direction: rtl` (A7). |
| landedTimer races | Cleared correctly between `point()` calls. The real race is landing before scroll ends (A4), plus the guide's run-identity issue (C4). |
| Popover top layer | Above the site's modal visually, but **inert** (A2, verified). The hidden card remains clickable (A1, verified). Clicking the card light-dismisses a site's `popover=auto` (A10). |
| Partial matches like «Счета» vs «Счёт» | Today «Счет» never matches «Счёт», and short labels match anything (B1, B2). |
| MutationObserver cost | `arm()`'s observer is cheap (only `isConnected`). `wait()`'s observer is expensive (C1). |
| Listener leaks | guide and recorder clean up correctly. The pointer's window listeners are never removed, which is harmless because `schedule` returns early. The real leaks are the invisible open popover and card (A1) and `snapshot` keeping detached DOM (B13). |

---

## Top 15, ranked
1. **D1** `explore.js:145`: links are visited with no DANGER/href filter (GET logout, delete, export, org switch, locale).
2. **D2** `explore.js:21,71`: DANGER checks only the aria-name (a hidden «Удалить» behind an innocuous aria-label passes); dozens of risky verbs are missing; toggles are pressed.
3. **D3** `explore.js:161-171`: the explorer clicks a fuzzy-resolved element without re-checking safety.
4. **D5**: no submit, `confirm()` or network-write guard during exploration.
5. **D4** `explore.js:56`: the dialog-close regex can press «Отменить платёж» or «Закрыть период»; an unclosable dialog leads to clicks behind the modal.
6. **D6** `explore.js:239-252`: no origin check, so the explorer crawls OAuth or Stripe pages and hijacks a tab the user moved elsewhere.
7. **A1** `pointer.js:46,197`: the invisible card eats clicks after the guide ends (verified).
8. **A2** `pointer.js:92-140`: card buttons are inert while a site `<dialog>` is modal, including the demo's invite dialog (verified).
9. **B1** `scan.js:214`: fuzzy resolve returns wrong short-label elements instead of null, which bypasses wait and self-heal (verified).
10. **A3** `pointer.js:156,170`: no tracking of transform animations or layout shifts. This is the main cause of drift.
11. **D7** `explore.js:114-141`: a server redirect causes a 5-minute reload loop; downloads, PDFs and `beforeunload` stall the run forever.
12. **B2** `scan.js:196`: no ё/е folding (verified); counters break matches.
13. **A4** `pointer.js:43,50,155,162`: the frame and card lag 300 ms during scroll; the flight is killed by smooth scroll; the frame lands before the scroll ends.
14. **B3** `scan.js:128,159,210`: shadow DOM and iframes are unsupported; shadow scrolls are not caught (verified).
15. **C1** `guide.js:107`: `wait()` runs a full resolve up to 4×/s on style mutations, forever (weak-hardware jank).

Next tier: B4 (hidden duplicates), B5 (`d.path` ignored), B7 (MUI/react-select dropped), C2 (advance misses: Enter in textarea, custom selects, Radix `pointerup`), D8 (stop not persisted, concurrent loops), D10 (id-templating of routes), B10 (privacy leaks), D12 (state size).
