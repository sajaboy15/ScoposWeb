# 03 — How open-source AI browser agents extract, ground and cache

Research date: 2026-10-16. Sources are the projects' `main` branches as of this date, unless a tag is named. Everything below was read from source or official docs. Third-party claims are labeled as such. Where a file was truncated or a detail wasn't in the code, this report says so and doesn't fill the gap.

Scopos today: CSS selector list → visible filter → accessible name / role / section / state → lines like `[12] button "Новый счёт" · Счета · current` → id→element map → descriptor `{sel:[data-testid,id,name,aria-label,css path], text, role}` → re-find by selectors, then fuzzy text.

---

## 1. browser-use (Python + CDP; JS in older versions)

### 1.1 Current pipeline (`browser_use/dom/`)
Source files:
[service.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/service.py) ·
[enhanced_snapshot.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/enhanced_snapshot.py) ·
[views.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/views.py) ·
[serializer/clickable_elements.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/clickable_elements.py) ·
[serializer/serializer.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/serializer.py) ·
[serializer/paint_order.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/paint_order.py) ·
[agent/prompts.py](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/prompts.py)

**Data collection (CDP).** Four trees are merged:
- `DOM.getDocument` with `depth:-1` and `pierce:true`, which includes shadow roots.
- `DOMSnapshot.captureSnapshot` with `includePaintOrder`, `includeDOMRects`, and only 10 computed styles (`REQUIRED_COMPUTED_STYLES`: display, visibility, opacity, overflow, overflow-x, overflow-y, cursor, pointer-events, position, background-color). A code comment says the short list avoids Chrome crashes on heavy sites.
- `Accessibility.getFullAXTree` per frame.
- `Page.getLayoutMetrics` for the device-pixel ratio.

There is a 10 s timeout, then a 2 s retry. If the AX tree fails, the build continues with an empty AX tree.

**JS click listeners.** `getEventListeners` is run via `includeCommandLineAPI` to find elements with `click`, `mousedown`, `mouseup`, `pointerdown` or `pointerup` listeners.
- It is skipped when the page has more than 10,000 elements.
- It is abandoned when more than 100 elements have listeners (`_MAX_JS_CLICK_LISTENER_ELEMENTS = 100`).

**"Interactive" decision** (`ClickableElementDetector.is_interactive`). The first matching rule wins:
1. Not an element, or `html`/`body` → false.
2. Has a JS click listener → true.
3. `iframe`/`frame` larger than 100×100 → true.
4. `label` with `for` → false. `label` or `span` with a form control within 2 descendant levels → true.
5. Search heuristic: class, id or any `data-*` value contains `search, magnify, glass, lookup, find, query, search-icon, search-btn, search-button, searchbox` → true.
6. AX properties: `disabled` or `hidden` → **false**. `focusable`, `editable`, `settable`, `required`, `autocomplete` or `keyshortcuts` truthy → true. `checked`, `expanded`, `pressed` or `selected` present → true.
7. Tags `button, input, select, textarea, a, details, summary, option, optgroup` → true. `label` is intentionally excluded.
8. Attributes `onclick, onmousedown, onmouseup, onkeydown, onkeyup, tabindex` → true.
9. Role (attribute or AX) in `button, link, menuitem, option, radio, checkbox, tab, textbox, combobox, slider, spinbutton, search, searchbox, row, cell, gridcell`. The AX check also includes `listbox`.
10. Icon heuristic: box between 10 and 50 px on both sides, plus any of `class, role, onclick, data-action, aria-label` → true.
11. `cursor: pointer` → true.

**Visibility** (`is_element_visible_according_to_all_parents`):
- Hidden if `display:none`, `visibility:hidden`, `opacity <= 0`, or there are no layout bounds.
- Viewport check: walks up through frames, adding iframe offsets and subtracting scroll.
- Horizontal: the element must be at least partly inside the viewport.
- Vertical: the element is kept within **±1000 px** of the viewport (`viewport_threshold = 1000`).

**Occlusion (paint order)** (`PaintOrderRemover`):
- Nodes are grouped by CDP `paintOrder`, processed from highest to lowest, and a union of rectangles is built.
- A node whose rect is **fully** inside the union of higher-painted rects gets `ignored_by_paint_order`.
- A node only counts as an occluder if its background is not `rgba(0, 0, 0, 0)` and its `opacity >= 0.8`. The source comments the 0.8 as "vibes based".
- The union is capped at 5000 rects.

**Nested duplicate removal** (bbox containment):
- "Propagating" parents are `a`, `button`, `div`/`span` with role `button` or `combobox`, and `input` with role `combobox`.
- A descendant is dropped when **at least 99%** of its area (`DEFAULT_CONTAINMENT_THRESHOLD = 0.99`) is inside such a parent.
- Exceptions (always kept): text nodes, `input/select/textarea/label`, nested propagating elements, elements with `onclick`, non-empty `aria-label`, or role `button/link/checkbox/radio/tab/menuitem/option`.

**Ids.** The highlight index **is the CDP `backend_node_id`**, which is stable for the life of the DOM node. If that id collides, a synthetic id is allocated.

**LLM format.** One line per kept node, indented with tabs. Only interactive, scrollable or iframe nodes add a depth level, so wrapper divs are flattened.
- Interactive element: `[backendId]<tag attr=val ... />`.
- Element that is **new** since the last step: prefixed with `*`, e.g. `*[12]<input name=q />`. New means its (session, backendNodeId) pair wasn't in the previous selector map.
- Scrollable containers: `|scroll element|`.
- Iframes: `|IFRAME|`.
- Shadow DOM: `|SHADOW(open)|` / `|SHADOW(closed)|`, with the shadow content between `Open Shadow` and `Shadow End`.
- SVG is collapsed to `<svg ... /> <!-- SVG content collapsed -->`.
- Text nodes are printed only if visible, not occluded, and longer than one character.
- Off-screen content becomes a hint, e.g. `... (N more elements below - scroll to reveal):` with entries like `<tag> "text" ~N pages down`.

**Attribute diet:**
- Whitelist (`DEFAULT_INCLUDE_ATTRIBUTES`): title, type, checked, id, name, role, value, placeholder, alt, aria-label, aria-value*, pattern/min/max/step, accept, autocomplete, contenteditable, AX states (selected, expanded, pressed, disabled, invalid, required, haspopup, level, busy, live, …), and `ax_name`.
- `class` is commented out of the list.
- Every value is capped at **100 chars**.
- Duplicate values longer than 5 chars are dropped.
- `aria-label`, `placeholder` and `title` are dropped when they equal the text.
- `role` and `type` are dropped when they equal the tag name. `invalid=false` and `required=false` are dropped.
- Password values are never emitted. Input values for types password, file and hidden, and for `autocomplete` cc-* / one-time-code fields, are not even stored.

**Compound controls.** Native widgets are expanded into virtual sub-parts. For example, `select` becomes "Dropdown Toggle" plus an "Options" listbox with `count`, the **first 4 options (30 chars each)** followed by `... N more options...`, and a `format_hint`.

**Budget.** The serialized elements text is hard-truncated at **40,000 characters** (`max_clickable_elements_length = 40000`) and labeled `Interactive elements (truncated to 40000 characters):`. Above and below the list it prints `X pages above, Y pages below` and the markers `[Start of page]` / `[End of page]`.

**Iframes and shadow DOM.** `max_iframes = 100` and `max_iframe_depth = 5`. Cross-origin iframes are off by default (`cross_origin_iframes = False`), and a cross-origin iframe must be at least 10 px on each side. Shadow roots are pierced via CDP.

### 1.2 Element identity and deterministic rerun
- `__hash__`: SHA-256 over the parent tag path (`html/body/div/...`), the `STATIC_ATTRIBUTES` (sorted `k=v`), and `ax_name`. `STATIC_ATTRIBUTES` includes id, name, type, placeholder, aria-label, title, role, data-testid, data-test, data-cy, data-selenium, href, for, tabindex, alt, src, aria-*, …
- `compute_stable_hash`: the same hash, but class tokens matching any of these substrings are removed: `focus, hover, active, selected, disabled, animation, transition, loading, open, closed, expanded, collapsed, visible, hidden, pressed, checked, highlighted, current, entering, leaving`.
- `xpath`: tag names with a sibling index `[n]` only when there are same-tag siblings. It stops at shadow roots and iframes.
- **Rerun** (`Agent.rerun_history` in [agent/service.py](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/service.py), [example](https://github.com/browser-use/browser-use/blob/main/examples/features/rerun_history.py)):
  - Each saved step is replayed **without the LLM**. The exceptions are `extract` steps and one final summary call.
  - Element re-identification is a cascade (`MatchLevel`): **1 EXACT hash → 2 STABLE hash → 3 XPATH → 4 tag + AX name → 5 unique attribute (name, then id, then aria-label)**.
  - Defaults: `max_retries=3`, backoff `min(5*2^(n-1), 30)` s. If a menu item isn't found, the previous menu-opening step is re-executed once.
- **workflow-use** ([schema/views.py](https://github.com/browser-use/workflow-use/blob/main/workflows/workflow_use/schema/views.py), [selector_generator.py](https://github.com/browser-use/workflow-use/blob/main/workflows/workflow_use/healing/selector_generator.py), [element_finder.py](https://github.com/browser-use/workflow-use/blob/main/workflows/workflow_use/workflow/element_finder.py)) is browser-use's deterministic workflow project.
  - Steps store `target_text` (primary), `container_hint`, `position_hint` and prioritized `selectorStrategies`. CSS selector and xpath are marked **[LEGACY]**.
  - Strategy priority: text_exact (1), role_text (2), aria_label (3), placeholder (4), title (5), alt_text (6), text_fuzzy (7, `difflib` ratio ≥ 0.8), then optimized xpaths.
  - Known weaknesses in the code: it returns the **first** visible match with **no uniqueness check**, and `container_hint`/`position_hint` aren't used during lookup. The README says the project is early stage and that the LLM fallback is "currently really bad".

### 1.3 Legacy in-page JS (`buildDomTree.js`, tag 0.5.0)
[dom_tree/index.js @0.5.0](https://github.com/browser-use/browser-use/blob/0.5.0/browser_use/dom/dom_tree/index.js) is the closest analogue to Scopos, because it runs in the page.

- **Interactive:**
  - A cursor from a long list (`pointer, move, text, grab, …`) short-circuits to true.
  - Native tags are interactive unless they are disabled, readonly, inert, or have cursor `not-allowed`/`wait`.
  - Also interactive: `contenteditable`, class `button`/`dropdown-toggle`, `data-toggle="dropdown"`, `aria-haspopup="true"`, and roles such as `button, menuitemradio, menuitemcheckbox, radio, checkbox, tab, switch, slider, spinbutton, combobox, searchbox, textbox, option, scrollbar`.
  - Event listeners count when `getEventListeners` is available.
- **Visible:** `offsetWidth > 0 && offsetHeight > 0`, plus `visibility` and `display` checks.
- **Top element:** `elementFromPoint` at the center of the **middle** client rect, then walking up to see whether it reaches the element. `shadowRoot.elementFromPoint` is used inside shadow trees.
- **Viewport:** `viewportExpansion` px around the viewport. `-1` means the whole page.
- **Nested interactives:** a child inside a highlighted parent gets its own index only if `isElementDistinctInteraction`: a native control, an interactive role, contenteditable, `data-testid`/`data-cy`/`data-test`, onclick, listeners, or a heuristic class.
- **Caching within a pass:** WeakMaps for `getBoundingClientRect`, `getClientRects` and `getComputedStyle`.

---

## 2. Stagehand (TypeScript, CDP, accessibility tree)

Sources (the repo was restructured; the snapshot code now lives under `packages/extension/understudy`; the cache and handler code was read at tag `@browserbasehq/stagehand@3.0.1`):
[a11yTree.ts](https://github.com/browserbase/stagehand/blob/main/packages/extension/understudy/a11y/snapshot/a11yTree.ts) ·
[capture.ts](https://github.com/browserbase/stagehand/blob/main/packages/extension/understudy/a11y/snapshot/capture.ts) ·
[treeFormatUtils.ts](https://github.com/browserbase/stagehand/blob/main/packages/extension/understudy/a11y/snapshot/treeFormatUtils.ts) ·
[prompt.ts](https://github.com/browserbase/stagehand/blob/main/packages/extension/prompt.ts) ·
[ActCache.ts @3.0.1](https://github.com/browserbase/stagehand/blob/%40browserbasehq/stagehand%403.0.1/packages/core/lib/v3/cache/ActCache.ts) ·
[actHandler.ts @3.0.1](https://github.com/browserbase/stagehand/blob/%40browserbasehq/stagehand%403.0.1/packages/core/lib/v3/handlers/actHandler.ts) ·
[caching docs](https://docs.stagehand.dev/v3/best-practices/caching) ·
[deterministic agent docs](https://docs.stagehand.dev/v3/best-practices/deterministic-agent)

**Representation ("hybrid snapshot").**
- `Accessibility.getFullAXTree` is fetched per frame and merged with a DOM index that maps backendNodeId → absolute xpath, tag, and scrollable flag.
- Pruning:
  - Keep a node if it has a name, has children, or its role is not structural (`generic`, `none`, `inlinetextbox`).
  - A structural node with **one** child is replaced by that child.
  - Structural leaves are dropped.
  - Remaining `generic`/`none` nodes are relabeled with their tag name. A `combobox` on a `<select>` becomes `select`.
- `StaticText` children are removed when their concatenated text equals the parent's name.
- Scrollable nodes get the role `scrollable, <tag>`.
- Line format: two-space indent, then `[<frameOrdinal>-<backendNodeId>] role: name`, then ` [selected]` / ` [checked]` where they apply.
- `cleanText` removes **Unicode Private Use Area characters (U+E000–U+F8FF)**, which are icon-font glyphs, and collapses NBSP-like characters (U+00A0, U+202F, U+2007, U+FEFF).
- Side maps: `combinedXpathMap` (encodedId → xpath) and `combinedUrlMap` (encodedId → link URL). Link URLs are kept out of the outline and live in the map instead.

**Frames and shadow DOM.** Iframes are stitched in under their host iframe line. OOPIFs (out-of-process iframes) get their own CDP session. Xpaths are prefixed with the iframe's xpath. `pierceShadow` defaults to true.

**Scoping.** A `focusSelector` (CSS or xpath) limits the snapshot to one subtree. This is the documented way to make the cache key insensitive to the rest of the page. `ignore` locators exclude subtrees.

**Grounding.**
- The prompt tells the model to copy the full id including the frame ordinal (`[0-18372]` → `"0-18372"`).
- The prompt says "Do not fabricate or guess an element" and to return `action: null` if nothing matches.
- The id is resolved via the xpath map to the selector `xpath=/...`. The id is rejected if it has no hyphen or no xpath entry.
- Two-step actions (`twoStep`, e.g. opening a custom dropdown): after the first action, the tree is re-snapshotted and **only the diff** (`diffCombinedTrees`) is sent for step 2.

**Act cache (local `cacheDir`).**
- Key: `sha256(JSON.stringify({instruction(trimmed), url, variables}))`.
- Entry: `{version:1, instruction, url, variables, actions[{selector, description, method, arguments}], actionDescription, message}`.
- On a hit, the stored actions are replayed through `actFromObserveResult` with **no LLM call**. Replay stops at the first failure.
- If the replay succeeded but the actions changed (selector, description, method or arguments), the entry is rewritten under the same key.

**Self-heal** (`selfHeal: true`):
- If performing a cached or observed action throws, the handler takes a fresh snapshot and makes **one** LLM call using the stored `description` + `method` as the instruction.
- It swaps in the new xpath and retries **once**.
- Bug in the code: if the new id has no xpath, the old selector is silently reused.

**Docs on cache keys.**
- The server cache key is instruction + page content + options + URL. Tracking query parameters are partly stripped.
- Variable **keys** are part of the key, not their values. Docs advise `act("type %email% …", {variables})` instead of inlining values.
- The deterministic-agent docs give example (not benchmark) figures: first run ~50,000 tokens and 20–30 s; cached run 0 tokens and 2–3 s.

---

## 3. Playwright aria snapshot and Playwright MCP

Sources:
[injected/ariaSnapshot.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/ariaSnapshot.ts) ·
[ariaSnapshot.ts @v1.55.0](https://github.com/microsoft/playwright/blob/v1.55.0/packages/injected/src/ariaSnapshot.ts) (YAML renderer) ·
[roleUtils.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/roleUtils.ts) ·
[domUtils.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/domUtils.ts) ·
[MCP snapshots doc](https://playwright.dev/mcp/snapshots) ·
[playwright-mcp README](https://github.com/microsoft/playwright-mcp/blob/main/README.md)

**Format:**
```
- textbox "What needs to be done?" [ref=e5]
- list [ref=e8]:
  - listitem [ref=e9]:
    - checkbox "Toggle Todo" [ref=e10]
```
- Each line is `- role "name"` followed by flags: `[checked]`/`[checked=mixed]`, `[disabled]`, `[expanded]`, `[active]`, `[level=N]`, `[pressed]`, `[selected]`, `[ref=eN]`, `[cursor=pointer]`.
- Link URLs render as a `- /url: …` prop.
- Text renders as `- text: …`.
- A name is rendered only if it is at most 900 chars, and is JSON-quoted.
- A node whose single child text equals its name has that child dropped.
- An inline `generic` with a single text child is collapsed into its parent.

**Visibility (AI mode).** AI mode uses `ariaOrVisible`: a node is kept if it is aria-visible **or** visually visible.
- `isElementVisible` = `checkVisibility()` and `visibility === 'visible'` and `rect.width > 0 && rect.height > 0`.
- `display: contents` elements are visible if any child is.
- Aria-hidden means `display:none`, `aria-hidden=true`, `inert`, or a non-slotted light-DOM child of a shadow host.
- When a **modal dialog** (`dialog:modal`) is open, everything outside the topmost modal is inert.

**Refs.**
- In AI mode a ref is given only to nodes that are `box.visible && receivesPointerEvents`. `receivesPointerEvents` means not inert and the nearest computed `pointer-events` is not `none`.
- Format: `e<counter>`. In MCP, iframe refs are prefixed with the frame, e.g. `f1e12`.
- **Stability:** the ref is cached on the element (`element._ariaRef`) and **reused while role and name are unchanged**. The counter is never reset. As a result, an unchanged element keeps its ref across snapshots, and a changed element gets a new one.

**Shadow DOM.** Traversal follows the flattened tree: `slot.assignedNodes()`, then the element's `shadowRoot` children, skipping light children that have an `assignedSlot`. `aria-owns` targets are visited as extra children of the owner.

**Accessible name** (`roleUtils`), following the accname spec:
1. `aria-labelledby`
2. Embedded control values
3. `aria-label`
4. Native sources: `<label>`, button `value`, `alt`, `legend`, `figcaption`, `caption`. Placeholder is used only when there is no `title`.
5. Content: only for roles that allow name from content (button, cell, checkbox, columnheader, gridcell, heading, link, menuitem*, option, radio, row, rowheader, switch, tab, tooltip, treeitem)
6. `title`

Whitespace is collapsed, U+200B and U+00AD are removed, and NBSP is kept.

**Implicit landmarks.** `header`/`footer` are banner/contentinfo only if not inside `article, aside, main, nav, section`. `section` and `form` are landmarks only when they have an accessible name.

**MCP size controls.**
- `browser_snapshot {depth}` limits tree depth.
- `{target:"e8"}` snapshots one subtree.
- `browser_find` returns only nodes that match text or a regex.
- `--snapshot-mode full|none`.
- Stale ref error: "Ref … not found in the current page snapshot. Try capturing new snapshot."
- Each tool takes `element` (a human-readable description) **and** `target` (a ref or selector), so a description travels with every ref.

---

## 4. Skyvern

Sources:
[webeye/scraper/domUtils.js](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern/webeye/scraper/domUtils.js) ·
[webeye/scraper/scraper.py](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern/webeye/scraper/scraper.py) ·
[code caching docs](https://skyvern.com/docs/developers/features/code-caching)

**Interactive (`isInteractable`).** The first matching rule wins:
1. Must be visible and not hidden (`display:none` or the `hidden` attribute).
2. Widget roles count (`button, link, checkbox, menuitem, tab, combobox, searchbox, slider, switch, gridcell, option`; `textbox` only if not readonly).
3. `pointer-events:none` → false.
4. `a[href]`, `button`, `select`, `option`, `textarea` → true. A `label` with a non-disabled `.control` → true.
5. Framework hooks count: Angular `ng-click`/`__ngContext__`, jQuery `$._data` click events, `jsaction`, `onclick`, contenteditable.
6. Library-specific classes count (select2, Kendo, Google `pac-item`, datepicker cells, `li.dropdown-item`/`ui-menu-item`).
7. `cursor:pointer` counts on a list of tags (div, span, img, i, li, p, td, svg, strong, h1–h4, …), including pointer cursors that appear only in `:hover` styles.
8. `div[tabindex="0"]` → true.

**Visibility:**
- `checkVisibility()` (skipped on WebKit), closed `<details>`, `visibility != visible`, and `clip: rect(0 0 0 0)` / `rect(1px 1px 1px 1px)` (visually-hidden patterns) all mean hidden.
- Zero-size elements are allowed only if they are hover-only or have pointer pseudo-content.
- Rects narrower or shorter than **3 px** are dropped.
- Form controls inside shadow roots are forced visible.

**Ids.**
- A 4-char `unique_id` attribute is written onto the DOM element and reused if already present.
- Format: char 1 is the frame index base62. Chars 2–4 are a counter base62.
- The LLM sees this id. The backend selector is `[unique_id='XXXX']`.

**Hash.**
- `hash_element` = SHA-256 of the element JSON minus `id`, `rect` and `frame_index`. It includes the xpath.
- `hash_to_element_ids` groups identical elements.
- A separate `structural_identity` drops xpath and frame "for matching controls that have moved".

**Serialization.**
- Trimmed element tree, rendered as HTML or JSON.
- Only reserved attributes are kept (~30: href, name, placeholder, type, value, aria-label, aria-checked, …).
- `name` is capped at 500 chars and enriched text at 120 chars.
- Base64 `src`/`href` values are dropped.
- Passwords and OTP fields are masked.

**Limits.** `maxElementNumber = 15000`. If the trimmed HTML exceeds `DEFAULT_MAX_TOKENS`, screenshots are reduced to 1.

**Caching.** "Code caching" generates code from a successful agent run. `run_with="code"` replays it without the LLM. "AI Fallback" is on by default and falls back to the agent and regenerates the code when the page changed.

---

## 5. LaVague (retrieval instead of full serialization)

Source: [lavague-core/lavague/core/retrievers.py](https://github.com/lavague-ai/LaVague/blob/main/lavague-core/lavague/core/retrievers.py)

LaVague sends the LLM only the **top-k relevant HTML chunks** for the instruction, not the whole page.
- The default pipeline is `InteractiveXPathRetriever` → `FromXPathNodesExpansionRetriever` → `SemanticRetriever`.
- `InteractiveXPathRetriever` adds an `xpath` attribute to interactive elements.
- `FromXPathNodesExpansionRetriever` grows context around each element through siblings and parents into ~750-char chunks.
- `SemanticRetriever` uses embeddings with `top_k = 10`.
- `OpsmSplitRetriever` is a non-embedding alternative:
  - Builds flat dicts per element with fields `element, placeholder, text, name, xpath`, each capped at **200 chars**.
  - Ranks with BM25 in two passes: first over groups of 10, then over individual elements. `top_k = 5`.
  - Drops results that are not visible.
- `CleanHTMLRetriever` strips base64 `src` values and `<svg>` blocks.

---

## 6. AgentQL

Source: [How AgentQL works](https://docs.agentql.com/intro/under-the-hood) (closed backend)

- Inputs are HTML plus the accessibility tree, simplified by removing metadata, scripts and extra hierarchy.
- There are separate pipelines for scraping and automation. Automation assumes a one-to-one mapping between query terms and elements.
- The LLM's answer is **grounded and validated against the input** before it is returned.
- Disambiguation is done by describing context in the query, e.g. `submit_btn(in the footer)`.
- There are "fast" and "standard" modes.
- No cache internals or numbers are published, so there is nothing more to verify.

---

## 7. Vimium link hints (pure in-page heuristics, battle-tested)

Sources: [content_scripts/link_hints.js](https://github.com/philc/vimium/blob/master/content_scripts/link_hints.js) · [lib/dom_utils.js](https://github.com/philc/vimium/blob/master/lib/dom_utils.js)

**Clickable (`getLocalHintsForElement`):**
- `aria-disabled` set to `""` or `"true"` → **skip**.
- `onclick` → clickable.
- Roles `button, tab, link, checkbox, menuitem, menuitemcheckbox, menuitemradio, radio, textbox` → clickable.
- contenteditable → clickable.
- `jsaction` with a `click` event (not namespace `none`) → clickable.
- Angular `ng-click` (all prefix variants) → clickable, checked only if the page has `.ng-scope`.
- `a` → clickable.
- `input` (not hidden, disabled, or readonly) → clickable.
- `textarea`, `button`, `select` → clickable when not disabled; `textarea` also not readonly.
- `object`, `embed`, `details` → clickable.
- `label` → clickable only if its `.control` is enabled and doesn't already get its own hint.
- `img` with a zoom cursor → clickable. `img[usemap]` → each `<area>` gets its own hint.
- Fallbacks:
  - Class containing `button`/`btn` → **possibleFalsePositive**.
  - Any `span` → possibleFalsePositive.
  - `tabindex >= 0` → **secondClassCitizen**.

**Filtering:**
- Elements are collected recursively through every open `shadowRoot`, then reversed so descendants come first.
- A possibleFalsePositive is dropped if any of the next 6 elements has it as an ancestor within 3 levels. In effect, a fake-button wrapper around a real control is dropped.
- **Occlusion:** `elementFromPoint` at the center, then at 4 corners inset 0.1 px. The element is kept if the hit element contains it or is contained by it. `elementFromPoint` recurses into shadow roots.
- secondClassCitizens skip the occlusion test.

**Visible rect** (`getVisibleClientRect`):
- Left and top are clamped to 0. The element is rejected if it starts within 4 px of the right or bottom edge of the viewport.
- Rejected if width or height is under **3 px**, or if `visibility != visible`.
- For a zero-size element, children that are floated or absolutely/fixed positioned are tested instead.

---

## 8. Chrome `chrome.automation`
The reference page for this API returned 404 when fetched, so its availability couldn't be verified. Not recommended as a dependency. Every project studied computes roles and names itself (in-page JS) or via CDP `Accessibility.getFullAXTree`.

---

## 9. Comparison

| | Representation sent to LLM | Element id scheme | Visibility / "interactive" rules | Shadow DOM / iframes | Caching / replay | Size controls & numbers |
|---|---|---|---|---|---|---|
| **browser-use** (CDP) | Flattened pseudo-HTML `[id]<tag attrs />`, tab indent, `*` = new since last step, text nodes inline | CDP `backend_node_id` (stable per node) | AX props + tags + roles + listeners + cursor:pointer + icon-size rule; display/visibility/opacity; ±1000 px vertical; paint-order occlusion (bg not transparent, opacity ≥0.8); 99% bbox containment dedupe | Pierce shadow (open/closed marked); iframes ≤100, depth ≤5; cross-origin off by default | `rerun_history`: no LLM; 5-level match cascade (hash → stable hash → xpath → tag+AX name → name/id/aria-label) | 40,000-char cap; attrs ≤100 chars; select shows 4 options × 30 chars |
| **browser-use legacy JS** | Same | Running counter | elementFromPoint at center of middle rect; `viewportExpansion` | `shadowRoot.elementFromPoint` | — | — |
| **Stagehand** | AX outline `[frame-backendId] role: name`, 2-space indent, structural nodes pruned or collapsed | `frameOrdinal-backendNodeId` → xpath map | Accessibility tree (browser decides); PUA/NBSP cleanup | pierceShadow on; OOPIF stitched; xpath prefixing | ActCache sha256(instruction, url, variables) → actions; replay with no LLM; self-heal = 1 LLM call + 1 retry; refresh entry on change | Scope to `selector`; 2-step sends diff only |
| **Playwright MCP** | YAML `- role "name" [ref=eN] [cursor=pointer]` | `e<n>` (frame prefix `f1e12`), cached on element while role+name unchanged | `checkVisibility` + visibility + w/h>0; ref only if visible & pointer-events; modal makes rest inert | Flat-tree via slots; frames prefixed | None (refs valid until page changes) | `depth`, `target` subtree, `browser_find`; names ≤900 chars |
| **Skyvern** | Trimmed HTML/JSON element tree | 4-char `unique_id` attr written to DOM | Many tag/role/framework/cursor rules (incl. hover-only pointer); `checkVisibility`; ≥3 px; clip-hidden detection | Open shadow; per-frame index char | Code caching (`run_with="code"`) + AI fallback + regenerate | ≤15,000 elements; name ≤500; text ≤120 |
| **LaVague** | Top-k retrieved HTML chunks | `xpath` attribute | Driver-defined | Iframe recursion | — | chunk 750 chars; BM25 top_k 5 / embeddings top_k 10; fields ≤200 chars |
| **AgentQL** | HTML + a11y (closed) | — | — | — | — | — |
| **Vimium** | n/a (hints) | n/a | Rich clickable rules; false-positive & occlusion filters (center + 4 corners); ≥3 px; 4 px edge | Recurses open shadow roots | — | — |

**Token figures.** Third-party figures surfaced in web search; we did not fetch or verify these sources:
- Chrome DevTools MCP snapshot of a blog page: ~10,220 tokens, versus ~1,866 for a viewport screenshot (dev.to).
- Hacker News comment page as a full tree: 246,690 chars.
- Playwright MCP vs CLI: ~114K vs ~27K tokens per task (morphllm).

No project publishes per-page token numbers for its own format. Scopos should measure its own with the Anthropic `count_tokens` API.

---

## 10. What Scopos should change (implementable)

1. **Stable ids across snapshots (Playwright `_ariaRef` pattern).**
   - Keep `const refs = new WeakMap<Element,{id:number, role:string, name:string}>()` and a session counter that never resets.
   - Reuse an element's id while its role and name are unchanged. Otherwise mint a new one.
   - Effects: ids stay valid across re-scans; you can mark `*` on new ids (browser-use) and send diffs (item 9); and a cached answer's id can be checked cheaply.
2. **Visibility rule.**
   - Base rule: `el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})` and `getComputedStyle(el).visibility === 'visible'` and a client rect at least **3×3 px** (Vimium and Skyvern).
   - `display:contents`: visible if any child is visible.
   - Treat `clip: rect(0px, 0px, 0px, 0px)` / `rect(1px, 1px, 1px, 1px)` as hidden (Skyvern).
   - Skip elements with `pointer-events:none` on themselves or the nearest ancestor that sets it (Playwright `receivesPointerEvents`), and elements under `[inert]`.
   - **Occlusion:** for elements in the viewport, call `elementFromPoint` at the center, then at the 4 corners inset 1 px. Keep the element if any hit `contains(el)` or is contained by it, recursing into `hit.shadowRoot`. Use the middle client rect for multi-line links (browser-use legacy).
   - Don't drop off-screen elements. Tag them as off-screen instead (item 6).
3. **Modal scoping.** If a `dialog:modal`, `[aria-modal="true"]` or `[role=dialog]` element is visible and on top (it passes the occlusion test at its center), send **only its subtree**. Playwright treats everything outside the topmost modal as inert. This cuts tokens to almost nothing and removes wrong answers behind overlays.
4. **Interactive detection additions.** Add to the current selector list:
   - `summary`, `details`, `[contenteditable]:not([contenteditable=false])`, `label` whose `.control` is enabled (only when the control itself is hidden, as with custom checkboxes), `[jsaction*="click:"]`, `[ng-click],[data-ng-click]`, `option` inside a visible listbox.
   - Roles to add: `switch, menuitemcheckbox, menuitemradio, combobox, searchbox, slider, spinbutton, treeitem, gridcell, option`.
   - Fallback 1: elements whose computed `cursor === 'pointer'` and whose parent's cursor is **not** pointer. Only the outermost pointer element counts.
   - Fallback 2: class matches `/\b(btn|button)\b/i` (Vimium "possibleFalsePositive").
   - Skip anything with `aria-disabled="true"`, `disabled` or `inert`. Better for a guide: keep it, but emit a `disabled` state so Claude can say "the button is disabled until …".
5. **Nested-duplicate dedupe** (browser-use bbox rule + Vimium false-positive rule).
   - If a candidate's rect is at least **99%** inside an ancestor candidate that is `a`, `button`, or `[role=button|link|combobox|menuitem|tab]`, drop the descendant.
   - Exceptions: form controls, `label`, elements with their own `aria-label`, and elements with an interactive role.
   - Drop a class-based or `span` candidate if it contains a real control within 3 levels.
6. **Viewport budget and off-screen hints.**
   - Include everything in the viewport plus **±1 viewport height** (browser-use uses ±1000 px).
   - For the rest of the page, emit one summary line per section, e.g. `… 14 more controls below (~2 screens): "Экспорт", "Удалить", …` (browser-use `~N pages down` hint).
   - Add `[Start of page]` / `[End of page]` and `X screens above / Y below`.
7. **Accessible name: follow accname order** (Playwright `roleUtils`).
   - Order: `aria-labelledby` → `aria-label` → native (`<label>`, button `value`, `alt`, `legend`, `figcaption`) → content (only for roles that allow name from content) → `title` → `placeholder` (only when there is no `title`).
   - Clean the text: remove **U+E000–U+F8FF** (icon-font glyphs, Stagehand `cleanText`) and U+200B/U+00AD, collapse whitespace and NBSP to one space, and cap at **80 chars** (browser-use caps at 100).
   - For icon-only controls with an empty name, fall back to `title`, the `aria-label` of an inner `svg`/`img`, or `img alt`. browser-use reads up to 3 child images (alt, title, aria-label, src filename).
8. **Token-lean line format.** Go hierarchical, as Stagehand and Playwright do: print the section once and indent its controls under it, instead of repeating `· Счета` on every line.
   ```
   # Счета
     12 button "Новый счёт" current
     13 link "Архив"
   # Фильтры
     20 combobox "Статус" =Все (5 options: Все, Черновик, Оплачен, …)
     21 textbox "Поиск" placeholder="Номер или клиент"
   ```
   - Keep the role on every line. Drop `placeholder`/`title` when they equal the name, and drop `type`/`role` when they equal the tag (browser-use dedupe rules).
   - Show only state words that apply: `current, selected, checked, expanded, collapsed, disabled, required, invalid`.
   - For `select`, show the current value, the option count, and the first 4 options truncated at 30 chars (browser-use).
   - Never send values of password, hidden or file inputs, or of `autocomplete=cc-*` / `one-time-code` fields.
9. **Diff and "new" marking for follow-up steps.**
   - After the user acts (e.g. opens a dropdown), re-scan and send only the elements that are new or changed, prefixed with `*`, plus the previous answer's target.
   - Stagehand sends only `diffCombinedTrees` for step 2 of two-step actions, and browser-use marks new elements with `*`.
   - This needs item 1 to work.
10. **Pre-ranking when the page is big** (LaVague `OpsmSplitRetriever`).
    - If the page has more than ~150 candidates, BM25- or trigram-score each element's `name + placeholder + section + role` (≤200 chars) against the user's question.
    - Send the top 60 plus all controls in the current section and in any open dialog.
    - Keep a hard char cap, e.g. 12,000 chars. browser-use's cap is 40,000, but for a single "find one control" question a much smaller budget is enough. Measure with `count_tokens`.
11. **Shadow DOM and iframes.**
    - Walk the flattened tree: for each element, use `slot.assignedElements({flatten:true})` and open `shadowRoot` children, as Playwright does.
    - For same-origin `iframe.contentDocument`, recurse and prefix ids with the frame (`f1:12` style, as in Playwright `f1e12` and Stagehand `0-123`).
    - Skip iframes under 10 px. Cap at 100 frames and depth 5 (browser-use limits).
12. **Strict grounding in the prompt and validation.**
    - Require the model to copy the id exactly, to return `null` when nothing matches ("do not fabricate", Stagehand), and to return a short `description` of the target with every id (Playwright MCP sends `element` with every `target`).
    - On the client, reject ids not in the current map.
    - If the returned `description` doesn't fuzzy-match the element's name (ratio < 0.5), treat the answer as suspect and re-ask once.
13. **Descriptor = semantic first, CSS last** (workflow-use moved CSS and xpath to "LEGACY").
    - Store: `{role, name, section, nth (index among same role+name in section), testid, id, nameAttr, ariaLabel, href(path only), stableHash, xpath}`.
    - `stableHash` = hash of tag path + static attributes, with class tokens matching `focus|hover|active|selected|disabled|animation|transition|loading|open|closed|expanded|collapsed|visible|hidden|pressed|checked|highlighted|current|entering|leaving` removed (browser-use `compute_stable_hash`).
    - Also filter auto-generated ids, e.g. `/^:r\w+:$|\d{4,}|[a-f0-9]{8,}/`. browser-use doesn't do this; it's our addition.
14. **Re-find cascade with a uniqueness check.** Each level must yield **exactly one** visible candidate; ambiguity falls through to the next level (workflow-use lacks this check, and that is a known flaw):
    1. `data-testid` / `data-test` / `data-cy`
    2. Stable `id`
    3. `stableHash`
    4. `role + exact name` (scoped to `section` if ambiguous, then `nth`)
    5. `aria-label` / `name` attribute / `placeholder`
    6. xpath
    7. fuzzy name: `SequenceMatcher`-style ratio **≥ 0.8** (workflow-use threshold) within the same role, best score must lead the runner-up by ≥ 0.1

    If all levels fail → self-heal (item 15).
15. **Answer cache with self-heal** (Stagehand ActCache, Skyvern code caching).
    - Key: `sha256(normalize(question) + origin + routeTemplate(path) + uiLang)`.
      - Normalize the question: lowercase, trim, collapse spaces, strip punctuation.
      - `routeTemplate`: replace numeric, UUID and hex path segments with `:id` and drop the query string, because Stagehand docs warn that tracking params break keys.
      - Optionally include a hash of the scoped control list (role+name of the top ~50 visible controls) so the key changes when the screen changes, like Browserbase's page-content key.
    - Value: the step list with descriptors (item 13) and the model's descriptions.
    - On a hit: re-find each step's target with the cascade, with no LLM call.
    - On success, if the descriptor changed (e.g. a new xpath), rewrite the entry under the same key (Stagehand `haveActionsChanged`).
    - On failure of any step: one LLM call with the stored step description as the instruction, over a scan scoped to that step's section. Retry once, then update the entry (Stagehand self-heal).
    - Keep variable **names**, not values, in the key (Stagehand docs).
16. **Per-scan caches.** During one scan, memoize `getComputedStyle`, `getBoundingClientRect` and `getClientRects` in WeakMaps, and clear them at the end (browser-use legacy and Playwright `beginAriaCaches`/`endAriaCaches`). Scan once per user question, not per keystroke.
