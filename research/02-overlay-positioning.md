# 02 — Keeping an overlay exactly on its target ("пометки съезжают")

Research date: 2026-10-16. Every claim below was checked in the library source at a pinned commit or in the cited docs/specs. Where something is an inference (not stated by a source), it is marked **[inference]**.

Pinned sources:

| Library | Repo @ commit |
|---|---|
| driver.js | `nilbuild/driver.js` (formerly `kamranahmedse/driver.js`, GitHub redirects) @ `ca44ea0` — `packages/driver/src/` |
| Floating UI | `floating-ui/floating-ui` @ `dc62df2` — `packages/dom/src/`, `packages/core/src/`, `packages/utils/src/` |
| Shepherd.js | `shipshapecode/shepherd` @ `cf36267` — `shepherd.js/src/` |
| intro.js | `usablica/intro.js` @ `5b12889` — `src/` |
| reactour | `elrumordelaluz/reactour` @ `f38832f` — `packages/` |
| Popper v2 | `@popperjs/core@2.11.8` (published `lib/` on unpkg; the popperjs repo now redirects to floating-ui) |

Link prefixes used below:
- DRV = `https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/`
- FUI = `https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/`
- SHP = `https://github.com/shipshapecode/shepherd/blob/cf36267bd034a4a457148f91a00a13c68435aca6/shepherd.js/src/`
- INT = `https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/`
- RT = `https://github.com/elrumordelaluz/reactour/blob/f38832ffd0b610e98dbed01d9dff6b058b1ec1a4/packages/`
- POP = `https://unpkg.com/@popperjs/core@2.11.8/lib/`

---

## 1. Per library: how it positions and keeps in sync

### 1.1 driver.js

**Positioning model.** One full-screen `position: fixed` SVG (`width/height: 100%`, `viewBox = 0 0 innerWidth innerHeight`) with a single `evenodd` path: the outer rectangle is the whole window, the inner rounded rectangle is the cutout around the target ([DRV overlay.ts#L113-L149](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/overlay.ts#L113-L149), [DRV stage.ts#L18-L40](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/stage.ts#L18-L40)). The cutout is the raw `getBoundingClientRect()` of the target plus `stagePadding`, with the radius limited to `min(radius, w/2, h/2)` to avoid glitches ([stage.ts#L25-L31]).

**Sync triggers.**
- Only `window` `resize` and `window` `scroll` (non-capture) ([DRV events.ts#L97-L101](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/events.ts#L97-L101)). Both call `requireRefresh`, which cancels the pending frame and schedules exactly one `requestAnimationFrame(refreshActiveHighlight)` ([events.ts#L5-L15]). `refreshActiveHighlight` re-reads the rect, resets the SVG `viewBox`, and repositions the popover ([DRV highlight.ts#L80-L91](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/highlight.ts#L80-L91)).
- No ResizeObserver, no IntersectionObserver, no listeners on nested scroll containers. To cover that, when highlighting it adds `driver-active-element-parent-no-scroll` (`overflow: hidden !important`) to the target's **direct parent** if that parent is scrollable ([highlight.ts#L193-L200], `driver.css` L43-46). That is, it **freezes** inner scrolling instead of tracking it.
- Public `driver.refresh()` → `requireRefresh` ([DRV driver.ts#L462](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/driver.ts#L462)), so the host app has to call it after layout changes.
- Missing elements: `waitForStepElement` re-resolves the selector on every DOM mutation (`MutationObserver` on `documentElement`, `childList+subtree+attributes`) with a timeout ([DRV driver.ts#L292-L316](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/driver.ts#L292-L316)). If no element is found, it highlights a 0×0 fixed "dummy" div at 50%/50% ([highlight.ts#L44-L64]).

**Animation.** `transferHighlight` runs a rAF loop for `duration` (400 ms by default). **Each frame it calls `to.getBoundingClientRect()` again** and eases from the last drawn stage position toward the **current** target rect ([DRV overlay.ts#L8-L28](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/overlay.ts#L8-L28), [highlight.ts#L132-L172]). So the destination is live: if the page scrolls during the flight, the animation still lands on the target. The last-call-wins guard is `if (transitionCallback !== animate) return` ([highlight.ts#L138-L140]). The popover is rendered halfway through the animation ([highlight.ts#L146-L149]).

**Scroll into view.** `bringInView` skips the scroll if the rect is already fully inside `innerWidth/innerHeight`, otherwise calls `scrollIntoView({block: center|start, inline: center})`. Smooth scrolling is **turned off** when the direct parent is scrollable, with the source comment "Removing the smooth scrolling for elements which exist inside the scrollable parent. This was causing the highlight to not properly render" ([DRV utils.ts#L45-L59](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/utils.ts#L45-L59)). There is no `scrollend` wait. The live-target rAF loop is what absorbs the scroll.

**Top layer.** `layerFor(element)` returns `element.closest("dialog[open]") ?? document.body`. The comment reads: "A modal `<dialog>` renders in the top layer … so UI for an element inside one has to live in that dialog to be visible" ([DRV utils.ts#L86-L90](https://github.com/nilbuild/driver.js/blob/ca44ea064a8a57ab4acb197e57c6f514d2df4da1/packages/driver/src/utils.ts#L86-L90)).

**Known gap (in source).** `renderOverlay` has `// TODO: cancel rendering if element is not visible` ([overlay.ts#L87]), so there is no clipping or occlusion handling.

### 1.2 Floating UI (`@floating-ui/dom`) — the reference implementation for "stay in sync"

**`autoUpdate(reference, floating, update, opts)`** ([FUI dom/src/autoUpdate.ts#L165-L264](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/dom/src/autoUpdate.ts#L165-L264)). Default options:
- `ancestorScroll: true` / `ancestorResize: true`: adds `scroll`/`resize` listeners **directly on every overflow ancestor** of both the reference and the floating element ([L181-L192]). The ancestor list comes from `getOverflowAncestors` ([FUI utils/src/dom.ts#L206-L231](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/utils/src/dom.ts#L206-L231)), which:
  - walks up with `getParentNode`. That function steps into `assignedSlot` and from a `ShadowRoot` to its `host`, so it **crosses shadow boundaries** ([dom.ts#L171-L187]);
  - treats `overflow` matching `auto|scroll|overlay|hidden|clip` (not `display: inline/contents`) as an overflow ancestor ([dom.ts#L64-L71]), so `hidden` and `clip` containers count too;
  - at the top, adds the `window`, **`window.visualViewport`**, and, if the document is inside an iframe, **recurses into `frameElement`'s ancestors in the parent document** ([dom.ts#L217-L224], `getFrameElement` [L233-L237]).
- `elementResize: true`: one `ResizeObserver` on the reference and the floating element. If the reference resized, the floating element is unobserved for one frame to avoid loops with the `size` middleware ([L202-L228]).
- `layoutShift: true`: `observeMove` ([L46-L155]), based on samthor.au/2021/observing-dom. It creates an `IntersectionObserver` whose `rootMargin` is the **negated current rect**, so the observed root is exactly the element's box, with `threshold` = the current ratio. Any movement changes the intersection ratio, which calls `onMove()` and rebuilds the observer. Important details:
  - It compares the entry's snapshot rect with a fresh `getBoundingClientRect()` and refreshes if they differ, because "the entry is a snapshot … stale" ([L92-L104]).
  - If the element is clipped in place (ratio 0), it throttles the retry to 1 s to avoid an infinite loop ([L111-L116]).
  - It uses `root: ownerDocument` so it works inside iframes, with a try/catch fallback ([L125-L135]).
  - On window resize it rebuilds the observer because the root size changed ([L140-L149]).
  - It catches movement with **no scroll or resize event**, such as content inserted above or an accordion opening.
- `animationFrame: false`: if enabled, it runs a rAF loop comparing `getBoundingClientRect` with the previous frame (`rectsAreEqual`) and calls `update()` only on change ([L230-L246]). When this option is on, the reference is **not** put in the ResizeObserver ([L221-L223]). Docs: use it "when the reference element is animating with transforms" ([floating-ui.com/docs/autoUpdate](https://floating-ui.com/docs/autoUpdate)). This matches the ResizeObserver spec: "Observations will not be triggered by CSS transforms" ([drafts.csswg.org/resize-observer](https://drafts.csswg.org/resize-observer/)).
- Docs: call `autoUpdate` only while the floating element is mounted, and call the cleanup on close, since otherwise it "can cause severe performance degradation".

**Measurement.** `getBoundingClientRect(el, includeScale, isFixedStrategy, offsetParent)` ([FUI dom/src/utils/getBoundingClientRect.ts#L16-L83](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/dom/src/utils/getBoundingClientRect.ts#L16-L83)):
- Optional scale division by `getScale(el)` = `rect.width / cssWidth` ([FUI dom/src/platform/getScale.ts#L9-L35](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/dom/src/platform/getScale.ts#L9-L35)). This detects ancestor `transform: scale()`, and 0/NaN/Infinity fall back to 1.
- **iframe walk** ([L55-L79]): while the element's window is not the offset parent's window, it multiplies x/y/w/h by the iframe's scale, then adds `iframeRect.left + (iframe.clientLeft + paddingLeft) * scale` (same for top), then moves up one frame. This adds the iframe's border and padding, not just its rect.
- `getVisualOffsets` adds `visualViewport.offsetLeft/offsetTop` **only in WebKit**, and only for `fixed` strategy against the window ([FUI dom/src/utils/getVisualOffsets.ts#L7-L30](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/dom/src/utils/getVisualOffsets.ts#L7-L30)).

**Clipping.** `getClippingRect` ([FUI dom/src/platform/getClippingRect.ts#L143-L193](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/dom/src/platform/getClippingRect.ts#L143-L193)) intersects the inner client rects (border-box minus scrollbars, via `clientTop/clientLeft/clientWidth/clientHeight`, [L34-L53]) of **all** clipping ancestors, plus the root boundary (the viewport by default). `getClippingElementAncestors` ([L87-L139]) prunes ancestors that do not actually clip:
- for a `position: fixed` element it starts at the parent and drops every ancestor up to the next **containing block**;
- for an `absolute` chain it drops `static` ancestors.

`isContainingBlock` = `transform/translate/scale/rotate/perspective` ≠ none, `filter`/`backdrop-filter` (not WebKit), `will-change` of those, or `contain: paint|layout|strict|content` ([FUI utils/src/dom.ts#L98-L117](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/utils/src/dom.ts#L98-L117)). If the element **is in the top layer** (`:popover-open` or `:modal`, [dom.ts#L77-L91]), it has no clipping ancestors ([getClippingRect.ts#L157-L162]).

**Viewport rect.** `getViewportRect` uses `visualViewport.width/height/offsetLeft/offsetTop` for the `'viewport'` boundary ([FUI dom/src/utils/getViewportRect.ts#L18-L91](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/dom/src/utils/getViewportRect.ts#L18-L91)), so placement and clamping respect pinch-zoom and the on-screen keyboard. It also corrects for `scrollbar-gutter: stable`.

**Hide.** The `hide()` middleware ([FUI core/src/middleware/hide.ts#L32-L77](https://github.com/floating-ui/floating-ui/blob/dc62df23d72ad96d456c007d48d4541786fcd7eb/packages/core/src/middleware/hide.ts#L32-L77)):
- `referenceHidden` is true when **any side is fully clipped**: `overflow[side] - rect.size >= 0` against the reference's clipping context.
- `escaped` is the same test for the floating element against the reference's clipping context.
- Docs: set `visibility: hidden` when `referenceHidden`, and put `hide()` at the end of the middleware list. "Hidden" means clipped only, so CSS `visibility`/`opacity` are not considered ([floating-ui.com/docs/hide](https://floating-ui.com/docs/hide)).

**Virtual elements.** Any `{ getBoundingClientRect(), contextElement? }` can be the reference. `contextElement` makes "clipping and position update detection work as expected" ([floating-ui.com/docs/virtual-elements](https://floating-ui.com/docs/virtual-elements)). `autoUpdate` unwraps it to find ancestors (`unwrapElement`).

**Shadow DOM note (docs).** `offsetParent` is hidden across shadow boundaries. The simplest fix is the `'fixed'` strategy, and "There is no method that works with closed shadow roots" for the offsetParent polyfill ([floating-ui.com/docs/platform](https://floating-ui.com/docs/platform)). Scopos already uses fixed positioning, so this does not apply.

### 1.3 Shepherd.js

**Tooltip.** `setupTooltip` calls `autoUpdate(target, step.el, () => computePosition(...))` with `strategy: 'absolute'`, `flip()` (or `autoPlacement`), `shift({ limiter: limitShift(), crossAxis: true })`, and `arrow()` forced to be the last middleware ([SHP utils/floating-ui.ts#L26-L61](https://github.com/shipshapecode/shepherd/blob/cf36267bd034a4a457148f91a00a13c68435aca6/shepherd.js/src/utils/floating-ui.ts#L26-L61), [L199-L278]). The comment at [L249-L257] explains that a middleware running after `arrow()` invalidates the arrow data. Centered steps use `position: fixed; left/top: 50%; translate(-50%,-50%)` ([L150-L165]).

**Modal overlay (cutout).** This is a **continuous rAF loop for as long as the step is shown**: `rafLoop` calls `positionModal(...)` and then `requestAnimationFrame(rafLoop)`, with no event triggers at all ([SHP components/shepherd-modal.ts#L228-L255](https://github.com/shipshapecode/shepherd/blob/cf36267bd034a4a457148f91a00a13c68435aca6/shepherd.js/src/components/shepherd-modal.ts#L228-L255)). Per frame:
- `_getVisibleHeight(el, scrollParents)` intersects the target's top/bottom with **every** clipping scroll parent's rect, nearest first ([L422-L438]). Only the y-axis is clipped; x/width use the raw rect ([L132-L133]).
- `_getScrollParents` ([L328-L358]) does the following, and the comments explain why:
  - `fixed` targets have no cropping ancestors;
  - for an `absolute` target, cropping starts only at its nearest positioned ancestor;
  - `<html>` never crops;
  - `<body>` does not crop when its overflow propagates to the viewport (issue #1984);
  - `display: inline|contents` never crops;
  - `hidden` and `clip` crop like `auto` ([L267-L305]).
  - "Clipping against the nearest alone is wrong as soon as scroll containers nest" ([L311-L314]).
- Scroll parents are memoized per step in a `WeakMap`, because each walk costs one `getComputedStyle` per ancestor ([L364-L383]).
- `_getIframeOffset` adds `frameElement.getBoundingClientRect()` (+ `scrollTop/Left`) for each frame **up to the overlay's own window only**. Going on to `window.top` "would also add the offsets of the frames hosting Shepherd itself, pushing the opening off the target (#3478)". Cross-origin access is wrapped in try/catch ([L385-L420]).
- During the step, `touchmove` on `window` is `preventDefault`-ed (`passive: false`) ([L204-L212]), which blocks touch scrolling.

**Element resolution.** `waitForAttachToElement` uses a `MutationObserver` (with a polling fallback) and re-evaluates function locators on each DOM change ([SHP utils/general.ts#L91-L150](https://github.com/shipshapecode/shepherd/blob/cf36267bd034a4a457148f91a00a13c68435aca6/shepherd.js/src/utils/general.ts#L91-L150)). Scrolling uses plain `element.scrollIntoView(options)` or a user `scrollToHandler` ([SHP step.ts#L699-L710](https://github.com/shipshapecode/shepherd/blob/cf36267bd034a4a457148f91a00a13c68435aca6/shepherd.js/src/step.ts#L699-L710)). There is no `scrollend` wait; the rAF loop absorbs the motion.

### 1.4 intro.js

**Positioning model.** This is the opposite of the others: the helper layer is **absolutely positioned in document coordinates**. `getOffset` returns `rect.top + window.scrollY` (or rect-relative-to-container for `relative`/`sticky` containers, or raw rect if any ancestor is `fixed` via `isFixed`) ([INT util/getOffset.ts#L24-L79](https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/util/getOffset.ts#L24-L79), [INT util/isFixed.ts#L8-L20](https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/util/isFixed.ts#L8-L20)). Because of this, window scrolling needs no update at all.
- The dim effect is a `box-shadow: … 0 0 0 5000px` on the helper box ([INT packages/tour/components/HelperLayer.ts#L54-L61](https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/packages/tour/components/HelperLayer.ts#L54-L61)).
- Position is written in a `setTimeout(…, 0)` ([INT packages/tour/position.ts#L14-L21](https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/packages/tour/position.ts#L14-L21)).

**Sync triggers.** Only `window` `resize` → `refresh()` ([INT packages/tour/tour.ts#L405-L417](https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/packages/tour/tour.ts#L405-L417)) and a manual `tour.refresh()`. Nested scroll containers are not tracked. Instead, `scrollParentToElement` sets `parent.scrollTop = target.offsetTop - parent.offsetTop` once ([INT util/scrollParentToElement.ts#L6-L17](https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/util/scrollParentToElement.ts#L6-L17)), and window scrolling uses `scrollBy` to center ([INT util/scrollTo.ts#L10-L50](https://github.com/usablica/intro.js/blob/5b12889b4b7f82bd935a5153af574869eeaab755/src/util/scrollTo.ts#L10-L50)). Scrolling an inner container afterwards makes the highlight drift. This is the classic drift case.

### 1.5 reactour (`@reactour/tour`)

**Sync triggers.**
- `useSizes` reads `getBoundingClientRect` on mount and on `window` `resize` ([RT tour/hooks.tsx#L27-L66](https://github.com/elrumordelaluz/reactour/blob/f38832ffd0b610e98dbed01d9dff6b058b1ec1a4/packages/tour/hooks.tsx#L27-L66)).
- Optional per-step `mutationObservables` / `resizeObservables`: a `MutationObserver` on `documentElement` (`childList, subtree`) refreshes when added or removed nodes match the selectors, and a `ResizeObserver` watches the matching nodes ([RT utils/Observables.tsx#L47-L84](https://github.com/elrumordelaluz/reactour/blob/f38832ffd0b610e98dbed01d9dff6b058b1ec1a4/packages/utils/Observables.tsx#L47-L84)).
- **There is no scroll listener** in `Tour.tsx` or `useSizes`.

**Smooth-scroll wait.** `smoothScroll(elem)` calls `scrollIntoView({behavior:'smooth'})`, then polls `elem.getBoundingClientRect().top` every rAF and resolves when it has been unchanged for more than 2 consecutive checks ([RT utils/smoothScroll.tsx#L2-L31](https://github.com/elrumordelaluz/reactour/blob/f38832ffd0b610e98dbed01d9dff6b058b1ec1a4/packages/utils/smoothScroll.tsx#L2-L31)). `useSizes` then sets a refresher, re-measures, and toggles a `transition` flag that switches the popover to an `onTransition` position while scrolling ([hooks.tsx#L68-L84], [RT tour/Tour.tsx#L125-L129](https://github.com/elrumordelaluz/reactour/blob/f38832ffd0b610e98dbed01d9dff6b058b1ec1a4/packages/tour/Tour.tsx#L125-L129)). This is a portable "scroll finished" fallback for browsers without `scrollend`.

### 1.6 Popper v2 (for comparison)

- `eventListeners` modifier: `scroll` listeners (passive) on **every scroll parent** of the reference and the popper, plus `window` `resize` ([POP modifiers/eventListeners.js#L7-L39](https://unpkg.com/@popperjs/core@2.11.8/lib/modifiers/eventListeners.js)). `listScrollParents` includes `window` and `window.visualViewport` at the top ([POP dom-utils/listScrollParents.js#L12-L26](https://unpkg.com/@popperjs/core@2.11.8/lib/dom-utils/listScrollParents.js)). There is no ResizeObserver or IntersectionObserver.
- `update` is **debounced to one microtask** (`Promise.resolve().then`), so many events in the same tick cause one layout read ([POP utils/debounce.js](https://unpkg.com/@popperjs/core@2.11.8/lib/utils/debounce.js), `createPopper.js` L138-139).
- `hide` modifier: `isReferenceHidden` / `hasPopperEscaped`, exposed as `data-popper-reference-hidden` / `data-popper-escaped` attributes ([POP modifiers/hide.js#L26-L52](https://unpkg.com/@popperjs/core@2.11.8/lib/modifiers/hide.js)).
- `computeStyles`: `roundOffsetsByDPR` rounds x/y to `round(v*dpr)/dpr` ("Zooming can change the DPR, but it seems to report a value that will cleanly divide…"), and with `gpuAcceleration` it writes `transform: translate()` (or `translate3d` when DPR > 1) instead of top/left ([POP modifiers/computeStyles.js#L19-L27, L112-L116](https://unpkg.com/@popperjs/core@2.11.8/lib/modifiers/computeStyles.js)).
- `getBoundingClientRect(el, includeScale, isFixedStrategy)` divides by `rect.width/offsetWidth` scale and adds `visualViewport.offset*` when not on the layout viewport with fixed strategy ([POP dom-utils/getBoundingClientRect.js#L5-L41](https://unpkg.com/@popperjs/core@2.11.8/lib/dom-utils/getBoundingClientRect.js)).

### 1.7 Platform facts used below (docs/specs)

- **getBoundingClientRect** is viewport-relative and changes with every scroll of the viewport or any scrollable element ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect)). Per CSSOM View, `getClientRects` step 3 says "Apply the transforms that apply to the element and its ancestors". An element without a box gives an empty list, and then `getBoundingClientRect` returns all zeros ([drafts.csswg.org/cssom-view](https://drafts.csswg.org/cssom-view/#dom-element-getclientrects)). So gBCR already includes transforms; rotated elements give the axis-aligned bounding box.
- **CSS `zoom`**: gBCR "include[s] the effects of CSS zoom", while `client*`, `offset*` and `scroll*` do not; `Element.currentCSSZoom` is the product of ancestor zooms and is Baseline 2026 ([MDN currentCSSZoom](https://developer.mozilla.org/en-US/docs/Web/API/Element/currentCSSZoom)).
- **ResizeObserver** fires on start, on insert/remove from the DOM, and on `display:none`; it is **not triggered by CSS transforms** and not for non-replaced inline elements ([spec](https://drafts.csswg.org/resize-observer/)). Callbacks run before paint, and a loop produces "ResizeObserver loop completed with undelivered notifications" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)).
- **scrollend**: "Scrolling is considered completed when the scroll position has no more pending updates and the user has completed their gesture". It does **not** fire if the position did not change. For page scrolling, use `Document`'s `scrollend`. Baseline 2025 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollend_event)).
- **visualViewport**: pinch-zoom shrinks the visual viewport while the layout viewport is unchanged, and the on-screen keyboard can shrink the visual viewport without affecting the layout viewport. It has `offsetLeft/offsetTop/width/height/scale` and `resize/scroll/scrollend` events ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API)).
- **elementFromPoint**: viewport coords; ignores `pointer-events:none`; returns `null` outside the viewport; for a point inside an iframe it returns the `<iframe>` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint)). `ShadowRoot.elementFromPoint` exists but is marked non-standard on MDN ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot/elementFromPoint)).
- **checkVisibility()** returns false for no box, `content-visibility:hidden`, and optionally opacity 0 or `visibility:hidden`. "Elements outside the viewport or occluded by other content may still return `true`" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility)).
- **IntersectionObserver v2** (`trackVisibility`, `delay` ≥ 100 ms, `entry.isVisible`) guarantees no occlusion when true but allows false negatives (opacity < 1, filters, non-translate transforms). It is "much harder and slower to calculate" and "not for widespread use" ([web.dev](https://web.dev/articles/intersectionobserver-v2)).
- **Top layer order**: "The most recently added top layer item appears over previous top layer items". A modal dialog makes the page outside the dialog **inert**, so a popover outside the dialog's DOM is unreachable even if painted on top. The workaround is to "move the popover physically inside the DOM of the dialog" ([htmhell 2025/1](https://htmhell.dev/adventcalendar/2025/1)). This matches driver.js `layerFor`.

---

## 2. Failure modes and the fix for each

| # | Failure (why the marker drifts) | Detection | Fix (who does it) |
|---|---|---|---|
| 1 | **Layout shift with no scroll/resize event**: content inserted above, accordion opens, image/font loads, SPA banner appears. Scopos listens only to scroll, resize and target size, so it misses this. | Target rect changed while no scroll/resize event fired. | Floating UI `layoutShift`: an IntersectionObserver with `rootMargin = -rect` and `threshold = ratio`, rebuilt after every hit ([autoUpdate.ts#L46-L155]). Alternative: a per-frame rect compare (Shepherd's overlay loop; FUI `animationFrame`). |
| 2 | **Target moved by a transform/animation** (CSS transitions, carousels, drawers sliding in, `translate` on an ancestor). ResizeObserver does not fire for transforms (spec). | Rect differs between consecutive frames while the RO is silent. | rAF loop comparing `getBoundingClientRect` with the previous frame and updating only on change (FUI `animationFrame` [L230-L246]). Run it only while there is reason to (see the algorithm below). |
| 3 | **Nested scroll container scrolls**, and the event doesn't reach our listener (e.g. scroller inside a shadow root or an iframe, which is a different `window`). Whether a `scroll` event inside a shadow root reaches a `window` capture listener was **not verified**. | Rect changes with no event received. | Attach `scroll` listeners **directly to every overflow ancestor**, found with a shadow-aware parent walk (`assignedSlot`, `ShadowRoot.host`), plus `window`, `visualViewport`, and the ancestors of each `frameElement` (FUI `getOverflowAncestors`; Popper `listScrollParents`). Keep the window capture listener as a catch-all. |
| 4 | **Target clipped by `overflow:hidden/auto/clip` ancestors**: the frame is drawn over the clipping edge or over neighbouring UI. | Intersect the rect with the inner client rect of each clipping ancestor. | FUI `getClippingRect` (all ancestors, inner rect without scrollbars, prune ancestors that are not containing blocks for fixed/absolute chains). Shepherd `_getVisibleHeight` (all scroll parents, nested). Draw the frame on the **visible part** and hide when it is empty (FUI `hide`/`referenceHidden`). |
| 5 | **Target scrolled out of an inner scroller that is itself on-screen**: a nearest-only check says "visible". | Same as #4, but against the whole ancestor chain. | Shepherd's explicit fix: "Clipping against the nearest alone is wrong as soon as scroll containers nest" ([shepherd-modal.ts#L311-L314]). |
| 6 | **Target covered** by a sticky header, a modal, a cookie bar or a toast; the frame shows over something else. | `elementFromPoint` at several points inside the visible rect; the hit must be the target or inside it (composed-tree contains). | Hide the frame, or move it to the uncovered part, or scroll it out from under the sticky header. Our overlay must be `pointer-events:none` during the probe (elementFromPoint ignores such elements). Hits inside a shadow tree are retargeted to the host **[inference, MDN page silent]**, so compare composed ancestry; for iframes the hit is the `<iframe>` element. IO v2 `isVisible` is too conservative and expensive. |
| 7 | **`position: fixed` / `sticky` target**: the frame lags or "sticks" wrongly when its scroll ancestor clipping is computed as if it were in-flow. | `getComputedStyle(target).position` plus the containing block chain. | gBCR already gives the right on-screen place. For clipping: fixed has no clipping ancestors up to the next containing block (FUI [getClippingRect.ts#L100-L131]; Shepherd [L333-L334]). Sticky moves on scroll, which the scroll listeners already cover. |
| 8 | **Target inside a same-origin iframe**: the rect is relative to the iframe viewport, so the frame is offset by the iframe position, border and padding. | `el.ownerDocument !== overlay.ownerDocument`. | Add, per frame level up to the **overlay's own window**: `iframeRect.left + (clientLeft + paddingLeft)*scale`, and multiply by the iframe's scale (FUI [getBoundingClientRect.ts#L55-L79]). Shepherd stops at the overlay's window (#3478). Listen to scroll/resize in **each** frame's window and on the frame element's ancestors in the parent (FUI `getOverflowAncestors`, `traverseIframes`). Cross-origin access throws, so use try/catch and hide. |
| 9 | **Ancestor CSS `transform: scale()` / `zoom`**: values from `offset*`/`client*` are unscaled, so the frame size is wrong. | `rect.width / offsetWidth` ≠ 1, or `currentCSSZoom` ≠ 1. | Use only `getBoundingClientRect` for the frame (it includes transforms and zoom). If `clientWidth` is used for clipping rects, multiply by the scale (FUI `getScale`, `getInnerBoundingClientRect` [L34-L53]). |
| 10 | **Mobile pinch-zoom / virtual keyboard**: the card clamped to `innerWidth/innerHeight` ends up off-screen or under the keyboard; in WebKit the fixed overlay and the rects disagree by the `visualViewport` offset. | `visualViewport.scale ≠ 1`, `visualViewport.height < innerHeight`, `offsetTop/Left ≠ 0`. | Listen to `visualViewport` `resize`+`scroll`. Clamp the card to the **visual** viewport rect (FUI `getViewportRect` [L33-L53]). In WebKit, add `visualViewport.offsetLeft/Top` to rects used for fixed placement (FUI `getVisualOffsets` [L7-L18]). Optionally hide when `scale` is large (MDN example). |
| 11 | **Target re-rendered** (React key change, list virtualization): the old node is detached, so its rect is all zeros (no box) and the frame jumps to 0,0. | `!target.isConnected`, or rect is all zeros. | Hide immediately, then re-resolve with a `MutationObserver` (`childList, subtree, attributes`) plus a timeout (driver `waitForStepElement`, Shepherd `waitForAttachToElement`). Re-attach all observers to the new node. |
| 12 | **Target `display:none` / `content-visibility:hidden` / collapsed** | Empty `getClientRects()`, or `checkVisibility()` returns false. | Hide the ring, frame and card. RO fires on `display:none` (spec), which is a cheap trigger. |
| 13 | **Smooth scroll in progress**: the ring flies to a stale point, or the card flips between above and below. | `scrollIntoView({behavior:'smooth'})` was issued and the rect is still changing. | Keep the frame glued (per-frame update) but **delay the flight/card placement** until `scrollend` on every scrolled ancestor and the document, with a fallback of "rect unchanged for 3 frames" (reactour `smoothScroll`) and a max timeout. Since `scrollend` doesn't fire when nothing scrolled, check the rect first (driver `isElementInView`). Driver.js simply uses `behavior:'auto'` inside scrollable parents. |
| 14 | **Modal `<dialog>` / another popover opened after ours**: our top-layer popover ends up beneath it, or above it but inert. | A `:modal` element or `:popover-open` element appears after our show (MutationObserver on `open`/`popover` attributes, or `toggle` events). | Top-layer order is "most recently added on top". Re-show our popover (`hidePopover()` then `showPopover()`) so it is re-added last **[inference from the ordering rule]**. For a **clickable card while a modal is open**, mount the card inside the dialog's DOM (driver `layerFor`; htmhell). FUI treats top-layer elements as having no clipping ancestors. |
| 15 | **Sub-pixel jitter / blur** at fractional DPR or browser zoom. | DPR not an integer. | Round positions to device pixels: `Math.round(v*dpr)/dpr` (Popper `roundOffsetsByDPR`). Move with `transform: translate()` instead of top/left. |
| 16 | **Layout thrash**: many events lead to many gBCR reads interleaved with style writes. | Several events in one frame. | Coalesce into one rAF (driver `requireRefresh`) or one microtask (Popper `debounce`). In the frame, do **all reads first, then all writes**. Cache ancestor lists per target (Shepherd `WeakMap`, FUI `_c` cache) and invalidate them on target change and on MutationObserver hits for ancestors. |
| 17 | **ResizeObserver loop error** when our update resizes something observed. | Error message "ResizeObserver loop completed…". | Do not observe our own card from the same RO, or temporarily unobserve the floating element for one frame (FUI [autoUpdate.ts#L203-L217]); defer writes to rAF (MDN). |
| 18 | **`body` with `height:100%` treated as a clipper**: the frame is clipped to zero after page scroll. | `body` overflow propagates to the viewport. | Skip `<html>`, and skip `<body>` when `html` overflow is `visible` on both axes and neither has `contain` (Shepherd `_isScrollable` [L267-L305], issue #1984). |

---

## 3. Recommended algorithm for Scopos

Design choice: **event-driven like Floating UI, plus a bounded per-frame "settle" loop like Shepherd/driver.js** only while things are known to be moving. One scheduler and one measurement pass per frame. All geometry is in the **top document's layout-viewport CSS px**, which is what a `position:fixed` element in the top layer uses.

```text
STATE
  target: Element | null            // current resolved node
  locator: {selectors[], labelText} // for re-resolution
  ancestors: EventTarget[]          // cached per target
  clippers:  Element[]              // cached per target (subset of ancestors that clip)
  frames:    HTMLIFrameElement[]    // frameElement chain up to overlay window
  lastRect, lastVisibleRect, lastState  // for diffing
  settleUntil = 0                   // timestamp; while now < settleUntil run per-frame loop
  rafId = 0, phase: 'idle'|'scrolling'|'flying'|'shown'|'hidden'

ATTACH(target)
  detach()
  ancestors = overflowAncestors(target)      // shadow-aware walk:
      // parent = node.assignedSlot ?? node.parentNode ?? (node is ShadowRoot ? node.host : null)
      // overflow ancestor = getComputedStyle(el).overflow* matches /auto|scroll|overlay|hidden|clip/
      //                     and display not inline/contents
      // at document root: push win, win.visualViewport; if win.frameElement (same-origin):
      //   frames.push(frameElement); continue walk from frameElement in parent doc
      //   stop at overlay's window (Shepherd #3478)
  clippers = pruneByContainingBlock(target, ancestors)  // FUI getClippingElementAncestors rules:
      // fixed target: drop ancestors until a containing block (transform/filter/contain/will-change…)
      // absolute chain: drop position:static ancestors
      // never <html>; <body> only if it is its own scroll container (Shepherd #1984 rule)
  for a in ancestors: a.addEventListener('scroll', schedule, {passive:true})
                      a.addEventListener('resize', schedule, {passive:true})   // window, visualViewport
  for each window W in [top window, ...frame windows]:
      W.addEventListener('scroll', schedule, {capture:true, passive:true}) // catch-all
      W.document.addEventListener('scrollend', onScrollEnd, {capture:true})
  visualViewport.addEventListener('resize'|'scroll', schedule)
  ro = new ResizeObserver(schedule); ro.observe(target); frames.forEach(f => ro.observe(f))
      // never observe our own card here (avoid RO loops)
  io = observeMove(target, schedule)          // Floating UI layoutShift technique
  mo = new MutationObserver(onMutations)      // childList+subtree+attributes on target's root node(s)
      // (document and, if target is in a shadow root, that root) — used to:
      //   a) detect !target.isConnected → reResolve()
      //   b) detect a new :modal / :popover-open → reassertTopLayer()
      //   c) invalidate ancestor cache if an ancestor's class/style changed → schedule()
  target.addEventListener('transitionrun'|'animationstart', () => settle(1000), capture on ancestors' root)
      // [inference] transforms don't fire RO; run the frame loop while animations run
  schedule()

schedule()                // coalesce: at most one measurement per frame (driver requireRefresh)
  if (!rafId) rafId = requestAnimationFrame(frame)

settle(ms)                // allow per-frame polling for a bounded time (FUI animationFrame, Shepherd rafLoop)
  settleUntil = max(settleUntil, now + ms); schedule()

frame(now)
  rafId = 0
  // ---------- READ PHASE (no style writes before this ends) ----------
  if (!target || !target.isConnected) { hideAll('lost'); reResolve(); return }
  rects = target.getClientRects()
  if (rects.length === 0 || !target.checkVisibility?.({visibilityProperty:true, opacityProperty:true}))
      { hideAll('no-box'); return }
  r = target.getBoundingClientRect()            // includes transforms + CSS zoom
  r = toTopViewport(r, frames)                  // FUI iframe walk:
      // for f in frames (innermost→outermost):
      //   s = scaleOf(f) = f.getBoundingClientRect().width / f.offsetWidth (fallback 1)
      //   fr = f.getBoundingClientRect(); cs = getComputedStyle(f)
      //   r = r * s; r.x += fr.left + (f.clientLeft + parseFloat(cs.paddingLeft)) * s
      //              r.y += fr.top  + (f.clientTop  + parseFloat(cs.paddingTop))  * s
  if (isWebKit && visualViewport) r.x += vv.offsetLeft; r.y += vv.offsetTop   // FUI getVisualOffsets
  clip = viewportRect()                          // layout viewport: 0,0,html.clientWidth,clientHeight
  for c in clippers:
      cr = innerClientRect(c)                    // c.getBoundingClientRect() + clientTop/Left,
                                                 // clientWidth/Height * scaleOf(c)  (no scrollbars)
      cr = toTopViewport(cr, framesAbove(c))
      clip = intersect(clip, cr)
  for f in frames: clip = intersect(clip, innerClientRect(f) in top coords)
  vis = intersect(r, clip)
  visibleRatio = area(vis) / max(area(r), 1)
  occluded = false
  if (area(vis) > 0):
      pts = samplePoints(vis)  // center + 4 points inset 2px from corners (clamped inside vis)
      hits = 0
      for p in pts:
          doc = target.ownerDocument; pp = fromTopViewport(p, frames)   // per-frame coords
          e = doc.elementFromPoint(pp.x, pp.y)        // our overlay is pointer-events:none → ignored
          if (e && composedContains(target, e) || composedContains(e, target) && e is target's host chain)
              hits++
          // composedContains: walk e up via parentNode / ShadowRoot.host / assignedSlot
          // if e is a shadow host containing target, try e.shadowRoot?.elementFromPoint (open roots only)
      occluded = hits === 0
      partiallyOccluded = 0 < hits < pts.length
  vv = visualViewport ? {x:vv.offsetLeft, y:vv.offsetTop, w:vv.width, h:vv.height}
                      : {x:0, y:0, w:innerWidth, h:innerHeight}            // card clamp box
  cardSize = cachedCardSize                      // measured once after content change, not per frame
  // ---------- DECIDE ----------
  state =
      area(vis) === 0                    ? 'hidden:clipped'   // FUI hide referenceHidden
    : occluded                           ? 'hidden:covered'
    : visibleRatio < 0.25 && phase!=='scrolling' ? 'hidden:mostly-clipped'
    :                                      'shown'
  changed = !rectsEqual(r, lastRect) || !rectsEqual(vis, lastVisibleRect) || state !== lastState
  // ---------- WRITE PHASE ----------
  if (changed):
      if state startsWith 'hidden': fadeOutAll() (opacity 0, keep in DOM; don't move ring)
      else:
          frameBox = inflate(vis, 6)                       // draw around VISIBLE part, not full rect
          ring     = {x: vis.right, y: vis.top}            // top-right of visible part
          card     = placeCard(frameBox, cardSize, vv)     // below→above→right→left (flip),
                                                           // then shift-clamp inside vv with 8px padding
                                                           // (FUI flip + shift(limitShift))
          writeTransform(frameEl, roundDPR(frameBox.x), roundDPR(frameBox.y)); set width/height
          if phase !== 'flying': writeTransform(ringEl, roundDPR(ring))
          writeTransform(cardEl, roundDPR(card))           // roundDPR(v) = Math.round(v*dpr)/dpr
          fadeInAll()
      lastRect = r; lastVisibleRect = vis; lastState = state
  if (phase === 'flying' || now < settleUntil || changed && phase === 'scrolling')
      schedule()       // keep polling only while motion is expected; stops by itself when stable
```

**Scroll-into-view and flight (driver.js + reactour patterns):**

```text
focusStep(locator)
  target = resolve(locator); if (!target) { hideAll(); waitForTarget(locator, 5000); return }
  attach(target)
  if (fullyInsideClipChain(target)) return fly()
  phase = 'scrolling'; hideCard()
  target.scrollIntoView({block:'center', inline:'nearest', behavior: prefersReducedMotion ? 'auto' : 'smooth'})
  settle(1500)                                        // frame keeps following during the scroll
  await Promise.race([
      allScrollEnded(scrolledAncestors + document),   // 'scrollend' on each ancestor/document
      rectStableFor(3 frames),                        // reactour fallback (no scrollend support / no-op scroll)
      timeout(1200)
  ])
  phase = 'shown'; fly()

fly()
  phase = 'flying'; start = now; from = currentRingPos
  each frame (inside frame()'s write phase): to = liveRingTarget  // re-read every frame (driver transitionStage)
      p = ease(min(1,(now-start)/D)); ring = lerp(from, to, p) → transform only
  when p === 1: phase = 'shown'; show card
```

**Re-resolution (target re-rendered):**

```text
reResolve()
  hideAll('lost'); detach observers on the old node
  el = resolve(locator)            // CSS selectors, then label text
  if (el) attach(el), schedule()
  else waitForTarget(locator, timeout)  // MutationObserver(childList, subtree, attributes) on document
                                        // (+ open shadow roots you know about), re-run resolve on each batch,
                                        // throttle to 1 per rAF; give up after timeout → keep hidden, report
```

**Top layer:**

```text
reassertTopLayer()   // called from MO when an element gains [open] on <dialog> or :popover-open appears
  modal = topmost document.querySelector(':modal')        // FUI isTopLayer uses ':modal'/':popover-open'
  if (modal && modal.contains(composedRoot(target))):
      mount card host inside modal (driver layerFor) so it is not inert
  else:
      overlay.hidePopover(); overlay.showPopover()        // re-append → painted above (top-layer order rule)
  schedule()
```

**Why these choices, briefly:**
- Measuring only with `getBoundingClientRect` makes transforms, zoom and sticky positioning correct for free (CSSOM View, MDN currentCSSZoom).
- Listeners on the actual ancestor chain, plus the IntersectionObserver move trick, cover what a single window capture listener misses (FUI, Popper).
- Clipping against **all** clippers with containing-block pruning is what stops "frame over the wrong panel" (FUI, Shepherd).
- Drawing on the visible rect and hiding when it is empty or covered avoids pointing at invisible things (FUI `hide`).
- The bounded settle loop gives Shepherd-level robustness without its always-on per-frame cost.
- Read-then-write in a single rAF, writing transforms rounded to device pixels, avoids layout thrash and jitter (driver `requireRefresh`, Popper `computeStyles`).
