# Frigade and DAP vendors: how they make AI in-product guidance fast, cheap and accurate

Research date: 2026-10-16. Scope: Frigade (primary), WalkMe, Whatfix, Pendo, Appcues, Userflow, Userlane, Chameleon, Command AI (CommandBar), plus open-source and academic work on robust element location (Similo, Healenium, browser-use, Stagehand, Floating UI).

How sure each claim is:
- **[doc]**: stated in the vendor's public docs, marketing or blog.
- **[code]**: read from the vendor's published npm bundle (minified JS on unpkg). I read the bundles through an automated summarizer, so identifiers and constants are as reported by that pass. They are very likely right, but check them against the bundle before relying on any exact number.
- **[inference]**: my interpretation, not stated anywhere.
- **[unconfirmed]**: I looked and found no public evidence.

---

## Part 1: What they do

### 1. Frigade (Assistant and Assist API)

**Product shape and pricing [doc]**
- The Assistant is an in-product AI that answers questions, runs walkthroughs on the live screen (multi-page, through modals) and runs "Skills" (actions). The Assist API puts the same engine behind one tool call, `query({ intent })`, for a customer's existing agent. Sources: https://frigade.com/ , https://frigade.com/assist-api
- Pricing for Growth is "from $1,000/month" with **2,500 queries** and 2 "product agents". That works out to about **$0.40 per included query**. Enterprise is custom and adds self-hosting with your own LLM keys. Source: https://frigade.com/pricing
  - The $0.40 is my own arithmetic, not a published price. The unit price implies a heavy per-query budget, which matches the large page payload they send (see below).
- Production stats (vendor blog) [doc]:
  - About **35% of assistant responses are guided walkthroughs**; the rest are text.
  - About **70% of walkthrough sessions had at least one step the user advanced**.
  - Of users who come back, about 62% ask three or more questions.
  - Source: https://frigade.com/blog/state-of-in-product-ai-2026

**How it learns the product [doc]**
- "A browser agent signs in with the same permissions a real user has" and works through workflows. No manual screenshots are needed. Each role or persona gets its own agent and login. Sources: https://frigade.com/how-it-works , https://frigade.com/blog/your-product-cant-explain-itself
- Help-center docs, internal docs and public release notes are added for policy and context the UI does not show.
- Re-learning runs on a schedule, on demand after a release, or as a manual retrain. "Frigade discovers changes during product learning without a change list." Source: https://frigade.com/features/always-accurate
- Skills (actions) are also learned by using the product. A human must approve them, and they run with the signed-in user's permissions. Source: https://frigade.com/blog/answering-is-the-easy-half
- How changes are detected is **[unconfirmed]**. So is the format of the learned knowledge.
  - The response field `sourcesUsed.type ∈ {evaluatedQueries, relevantDocs, otherPages, currentPage}` [code] suggests retrieval over a store of learned pages plus the docs, with the live page added on top. **[inference]**

**Key architectural claim [doc]: no stored selectors**
- From "Static onboarding tours break" (https://frigade.com/blog/onboarding-tours-break): "the agent re-resolves against the live product on every run, so there's no stored selector to break".
- Steps are recorded as *intent*, for example "click the primary CTA in the billing card", not as an element.
- The same post claims that about half of hand-built tours break within six months. That is a vendor estimate.

**What the client SDK actually does [code]**

Packages: `@frigade/assist-api@1.3.0` and `@frigade/assistant@1.2.0`.
- Assist API bundle: https://unpkg.com/@frigade/assist-api@1.3.0/dist/index.mjs
- Assistant bundle: https://unpkg.com/@frigade/assistant@1.2.0/dist/index.mjs
- Package metadata: https://registry.npmjs.org/@frigade/assist-api/latest
- Dependencies include `ai` (Vercel AI SDK v6), `@ai-sdk/react`, `zod`, `sizzle`, `jsonrepair`, `@floating-ui/react`, `json-logic-js`.

1. **The live page goes up with every query.**
   - The request to `POST {apiUrl}/v2/public/query/stream` (AI SDK `useChat` with `DefaultChatTransport`) carries `currentPage = { base64HTML, hostname, title, relativeUrl }`, plus `sessionId`, `assistantId`, `tools` and `mode`.
   - The HTML is a cleaned clone of `document.body`. A `trackOriginals` WeakMap maps each clone node back to its live node.
2. **Cleaning rules for the snapshot**
   - **Elements removed:**
     - `script`, `style`, `noscript`, ad and cookie-banner classes, the SDK's own root, and comments.
     - In a second pass: `iframe`, `canvas`, `video`, `audio`, `object`, `embed`, `.modal-backdrop`, `.tooltip`, `.popover`.
     - Elements that fail `checkVisibility({opacityProperty, visibilityProperty})`.
     - `img` elements with no `src`, `alt` or `title`.
     - Empty `div`, `span` and `p` elements, repeatedly until nothing changes.
   - **SVGs** are kept, but their inner markup is cleared.
   - **Attributes removed:**
     - `on*` handlers, `class` and `style`.
     - Any attribute whose name contains color, width, height, size, font, border, margin or padding.
   - **`id` heuristic:** an `id` is kept only if it does not look generated. Generated patterns include `css-`, `sc-`, `react-`, `:r`, hex runs of 8 or more characters, and utility prefixes.
   - **Attributes kept:** `name`, `type`, `href`, `alt`, `title`, `value`, `placeholder`, `src`, `aria-*`, `role`, `data-testid`, `disabled`, `hidden`, `tabindex`. Other `data-*` attributes are kept unless the value looks like a hash.
   - **Value handling:** attribute values are truncated to 128 characters, and inline base64 is replaced with `[base64-data-removed]`.
   - **Shadow DOM and iframes:** open shadow roots are inlined as a synthetic `<shadow-root>`. Iframes are not traversed.
   - **Privacy:**
     - `[data-fr-ignore]` subtrees become `[[redacted TAG for user privacy]]`.
     - No special masking of password `value` was seen. That is a gap we should not copy.
3. **Size cap.** If the cleaned HTML is over 100,000 characters, they keep the first ~94,980 characters (cut at a `>`), add `<!-- [truncated] -->`, and append the last 5,000 characters. Encoding is UTF-8 then `btoa`, with **no compression**.
4. **Server response schema (zod)**
   - Top level: `{ conversationTitle, responseType: guide|answer|reject|tool-call|clarify, steps[], parts, anchoredParts, sourcesUsed[] }`.
   - Each step: `{ explanation, querySelector: string|null, textSelector: string|null, confidenceScore: number|null, relevantUrls[] }`.
   - The LLM therefore returns **a CSS selector and/or an exact visible text** per step, resolved against the live page. No element IDs are injected before sending.
   - `confidenceScore` is in the schema, but **no client-side threshold was found** in either bundle.
5. **Resolving a step to an element (`Ui`)**
   1. Run `querySelector` (through Sizzle, with a custom `:visible` pseudo based on viewport intersection).
   2. If exactly one visible match, use it.
   3. If several match, scope the query to the open modal (`Li`). It checks these in order and takes the first visible match: `[role=dialog]`, `[role=alertdialog]`, `[aria-modal=true]`, `.modal.show`, `.modal.in`, `.v-dialog.v-overlay--active`, `.mdc-dialog--open`, `.is-open`, `.open`, `.active`, `:popover-open`.
   4. Otherwise fall back to `textSelector`: case-insensitive exact `textContent.trim()` equality, keeping only the **innermost** matching elements that intersect the viewport.
   5. The match is tagged `data-frigade-anchor="tour-step-N"`.
6. **Re-resolution when the DOM changes**
   - A `MutationObserver` on `document.body` (childList, subtree, plus attributes `class`, `hidden`, `aria-hidden`, `open`, `style`) re-runs the lookup, debounced with `requestAnimationFrame`.
   - If a target is missing for **500 ms**, the pointer flies to a fallback anchor.
   - After **10 s** without completing a flight, it forces an "at-rest" state.
   - Waiting for the whole guide response times out at **60 s**.
7. **Step advance by real click**
   - A capture-phase `document` click listener checks whether the click target is the step element, or an ancestor or descendant within **2 levels** (`Vi(n, r, 2)`).
   - On a match it advances.
   - The last step completes on click only if `completeLastStepOnTargetClick`.
8. **Auto-scroll**
   - `scrollIntoView({behavior: "smooth", block: "center", inline: "nearest"})`, with `scrollMarginBottom` set to the height of the assistant UI or any fixed/sticky bottom bar.
   - It walks scroll ancestors (`overflow: auto|scroll|hidden|clip|overlay`, stopping at `position: fixed`) to compute the visible clip rect.
   - If the element is still clipped, it retries: **max 2 attempts**, a **1200 ms** fallback timer and a **100 ms** debounced scroll listener.
   - No sticky-header *top* offset was found **[unconfirmed]**.
9. **Positioning the ring and pointer**
   - The ring is a fixed-position SVG rounded-rect path. It reads `getBoundingClientRect()` and the element's `border-radius` via `getComputedStyle`, and updates on a `ResizeObserver` on the anchor, `window` resize, and capture-phase passive scroll, all throttled with rAF. The dash animation runs about 666 ms.
   - The pointer is `translate3d(x-12px, y-12px)` to the element centre, re-measured every frame ("trackToSelector").
   - **Flight:** a cubic Bézier path, default **400 ms**.
   - **Movement handling:** if the target moves more than **0.5 px** (`moveEpsilonPx`), the pointer enters "hovering". After **200 ms** settle (`settleMs`) it re-launches.
   - **Bobbing:** amplitude **2.5 px**, period **1400 ms**.
   - Tooltip cards use Floating UI `autoUpdate` with `offset`, then `flip({padding: 8})`, then `shift({padding: 8})`.
10. **Occlusion check**
    - The bundle samples a grid every **32 px** over the target with `document.elementsFromPoint`.
    - If **≥ 15%** of samples are covered by something else (`minCoveredFraction`), it fires `onTargetOccluded`.
    - The assistant panel also moves itself out of the target's way: 42 px padding, docking top or bottom depending on the target's midpoint.
11. **Navigation**
    - Route changes are detected by patching `history.pushState` and `replaceState` (guarded by `__frigadePatched`), plus `popstate`, `hashchange`, and the Navigation API `navigate` and `currententrychange` events.
    - One component also polls `location` and `title` every **2000 ms** and POSTs page state to `/v2/public/record`. It also stores the clicked element's `outerHTML`, truncated to 1000 characters, in sessionStorage. This looks like real-usage telemetry **[inference]**.
    - Multi-page steps navigate with `location.assign` unless the host registers a `navigate` handler (for SPA routers).
12. **Latency tricks**
    - The response streams, with `experimental_throttle: 50`.
    - Each partial chunk is repaired with `jsonrepair` and rendered progressively. The step currently streaming is marked `inProgressSelectorStreaming`.
    - The client **stops reading the stream as soon as `"sourcesUsed":` appears**, which treats the JSON as complete for the user.
    - Sizzle is lazy-loaded (`import()`).
    - Assistant state is cached in sessionStorage for 5 minutes, written with a 100 ms debounce.
    - Suggestions use `preComputedTargeting`, evaluated client-side (`json-logic-js`), so no server round-trip is needed to decide what to suggest.
13. **Animation design** [doc, https://frigade.com/blog/a-good-animation-disappears]
    - A dot plus a pulsing ring, sitting **12 px** off the element edge so the target stays readable.
    - **2 s** pulse that scales up and fades on ease-out; **200 ms** fade-in.
    - **No screen dimming and no click blocking.**
    - Between steps, one beacon "flies" along a curved path: take-off on ease-out-cubic, landing on sine easing.
    - They admit it does not yet honour `prefers-reduced-motion`.
    - Their site curves (https://frigade.com/blog/two-easing-curves-no-animation-library): `cubic-bezier(0.23, 1, 0.32, 1)` for entrances (480 ms) and `cubic-bezier(0.32, 0.72, 0, 1)` for interactions (150 to 220 ms).

**Cost: what is and isn't known**
- No per-query cost, model name, caching or latency figures are published **[unconfirmed]**.
- From the code: every query ships up to 100k characters of HTML (roughly 25k to 30k tokens) and never caches an answer client-side.
- So Frigade appears to buy accuracy with a large context per query, not with precomputed answers. Learning ("product agents") is the offline cost. **[inference]**
- Self-hosting with your own keys moves the LLM bill to the customer.

### 2. WalkMe

- **Classic engine [doc]**
  - Elements are identified by a mix of text, on-page position, and HTML attributes (ID, class).
  - Authors can tick "ignore ID", "ignore position" or "ignore text" when one of them is unstable.
  - Match modes are Automatic (default), "Identify by text" (exact; "Feature" vs "Features" breaks it) and jQuery selector (discouraged).
  - An **"Element Grade"** warns when the element's attributes are not distinctive compared with the rest of the page.
  - The "Lexicon" maps text variants and translations.
  - Screenshots of the element at creation time can be stored to help authors fix it.
  - Sources: https://support.walkme.com/knowledge-base/walkme-cant-find-an-element-on-the-page/ , https://support.walkme.com/knowledge-base/find-element-basic-troubleshooting-tips
- **DeepUI [doc]**
  - At authoring time it generates "a detailed description of the element" **and its surrounding elements** (no PII).
  - At runtime it analyses the DOM, re-locates the element after UI changes, and "updates the element mapping".
  - In DeepUI mode the precision and element-grade settings were removed.
  - WalkMe claims it learns across customers.
  - The algorithm, features and thresholds are **[unconfirmed]**.
  - Source: https://support.walkme.com/knowledge-base/deepui-element-recognition/
- WalkMe patent US 12,405,809 B2 (alternative representations of GUI elements) exists. I could not read its claims **[unconfirmed]**.

### 3. Whatfix

- **Diagnostics status machine [doc]:** Searching → Found → Displayed, or Not Found.
- **Diagnostics error codes [doc]:**

  | Code | Meaning |
  |---|---|
  | PROP_001 | Unique properties saved at creation have changed |
  | PROP_002 | Configured HTML properties are missing from the page |
  | CSS_001 | The configured CSS selector is wrong or missing |
  | CSS_002 | The auto-generated CSS selector no longer exists |
  | ETO_001 | Search timed out |
  | ATAG_001 | Auto-tag failed to identify the element |

  Visibility rules are checked separately (Where, When Start, When End, Who). Source: https://support.whatfix.com/docs/troubleshoot-smart-tips-using-whatfix-diagnostics-1
- **Auto-fix CSS [doc]:** a "Selected element is unreliable" banner appears when the element has no stable or unique identifier. Re-selecting **adds the new selector with an OR** to the existing one, so old and new both work. Source: https://support.whatfix.com/docs/auto-fix-css-selector-issues-in-studio
- **ScreenSense Auto-heal (beta) [doc]** (source: https://support.whatfix.com/docs/screensense-auto-heal)
  - **Trigger:** runs only *after* a runtime "element not found".
  - **Capture:** page structure, application metadata, DOM context and screenshots, all PII-masked at HTML and image level.
  - **Matching:** a vision-based model compares the authoring-time element with the current state, using visual appearance, surrounding context, element relationships and structural similarity.
  - **Apply rule:** a repair is applied only at "sufficient confidence" (threshold **[unconfirmed]**).
  - **Persistence:** the repair is stored in a **separate runtime layer** (published content is not modified) and applied for **all later users**.
  - **Limitations:** the first user still sees the failure; iframes are not supported.

### 4. Pendo

- **Guide targeting [doc]:** "Suggested Match" auto-generates the most stable CSS selector. Authors can switch to the parent element or to custom CSS. Pendo supports `:contains('text')` and attribute operators (`^=`, `$=`, `*=`) for dynamic IDs.
- **Selector speed matters [doc]:** Pendo evaluates selectors frequently, and three green "strength bars" means **< 5 ms**.
  - Cost order, fastest to slowest: id → class → tag → combinators → shadow DOM → custom attributes → `:contains`.
  - Guidance: anchor slow parts under a fast ancestor, for example `.nav-bar a:contains("New feature")`.
  - Source: https://support.pendo.io/hc/en-us/articles/28618614571547
- No technical write-up was found on Pendo AI or agent guidance **[unconfirmed]**.

### 5. Appcues, Userflow, Userlane, Chameleon

- **Appcues [doc]:** the step shows only if the saved CSS selector resolves. The Builder reports "Element valid" (exactly 1 match) or "Element not unique" (more than 1), and lets authors swap in a detected attribute. Source: https://docs.appcues.com/dev-troubleshooting/css-selectors
- **Userflow [doc]** (source: https://help.userflow.com/userflow/docs/tooltip-element-selection)
  - Generates several candidate selectors from the root down and keeps the most reliable one.
  - A **Loosest ↔ Strictest** slider sets how closely attributes and text must match.
  - "Element text" matching, with a "Dynamic text" option to ignore text.
  - "If multiple matches": pick the Nth match, or **Nearest element** to a chosen reference element.
  - Developers can exclude generated class and ID patterns and prefer `data-testid`.
- **Userlane [doc]:** a structured selector object with `orderNum` and `content: {type: contains|matches, value: string | string[]}`. An array value means OR across languages. Source: https://docs.userlane.com/docs/target-specific-text-for-an-element
- **Chameleon [doc]:** the Element record keeps a multi-attribute fingerprint (source: https://developers.chameleon.io/apis/elements.md):
  - `selector`, `path` (CSS path from body), `path_index`, `tag`, `text`
  - `attr_id`, `attr_class`, `attr_href`, `attr_title`, `attr_type`, `attr_name`, `attr_data`, `attr_aria_label`, `attr_aria_labelledby`
  - `arity` (number of children), `shadow_selector`
  - `use[]`, which lists the attributes to combine at runtime. If `use` contains `selector`, only the selector is used.
  - Runtime fallback order is **[unconfirmed]**.

### 6. Command AI (formerly CommandBar)

- Acquired by Amplitude in October 2024 (reported at more than $45M); commandbar.com docs now redirect to Amplitude Guides & Surveys. Sources: https://techcrunch.com/2024/10/15/amplitude-buys-command-ai-to-bolster-its-app-engagement-offerings , https://amplitude.com/press/amplitude-acquires-command-ai
- Copilot was trained on the help center or other sources. It could suggest "Nudges" (tours) when a short **Copilot description** on each nudge matched, which amounts to a retrieval index of pre-authored tours. Products included "AI co-browsing" (mechanism **[unconfirmed]**). Source: https://www.langchain.com/blog/langchain-partners-with-commandbar-on-their-copilot-user-assistant
- **Engineering lessons [doc]:** retrieval quality drove answer quality. Automated evals over known-good question and answer pairs raised test coverage about 5x per change.
- No cost or latency data was published.

### 7. Academic and open-source element robustness (directly reusable)

- **Similo** (Nass, Alégroth, Feldt, Leotta, Ricca, ACM TOSEM 2023; https://arxiv.org/abs/2208.00677)
  - **Scoring:** each candidate is scored against the recorded target over 14 parameters: Tag, Class, Name, Id, HRef, Alt, Absolute XPath, ID-relative XPath, IsButton, Location, Area, Shape, Visible Text, Neighbor Texts.
  - **Comparators:**
    - Exact, case-insensitive match for Tag, Id, Name and IsButton.
    - **Normalized Levenshtein** for Class, HRef, Alt, the two XPaths and Visible Text. Visible Text is the first non-blank of text, value, placeholder.
    - **Location:** 1 at the same spot, 0 beyond **100 px**, linear in between.
    - Area (w·h) and Shape (w/h) by distance.
    - **Neighbor Texts:** share of words in common with nearby elements' visible text (5 of 10 → 0.5).
  - **Weights:** **1.5** for the stable group (Tag, Name, Id, Visible Text, Neighbor Texts) and **0.5** for the rest. The full per-parameter table is in a figure I could not extract, so the exact split for the other 9 is **[unconfirmed]**.
  - **Score:** the weighted sum; the highest score wins. The paper discusses (without fixing) a minimum-score threshold.
  - **Results:** about 11 to 12% localization failures vs 24 to 27% for the best multi-locator baseline. About **3 ms** per lookup and 0.01 to 0.02 ms per candidate comparison.
- **VON Similo LLM** (https://arxiv.org/abs/2310.02046): GPT-4 picks among the top-ranked Similo candidates. Failures dropped from 70 to 39 (−44%), at higher time and cost.
- **Healenium** (https://github.com/healenium/healenium-web):
  - On failure, proposes healed locators and applies one only if the score is ≥ `score-cap` (example 0.5); `recovery-tries` is 1.
  - Healed locators are stored server-side.
- **Progress Software patent US11709768B1**, "self-healing hybrid element identification" (https://patents.google.com/patent/US11709768):
  - Ranked identifiers: primary (attributes or text), secondary (image), tertiary (XPath or index).
  - **All identifiers are evaluated even when the primary succeeds**, so a broken secondary is repaired from the one that worked before it is ever needed.
  - Image match tolerance example: a difference of ≤ 50%.
- **browser-use DOM serializer** (https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/dom/serializer/serializer.py):
  - Indexes only interactive and visible elements, written as `[idx]<tag attrs/>`.
  - Drops text hidden under modals using paint order.
  - **Merges children that are ≥ 99% inside a clickable parent.** Exceptions: inputs, labels, `onclick`, `aria-label`, interactive roles.
  - Caps attribute values at 100 characters and shows the first 4 select options (30 characters each).
  - Marks newly appeared elements with `*`, never emits password values, and summarises off-screen elements as "N more below, ~N pages down".
- **Stagehand** (https://docs.stagehand.dev/v3/best-practices/caching , https://docs.stagehand.dev/v3/basics/observe):
  - `observe()` returns `{description, method, arguments, selector(xpath)}` once. Replaying it with `act()` needs no further LLM calls.
  - **Cache key:** instruction + URL (tracking params removed) + page content + options. A DOM change gives a MISS, which falls back to the LLM and writes a new entry.
  - Scoping to a subtree cuts tokens "up to 10x".
- **Floating UI `autoUpdate`** (https://floating-ui.com/docs/autoUpdate):
  - Default triggers: `ancestorScroll`, `ancestorResize`, `elementResize` (ResizeObserver) and `layoutShift` (IntersectionObserver).
  - `animationFrame` is off by default; use it for transform-animated anchors.
  - About 1 ms per update. Only run it while the floating element is mounted.

Not researched in depth or not found: Usetiful, Userpilot AI, Adept, MultiOn and CopilotKit internals. The CopilotKit docs landing page has no element-pointing feature; it exposes app state and front-end tools to the agent. **[unconfirmed beyond that]**

---

## Part 2: Concrete techniques we should copy

1. **Send a compact, cleaned live-DOM snapshot with every query, and make the LLM answer with selectors resolved on the live page (Frigade model).**
   - Clone `document.body` and keep a `WeakMap<clone, live>`.
   - Drop: `script`, `style`, `noscript`, `iframe`, `canvas`, `video`, `audio`, `object`, `embed`, comments, our own root, tooltip and popover backdrops, and anything failing `el.checkVisibility({opacityProperty: true, visibilityProperty: true})`.
   - Collapse `<svg>` to an empty tag.
   - Remove `class`, `style`, `on*`, and any presentational attribute.
   - Keep `id` (only if it does not match generated patterns: `/^(css-|sc-|react-|:r|ember\d|[a-f0-9]{8,})/i`), `name`, `type`, `href`, `alt`, `title`, `placeholder`, `role`, `aria-*`, `data-testid`, `disabled`, `tabindex`, and `data-*` whose values do not look like hashes.
   - Truncate attribute values to 128 characters and strip `data:` URIs.
   - Remove empty `div`, `span` and `p` until nothing changes.
   - **Improve on Frigade:** never send `value` for `password`, `email`, `tel` or `autocomplete=cc-*` inputs; honour `[data-scopos-ignore]`; inline open shadow roots.
   - Cap at about 60k characters. Keep the top 95% and the last 5k (Frigade uses 100k).
   - Use the `CompressionStream('gzip')` body when available. Frigade sends uncompressed base64, which wastes about 33%.

2. **Make the per-step answer schema dual-locator plus confidence.**
   - Use `{explanation, querySelector|null, textSelector|null, role|null, confidence 0..1, url|null}` (Frigade's shape plus role and url).
   - Validate with zod.
   - **Client resolution order:**
     1. Run the CSS selector and keep visible matches.
     2. If there is exactly one, use it.
     3. If there are several, scope to the topmost open dialog (`[role=dialog]`, `[role=alertdialog]`, `[aria-modal=true]`, `:popover-open`, then framework modal classes) and retry.
     4. Otherwise match text: case-insensitive, whitespace-collapsed `textContent` equality (then `aria-label`, `title`, `placeholder`), keeping only the innermost matches, preferring an interactive ancestor (`button, a, [role=button|menuitem|tab|link], input, select, textarea, label`), and preferring in-viewport matches.
     5. If there are still several, pick the one closest to the previous step's element (Userflow's "nearest element").
   - **Confidence:** use `confidence < 0.5` as "show text only, no ring". Frigade ships the field but no client threshold, so this number is ours and should be tuned on evals.

3. **Number the elements in the snapshot so the LLM can answer "#17" (browser-use style), and derive the stable selector client-side.**
   - Before sending, assign `data-sc-i="N"` on the clone only to interactive and visible elements. Merge a child into a clickable parent when it is ≥ 99% contained, unless it is an input, label, `[onclick]`, `[aria-label]` or has an interactive role.
   - The LLM returns `index` plus `textSelector` as backup.
   - The client maps the index to the live element through the WeakMap, so no selector generation is needed for the current page.
   - For future pages or cached guides, generate a fingerprint (item 4) from that live element.
   - This removes selector-hallucination failures. A selector the LLM invents can be syntactically valid and still wrong.

4. **Store a multi-attribute fingerprint for every element we ever point at, and re-find it with a Similo-style weighted score.**
   - **Fingerprint:** `{tag, id, name, role, type, href, ariaLabel, testId, text (visible text, value or placeholder, max 80 characters), neighborText (words of visible text within the nearest labelled ancestor, siblings, and the closest heading, max 20 words), cssPath, idRelativePath (path from the nearest stable-id ancestor), isButton, rect {x, y, w, h} normalised to viewport, landmark (nearest nav/main/aside/header/dialog with its aria-label)}`.
   - **Score:**
     - Weight 1.5 when `tag`, `id`, `name`, `testId` or `role` match exactly.
     - Weight 1.5 for text and ariaLabel by normalised Levenshtein.
     - Weight 1.5 for neighborText by word-overlap ratio.
     - Weight 0.5 for href and the two paths by normalised Levenshtein.
     - Weight 0.5 for location: 1 at the same spot, 0 beyond 100 px, linear.
     - Weight 0.5 each for area ratio and aspect ratio.
     - Weight 0.5 for isButton.
   - **Normalise:** `score / sum(weights of attributes present in the fingerprint)`.
   - **Accept:** best ≥ 0.75 **and** (best − second) ≥ 0.10. If 0.5 ≤ best < 0.75, or the margin is small, send the top 3 candidates to a small LLM to choose (VON Similo LLM cut failures 44%). Below 0.5, report not found.
   - **Budget:** only score candidates with the same tag group (clickables vs inputs). Similo measured about 3 ms per lookup.

5. **Self-heal on every successful resolve, not only on failure (patent US11709768 idea plus Whatfix runtime layer).**
   - When any locator (index, CSS, text, fingerprint) finds the element, recompute all the others and write back any that no longer resolve uniquely.
   - Store heals in a **separate overlay keyed by (guideId, stepId, appVersionHash)**, never mutating the authored or learned guide. All users get the heal (Whatfix behaviour).
   - Log "heal events" as a signal that the UI changed, and use them to trigger re-learning of that flow.
   - Whatfix's OR-append is the simple version: keep a list of selectors and accept any that resolves uniquely.

6. **Cache answers and guides per (intent, page) so most queries skip the big LLM call.**
   - **Key:** `normalize(question)` (lowercase, stopwords removed, embedding nearest-neighbour ≥ 0.92 cosine to a previous question) + `route template` (replace numeric, UUID and hash path segments with `:id`) + `role/plan`.
   - **Value:** the step list with fingerprints, not raw selectors.
   - **On hit:** resolve the fingerprints locally (item 4). If every step resolves with confidence ≥ 0.75, play immediately with zero LLM tokens. Otherwise fall through to a live LLM call with the snapshot.
   - **Invalidate** on heal-failure, on 👎 feedback, or after a TTL of about 7 days.
   - This is Stagehand's cache-then-heal pattern. Frigade does not do this client-side, as far as the bundle shows.
   - Pre-warm the cache by running the "learning" crawler's questions (item 11).

7. **Stream and render progressively, and stop early.**
   - Ask the model to emit JSON with `steps` *first* and sources last. Parse partial JSON on every chunk (with `jsonrepair` or a streaming parser), throttled to 50 ms.
   - Start flying the pointer to step 1 as soon as step 1's locator is complete. Frigade marks the in-progress step `inProgressSelectorStreaming`.
   - Close the stream once the last needed field is present. Frigade aborts at `"sourcesUsed":`.
   - Time out the whole answer at 60 s with a friendly retry.

8. **Re-resolve on DOM mutation, and follow movement with cheap observers.**
   - One `MutationObserver(body, {childList, subtree, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden', 'open', 'style']})`, coalesced into at most one re-resolve per animation frame.
   - Position the ring from `getBoundingClientRect()` each rAF while a step is active. Use `position: fixed` with `transform: translate3d`, never top/left.
   - Also listen to a `ResizeObserver` on the target, `window` resize, and `document` scroll with `{capture: true, passive: true}`. The capture flag catches inner scroll containers.
   - Use Floating UI `autoUpdate` for the tooltip card, with middleware `offset(12)` then `flip({padding: 8})` then `shift({padding: 8})`. Set `animationFrame: true` only while the target is mid-transform.
   - If the target's rect moves more than 0.5 px, hold the ring for 200 ms and then re-settle, which avoids jitter during layout animations.
   - Copy the ring radius from the target's computed `border-radius`.

9. **Make auto-scroll safe in nested containers and around sticky bars.**
   1. Find scroll ancestors (`overflow-x/y ∈ {auto, scroll, overlay}`, including `hidden`/`clip` when computing clip rects), stopping at `position: fixed`.
   2. Compute the intersection of the target with every ancestor's clip rect and the viewport.
   3. If less than 90% is visible, call `scrollIntoView({behavior: 'smooth', block: 'center', inline: 'nearest'})` (`behavior: 'auto'` under `prefers-reduced-motion`).
   4. Before scrolling, set `scrollMarginTop` to the total height of fixed or sticky elements at the top edge. Detect them with `elementsFromPoint` at x = 50% for y = 1..120 px and keep those with computed `position` fixed or sticky. Set `scrollMarginBottom` the same way plus our panel height.
   5. Re-check after the `scrollend` event, with a 1200 ms fallback timer and max 2 attempts.

   Frigade sets only a bottom margin; the top sticky-header handling is our improvement.

10. **Detect occlusion and visibility before pointing.**
    - Sample a grid every 32 px over the target rect (at least the centre point) with `document.elementsFromPoint`.
    - If ≥ 15% of samples hit an element that is not the target, nor inside it, nor our overlay, treat the target as occluded. Then try closing our panel, or move our panel out of the way (42 px padding, dock top or bottom opposite the target's midpoint), or wait for a modal to close.
    - Use `IntersectionObserver` to show the ring only when the target is in view.

11. **Learn offline with a signed-in crawler, and store pages plus intent recipes, not selectors (Frigade's core idea).**
    - **Crawl:** headless browser with a per-role test account, BFS over nav links and buttons that open menus or modals. Skip destructive verbs: delete, remove, cancel subscription, pay.
    - **Per page store:** `{routeTemplate, title, headings, cleaned snapshot hash, list of interactive elements with fingerprint + label + landmark}`.
    - **Per discovered workflow store:** an intent recipe like `[{route, action: click, target: "primary button 'Change plan' in 'Billing' card", fingerprint}]`.
    - **Retrieval at query time:** top-k pages and recipes, plus the live snapshot.
    - **Change detection:** re-crawl on a schedule. Diff the fingerprint sets per route template and re-learn only routes whose set changed by more than 10%. Combine with heal events from item 5.

12. **Detect step completion from real user input.**
    - Use a capture-phase `click` listener on `document`. Advance when the event target equals the step element, or is an ancestor or descendant within 2 levels (Frigade's `Vi(n, r, 2)`), or is inside it via `contains()`.
    - For input steps, advance on `change` or `blur` with a non-empty value.
    - For navigation steps, advance on a route change matching the next step's `routeTemplate`.

13. **Handle SPA routes robustly.**
    - Patch `history.pushState` and `replaceState` once (guard flag), and listen to `popstate`, `hashchange`, and Navigation API `navigate` and `currententrychange` where available.
    - Re-resolve the current step after each route change. If the target is absent for 500 ms, show the pointer at the step's fallback anchor (the nav item leading to the right page). After 10 s, show the text instruction instead.
    - Expose an SDK `navigate(url)` hook so host apps can route without a full reload. Frigade falls back to `location.assign`.

14. **Precompute suggestion targeting client-side.**
    - Ship "suggested questions" with JSON-Logic rules (`json-logic-js`) evaluated against `{route, userProps}` in the browser. This costs zero server or LLM work per page view.
    - Debounce analytics events with per-event intervals (Frigade uses 30 min) and batch them to one endpoint.

15. **Keep selectors cheap to evaluate (Pendo).**
    - Avoid `:contains` and full-document attribute scans in hot paths. Scope text search to a landmark first.
    - Target a budget of < 5 ms per resolve (Pendo's "green").
    - Lazy-load any selector engine (Frigade lazy-imports Sizzle).
    - Prefer native `querySelectorAll`, then filter by text in JS.

16. **Use an author-time "element grade" and uniqueness check (WalkMe, Appcues).**
    - When a guide or recipe is saved, compute the match count for each locator. Mark the step "fragile" if no locator is unique and the fingerprint margin is < 0.10.
    - Surface this in the dashboard. Prefer `data-testid` or stable IDs. Allow per-step "ignore text" for dynamic labels and "ignore position" for responsive layouts.
    - Allow a `text: string[]` OR-list for multilingual UIs (Userlane).

17. **Pointer UX choices validated by Frigade.**
    - No dimmed backdrop and no click blocking.
    - Ring 12 px outside the element.
    - Pulse: 2 s, scale up and fade to 0, ease-out. Fade-in 200 ms.
    - Single pointer that flies between steps along a cubic Bézier: about 400 ms, ease-out-cubic take-off, sine landing. Idle bob 2.5 px / 1400 ms.
    - Honour `prefers-reduced-motion` by replacing flight with an instant jump and disabling the pulse. Frigade has not done this yet.
    - Curves: `cubic-bezier(0.23, 1, 0.32, 1)` for entrances and `cubic-bezier(0.32, 0.72, 0, 1)` for micro-interactions.

18. **Evaluate like Command AI.**
    - Keep a golden set of known-good question → (answer, step targets) pairs per demo app.
    - Run it on every prompt or model change, and score step-target accuracy by checking that the resolved element equals the expected fingerprint.
    - Track the "second-question rate" and the step-advance rate as production health metrics (Frigade reports about 70% of walkthrough sessions advancing at least one step).

## Open questions (unconfirmed)
- Which LLMs Frigade uses, their per-query cost, p50 latency, and whether answers are cached server-side.
- How Frigade's learner detects changes, and how it represents learned workflows.
- The exact element-scoring algorithms and thresholds at WalkMe (DeepUI) and Whatfix (Auto-heal). Only qualitative descriptions are public.
- How Command AI's "co-browsing" pointed at elements. The docs are gone after the Amplitude acquisition.
