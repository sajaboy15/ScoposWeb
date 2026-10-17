# 04 — Robust element re-identification ("self-healing locators") for Scopos

Date: 2026-10-16. Scope: how to store a durable fingerprint of a guide step's target element and find the same element again after navigation, after re-renders and after a vendor UI release.

Convention used below:
- **[verified]** means read directly in source code or in the paper/doc text (link given).
- **[recommendation]** means our design choice. It is informed by the sources, but its numbers are starting points that must be calibrated on a Scopos regression corpus (see §6).

---

## 1. TL;DR

The research and tool sources converge on the same design:

1. Generate many signals, not one selector.
2. Score **every** plausible candidate with a weighted, normalized similarity.
3. Accept only above a threshold **and** with a clear margin over the runner-up.
4. Use context (container, heading, neighbors, row key) to separate look-alikes.
5. Hand the top few candidates to an LLM, or ask the user, when the margin is thin.

The current Scopos `resolve()` is an "exact selector, else fuzzy label" scheme. It has a weak acceptance test and no notion of ambiguity. As a result it **silently picks the wrong element** in the most common real cases: duplicate labels, list rows, render-order ids, and short labels.

---

## 2. What each source does

### 2.1 Playwright selector generator [verified]
Source: [`packages/injected/src/selectorGenerator.ts`](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts). The file moved here from the older path `packages/playwright-core/src/server/injected/`.

**Scoring (lower is better).** Each token gets a score:

| Token | Score |
|---|---|
| configured test id | `kTestIdScore = 1` |
| `data-testid` / `data-test-id` / `data-test` | `kOtherTestIdScore = 2` |
| role + name | `kRoleWithNameScore = 100` (exact 105) |
| placeholder | `kPlaceholderScore = 120` |
| label | `kLabelScore = 140` |
| alt | `kAltTextScore = 160` |
| text | `kTextScore = 180` |
| title | `kTitleScore = 200` |
| text regex | `kTextScoreRegex = 250` |
| CSS `#id` | `kCSSIdScore = 500` |
| role without name | `kRoleWithoutNameScore = 510` |
| `input[name]` / `input[type]` | `kCSSInputTypeNameScore = 520` |
| tag | `kCSSTagNameScore = 530` |
| nth | `kNthScore = 10000` |
| CSS fallback path | `kCSSFallbackScore = 10000000` |

**Combining tokens.** A chain of tokens is scored by `combineScores`, as `Σ score_i × (n − i)`, so earlier tokens weigh more. Scores in the 50–300 band get a length penalty of `min(10, len/10)`.

**Search.**
- Candidates are sorted by score. Each one is queried, and the **first selector that matches only the target** wins.
- A selector that matches several elements gets an `nth=` suffix. `nth` indexes above 5 are rejected.
- The generator also tries prefixing with an ancestor selector, up to two levels deep. Text is not reused in the parent selector when the target selector already uses text.

**Retargeting.** Except for input, textarea, select and contenteditable, the target is moved up to the nearest visible interactive ancestor: a button, a link, or an element with role button/checkbox/radio/link. Scopos should do the same, so that a click on an inner `<span>` is stored as the button.

**`isGuidLike(id)`.**
- Skips `-` and `_`.
- Classifies each remaining character as lower, upper, digit or other.
- Counts type transitions, except that upper→lower does not count (to allow CamelCase).
- Treats the id as generated when `transitionCount >= id.length / 4`.
- Generated ids are never used as `#id` candidates.

**Text handling.**
- Full text is a candidate only if it is 80 characters or fewer.
- Alternatives strip leading or trailing numbers and trim to 80 and then 30 characters at word boundaries.
- Names made only of private-use characters (icon fonts) are ignored.

**CSS fallback.** Walks up from the element: use the id if it is unique; otherwise add classes until the selector is unique; otherwise use the tag plus `:nth-child`.

### 2.2 @medv/finder [verified]
Source: [`antonmedv/finder/finder.ts`](https://github.com/antonmedv/finder/blob/master/finder.ts).

**Per-level candidates ("knots") and their penalties:**

| Candidate | Penalty |
|---|---|
| `#id` | 0 |
| `.class` | 1 |
| `[attr=value]` | 2 |
| `tag` | 5 |
| `tag:nth-of-type` | 10 |
| `tag:nth-child` | 50 |

**Search.**
- Paths are built bottom-up and sorted by total penalty. A path is accepted when `querySelectorAll` returns exactly one element.
- `optimize()` then tries dropping intermediate levels while the path stays unique.
- Defaults: `seedMinLength 3`, `optimizedMinLength 2`, `timeoutMs 1000`, `maxNumberOfPathChecks Infinity`.
- On timeout it falls back to a pure `nth-of-type` path.

**`wordLike(name)`.** This check gates ids, classes and attribute values. A name passes when:
- it matches `/^[a-z\-]{3,}$/i`;
- after splitting on `-` and capital letters, every part is longer than 2 characters;
- no part contains 4 or more consecutive non-vowels.

So `css-1x2y3z`, `sc-bdVaJa` and `jss12` all fail. This is a cheap and proven hashed-name filter.

### 2.3 css-selector-generator [verified, README]
Source: [fczbkk/css-selector-generator](https://github.com/fczbkk/css-selector-generator).

- Selector types are `id`, `class`, `tag`, `attribute`, `nthchild` and `nthoftype`. Their order sets the priority.
- Supports a `blacklist` and a `whitelist` (regex, wildcard string or function), `combineWithinSelector` and `combineBetweenSelectors` (both default `true`), `maxCombinations`, `maxCandidates` and `includeTag`.
- Fallback: at each level it uses the shortest unique selector, otherwise `*`, and finally an `:nth-child` chain.
- Like finder, it is a **generator of one unique selector**. Neither library heals; they only make the first selector less fragile.

### 2.4 Testing Library query priority [verified]
Source: [testing-library.com/docs/queries/about/#priority](https://testing-library.com/docs/queries/about/#priority). This also applies to Cypress Testing Library.

1. **Accessible to everyone:** `getByRole` (with name), `getByLabelText`, `getByPlaceholderText`, `getByText`, `getByDisplayValue`.
2. **Semantic:** `getByAltText`, `getByTitle`.
3. **Test IDs:** `getByTestId`, used only when the above can't work, for example when the text is dynamic.

What this means for us: role + accessible name is the primary *semantic* identity. Test ids are an excellent *stability* signal when present, but the vendor may not ship them.

### 2.5 Healenium [verified from source]
Sources:
- [healenium-web](https://github.com/healenium/healenium-web) (`HealingService.java`)
- [How Healenium works](https://healenium.io/docs/how_healenium_works)
- The `tree-comparing` library, read from the sources jar on [Maven Central](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.11/) (classes `LCSPathDistance`, `HeuristicNodeDistance`, `PathFinder`)

**What it stores.** On success it stores the element's **root-to-element path** of nodes. Each node holds tag, id, classes, index, inner text and other attributes.

**How it heals.** On `NoSuchElement`:
- It computes the **LCS** (longest common subsequence) between the stored path and **every root-to-leaf path** in the new DOM. Two nodes count as equal when their **tag and id** are equal.
- `HeuristicNodeDistance` scores each candidate node, then normalizes the total by the sum of all points (0..1):

| Signal | Points |
|---|---|
| tag equal | 100 |
| LCS / pathHeight | 100 (weighted by the ratio) |
| id | 50 × Levenshtein score |
| class Jaccard, plus fuzzy class matching | 40 |
| inner text | 30 × Levenshtein score |
| other attributes, averaged | 30 |
| index | **0** |

- The score is **0** when the path is longer than 5 and `LCS/height < 0.7`.
- The Levenshtein score is `(len − dist)/len`. It is forced to 0 when the distance exceeds `len × pct + 1`: pct 0.3 for id and text, 0.75 for classes and attributes.
- Configuration includes `score-cap` (README example `0.5`: heal only if score ≥ 50%) and `recovery-tries`. The top 10 candidates are recorded for the report.

**Takeaways for us:**
- Structural similarity of the ancestor chain is a strong signal.
- Sibling index is deliberately worth 0.
- Using an absolute cap of 0.5 **without a margin check** means look-alikes (for example list rows) can win.

### 2.6 Robula+ (Leotta, Stocco, Ricca, Tonella, JSEP 2016) [verified, paper]
Sources: [paper PDF](https://sepl.dibris.unige.it/publications/2016-leotta-JSEP.pdf), [project page](https://sepl.dibris.unige.it/ROBULA.php).

**Algorithm.** It starts from `//*` and specializes only the head of the XPath. It applies seven transformations in this order:
1. `transfConvertStar`
2. `transfAddID`
3. `transfAddText`
4. `transfAddAttribute`
5. `transfAddAttributeSet`
6. `transfAddPosition`
7. `transfAddLevel`

It stops at the first XPath that uniquely locates the target.

**Attribute lists.**
- Priority list: `name, class, title, alt, value`. The id comes before these through its own transformation.
- **Blacklist:** `src, href, onclick, onload, tabindex, width, height, size, maxlength, style`. The reasons given: paths change across releases, JavaScript is volatile, tab order shifts, sizes change, and inline style is volatile.

**Result.** The paper reports that ROBULA+ reduces locator fragility by **90%** compared with absolute XPaths and by **63%** compared with Selenium IDE locators.

**Takeaway.** Positional predicates come last, and `href`, `style` and `tabindex` should be distrusted.

### 2.7 Similo (Nass, Alégroth, Feldt, Leotta, Ricca; TOSEM 2023) [verified, paper and code]
Sources: [arXiv 2208.00677](https://arxiv.org/abs/2208.00677). Reference code: [`michelnass/SimiloLLM/similollm/Similo.java`](https://github.com/michelnass/SimiloLLM). See also [michelnass/Similo2](https://github.com/michelnass/Similo2).

**Core idea.** Store 14 "locator parameters" of the target. Compare them with **every** visible candidate. The score is `Σ weight × compare(target, candidate)`, and the highest score wins. Non-unique parameters, such as the tag, still help tip the balance.

**Weights from the reference code:**
```
LOCATORS = tag  class name id  href alt  xpath idxpath is_button location area shape visible_text neighbor_text
WEIGHTS  = 1.5  0.5   1.5  1.5 0.5  0.5  0.5   0.5     0.5       0.5      0.5  0.5   1.5          1.5
```
- The paper describes these as two groups: stable or guiding signals get 1.5, the rest get 0.5.
- The code also **doubles the visible-text weight when the text matches exactly**.

**Comparators:**
- `equalsIgnoreCase` for tag, name, id and is_button.
- Normalized Levenshtein, `(len−dist)/len`, for class, href, alt, the XPaths and the visible text.
- Integer ratio for area and shape.
- Location: linear decay of Euclidean distance. The paper says the value reaches 0 at 100 px; the reference code uses 200 px.
- Neighbor texts: word overlap.

**Neighbor texts:**
- The words of the visible text of elements whose rectangle intersects the target rectangle **expanded by 50 px** on each side.
- Only elements with height ≤ 100 count. The target is skipped if it is taller than 100 px or wider than 600 px.
- Words are lowercased and deduplicated.

**Visible text.** The first non-blank value of text, value or placeholder.

**Results.**
- The arXiv version reports Similo failing on **72 of 598** cases (12%), against **146** (24%) for the multi-locator baseline, over 40 popular sites.
- The published TOSEM abstract, as quoted in search results, reports 91/801 (11%) against 214/801 (27%).
- About **3 ms** per element lookup.

**Caveat stated by the authors.** Without a **threshold**, Similo always returns *something*, including when the real target has not loaded yet. They suggest using a threshold and re-running the search (waiting) before giving up.

### 2.8 VON Similo (Nass et al., ICST 2023) [verified, paper]
Source: [arXiv 2301.03863](https://arxiv.org/abs/2301.03863).

**Visually overlapping nodes.**
- DOM nodes whose rectangles have **IoU > 0.85**, and where one node's center lies inside the other, are merged into one "visual element". An example is a `div` wrapping an `input`.
- Each property becomes a set of values, and the comparison takes the **max** over all value pairs.

**Results (normalized score 0..1, 5-fold cross-validation, 1163 matches):**

| Algorithm | Threshold | Accuracy | Precision | Recall |
|---|---|---|---|---|
| Similo | 0.28 (best accuracy) | 82.3% | 0.796 | 0.898 |
| Similo | 0.40 | — | 0.892 | 0.615 |
| VON Similo | **0.40** (best) | **94.1%** | 0.968 | 0.922 |
| VON Similo | 0.60 | — | **1.000** | 0.475 |

Takeaways:
- Precision and recall trade off sharply around 0.4–0.6.
- Merging wrapper and inner nodes markedly improves matching.

### 2.9 VON Similo LLM (Nass, Alégroth, Feldt 2023/24) [verified, paper]
Source: [arXiv 2310.02046](https://arxiv.org/abs/2310.02046).

- VON Similo ranks all candidates. The **top 10** are serialized as JSON and sent to GPT-4 with the target and a one-shot example. GPT-4 returns a widget id, with optional reasons.
- JSON fields sent: Tag, Visible Text, Class, Id, Name, HRef, Location, Area, Shape, Alt, IsButton, XPath, Neighbor Text.
- Failed localizations fell from **70 to 39 of 804** (a 44% reduction), at the cost of slower runs and API fees.
- Sending more candidates raised cost and confused the model. In **13** cases the correct element was outside the top 10.

Motivating examples from the paper:
- Label "Save" changing to "Store" (a semantic change that Levenshtein misses).
- `input[type=button]` changing to `button`.

### 2.10 Tuned Similo-like weights (TUM BSc thesis code) [verified, code; tuning method not checked]
Source: [ast-fortiss-tum/web-element-localization-using-similo-like-approaches](https://github.com/ast-fortiss-tum/web-element-localization-using-similo-like-approaches), `ByCombinedSimilo.java`.

The weights differ markedly from Similo's 1.5/0.5:

| Feature | Comparator | Weight |
|---|---|---|
| name | Levenshtein | 2.85 |
| visible text | Levenshtein | 2.8 |
| input type | equality | 2.75 |
| alt | equality | 1.85 |
| all attributes | map intersection | 1.8 |
| neighbor text | string set | 1.45 |
| location | distance decay | 1.2 |
| href | equality | 0.95 |
| aria-label | Jaccard | 0.9 |
| tag | Jaccard | 0.8 |
| **id** | Levenshtein | **0.5** |
| id-XPath | Levenshtein | 0.45 |
| area | — | 0.35 |
| absolute XPath | Jaccard | **0.1** |

This supports the pattern "semantic text and type high, id moderate, absolute path nearly worthless".

### 2.11 Commercial tools (public docs only)
- **Testim Smart Locators** ([Tricentis docs](https://docs.tricentis.com/testim/content/overview/testim-overview/testim-automate.htm)) [verified]:
  - "analyzes potentially hundreds of attributes" and "assigns weights to the attributes"; users can view and override the weights.
  - "If a locator score drops below 70%, Testim automatically attempts to improve that locator."
  - The changelog flags elements that diverge from the baseline by more than 20%.
  - The actual weights are not public.
- **mabl auto-heal** ([help.mabl.com/docs/how-auto-heal-works](https://help.mabl.com/docs/how-auto-heal-works); the page returned 403 to direct fetch, so these points come from search-result excerpts of that page):
  - Records many attributes per element, optionally including **ancestors** and custom test-id attributes.
  - If an ancestor is recorded, it finds the ancestor first, then candidates inside it.
  - Tries for a strong match first, then partial-match auto-heal, then a GenAI "advanced auto-heal" that favors purpose-revealing attributes over random ids and matches semantically similar text ("Confirm" → "Approve").
  - **Fails the step when confidence is low.**
  - A heal is **saved only if the test passes**, and history is kept per environment.
- **Katalon** ([docs](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio)) [verified]:
  - Has a user-ordered list of locator methods (XPath sub-types, attributes, CSS, image, Smart Locator) and tries them top-down.
  - If none works, AI self-healing sends the page source, accessibility tree and screenshots to an LLM.
  - Proposes the replacement after the run for approval. No numeric thresholds are published.
- **Functionize:** I found no technical public documentation of its algorithm within this budget, so nothing is claimed about it.

---

## 3. Weaknesses of the current Scopos approach (with concrete failures)

Code: `ScoposWeb/extension/core/scan.js`, `describe()` (l.184) and `resolve()` (l.199).

| # | Weakness (code) | Concrete failure |
|---|---|---|
| 1 | **Acceptance gate is too weak.** A selector hit is accepted if it is unique and `norm(name).includes(norm(stored).slice(0,12))`. It is also accepted **whenever the hit has no name at all** (`!name(hits[0])` short-circuits to true). | **Duplicate labels.** A settings page has two forms, Profile and Password, each with a «Сохранить» button. The stored CSS path is `form:nth-of-type(2) > … > button`. The vendor adds a «Уведомления» form above them, so `nth-of-type(2)` is now the Profile form. The hit is unique and named «Сохранить», so it is **accepted silently and the wrong button is highlighted**. |
| 2 | **Only the first 12 characters are verified.** | «Скачать отчёт за май» vs «Скачать отчёт за июнь»: both start with `скачать отчё`, so the wrong one is accepted. |
| 3 | **`nth-of-type` path inside repeated structures.** | **List rows.** The step "Delete deal «ООО Ромашка»" stores `tbody > tr:nth-of-type(3) … button`. After a sort or a new deal, row 3 is a different deal. The «Удалить» name check passes, so we **point the user at deleting the wrong record**. |
| 4 | **Fuzzy fallback treats any substring as a match** (`includes` scores 1, and the threshold is ≥ 1). | Stored «Ок» is found inside «Д**ок**ументы» and accepted. Stored «Да» is found inside «**Да**нные» and «За**да**чи». Short labels such as «Ок», «Да», «Ещё» and «×» are very common. `want.startsWith(have)` also lets a one-letter name prefix-match. |
| 5 | **Ties go to document order** (strict `>`). With no ambiguity detection there is never a "not sure" outcome. | Two «Сохранить» buttons whose paths are broken: the first in the DOM always wins. |
| 6 | **The dynamic-id filter `/\d{3,}\|[:.]/` misses render-order counters.** | Ids like `mui-7`, `react-select-2-input`, `headlessui-menu-button-5` and `ember42` pass the filter and are stored as `#mui-7`. After a re-render or a release, `#mui-7` is a *different* field. If that field has an empty name, gate #1 accepts it. React 18 `useId` values (`:r1:`) are caught only because of the `:`. |
| 7 | **The stored name is truncated with "…" and compared raw.** `cut(name, 80)` appends `…`, and `norm` does not strip it. | A name longer than 80 characters can never match exactly, `startsWith` or `includes`, so the text fallback is dead for long labels. |
| 8 | **Numbers are not normalized.** | «Входящие (12)» becomes «Входящие (13)»; after `norm` these are «входящие 12» vs «входящие 13», which scores 0. |
| 9 | **The stored `path` (URL) is never checked in `resolve()`.** | On a different page with its own «Сохранить», the step resolves to that button. |
| 10 | **Occlusion and modals are ignored.** `visible()` checks size, display, visibility and opacity only. | A confirm dialog opens over the list. Both the page «Удалить» (behind the overlay) and the dialog «Удалить» are "visible", and document order picks the page one. Note that `inventory()` already handles dialogs (l.162), but `resolve()` does not. |
| 11 | **No context.** Section, heading, neighbors and row are not in the descriptor (`section()` exists in `inventory()` but is not stored). | This is the root cause of #1, #3 and #5: nothing separates look-alikes. |
| 12 | **i18n.** The text is the only fallback signal. | The user switches the UI to English, so «Сохранить» becomes «Save». If the path also broke, the result is not found. Worse, fuzzy matching may grab an unrelated control containing a short substring. |
| 13 | **Re-render and loading windows.** | During a React re-render or a skeleton state, the true target is momentarily absent, and `resolve()` returns the best fuzzy hit (≥ 1) on whatever is present. Similo's authors describe exactly this synchronization failure. |
| 14 | **Icon-only buttons.** These have no name and only a path, so after a release they are unrecoverable. | Trash, pencil and kebab «⋮» buttons in table rows. |

---

## 4. Recommended algorithm [recommendation]

### 4.1 Fingerprint to store (`describe()` v2)

```ts
type Fingerprint = {
  v: 2,
  // Page gate
  route: string,            // location.pathname with numeric/uuid/hash-like segments -> ':id'; plus hash route
  lang: string,             // document.documentElement.lang || navigator.language
  // Element identity (after Playwright-style retargeting to the interactive ancestor)
  tag: string, role: string, type?: string,          // input type / button type
  name: string,             // FULL accessible name, normalized (no ellipsis); keep raw too
  text?: string,            // own visible text if different from name (≤120 chars)
  attrs: {                  // only non-empty, only "stable" values
    testid?: string,        // data-testid|data-test-id|data-test|data-cy|data-qa (+ configurable)
    id?: string,            // only if !isGuidLike(id) && !counterLike(id)
    nameAttr?: string, ariaLabel?: string, placeholder?: string, title?: string, alt?: string,
    autocomplete?: string,  // very stable for form fields
    hrefPath?: string,      // pathname only, ids -> ':id' (Robula+ distrusts raw href)
  },
  classes: string[],        // stable classes only (filter in 4.3), max 8
  icon?: string,            // svg <use href>, data-icon, icon-font class, material-icons ligature
  // Structure
  chain: string[],          // ≤8 ancestor signatures: tag[#stableId][@role][.testid]  (Healenium-style LCS)
  // Context (the disambiguators)
  container?: { role: string, name: string },  // nearest dialog/form/region/nav/tabpanel/menu/listbox/grid/table/landmark
  heading?: string,         // nearest preceding heading/legend inside the container chain
  neighbors: string[],      // Similo neighbor words: rect ±50px, elements h≤100, lowercase, dedup, ≤30 words
  row?: { key: string, keyNorm: string, index: number, count: number, colHeader?: string },
  dup: { index: number, count: number },       // ordinal among visible same (role, normName) on the page
  // Geometry
  rect: { x: number, y: number, w: number, h: number },   // relative to container rect (fallback: viewport)
  // Legacy fast path
  sel: string[],            // keep current selectors (testid, #id, [name], [aria-label], short path)
  // Healing history
  variants?: Fingerprint[], // ≤3 confirmed past variants (see 4.8)
  intent?: string,          // the step's natural-language instruction (for the LLM)
  rowPolicy?: 'same-key' | 'same-index' | 'any',   // set at authoring time for repeated rows
};
```

### 4.2 Normalization and comparators

```js
normText(s) = NFKC(s).toLowerCase().replace(/ё/g,'е')
                .replace(/[\u{E000}-\u{F8FF}]/gu,'')          // icon-font glyphs (Playwright excludes these)
                .replace(/\d+([.,]\d+)?/g,'#')                 // counters, dates, prices
                .replace(/[«»"'“”‘’.,:;!?()\[\]{}…•|/\\-]+/g,' ')
                .replace(/\s+/g,' ').trim()

// Convention for ALL comparators: first arg = stored (target) value, second = candidate value.
//   stored value missing   -> null (feature skipped, weight not counted)
//   candidate value missing-> 0    (feature counted as a miss; disappearance is evidence)
textSim(a,b):
  if !a: return null
  if !b: return 0
  if a === b: return 1
  short, long = sorted by length
  if short.length < 4: return 0                     // «Ок», «Да», «×»: exact or nothing
  lev  = 1 - levenshtein(a,b)/long.length;  lev = lev >= 0.7 ? lev : 0   // Healenium-like bound
  tok  = |words(a) ∩ words(b)| / |words(a) ∪ words(b)|
  cont = long.includes(short) && isWordBoundary ? 0.5 + 0.4*short.length/long.length : 0
  return max(lev, tok, cont)

eq(a,b)        = !a ? null : (a === b ? 1 : 0)
jaccard(A,B)   = !A.length ? null : (B.length ? |A∩B|/|A∪B| : 0)
lcsRatio(c1,c2)= LCS(c1,c2) / max(len(c1),len(c2))                       // Healenium LCSPathDistance
wordOverlap(A,B)= |A∩B| / max(|A|,|B|)                                   // Similo neighbor texts
posSim(r1,r2)  = max(0, 1 - dist(center(r1),center(r2)) / 250)           // Similo used 100px (paper) / 200px (code)
roleSim(a,b)   = a===b ? 1 : FAMILY[a]?.[b] ?? 0   // button~menuitem .7, button~link .5, textbox~searchbox .9, textbox~combobox .6, checkbox~switch .7
tagSim(a,b)    = a===b ? 1 : (pair in {input:button, a:button, div:button}) ? .6 : 0
```

### 4.3 Stable-value filters

```js
isGuidLike(id)        // port Playwright's function verbatim (transitions >= len/4)
counterLike(v) = /(^|[-_:])(r|mui|ember|react-select|headlessui[\w-]*|radix|rc|:r)[-_:]?\d+/i.test(v)
              || /\d{3,}/.test(v) || /[:]/.test(v) || /^[0-9a-f]{8,}$/i.test(v.replace(/-/g,''))
stableId(id)   = id && !isGuidLike(id) && !counterLike(id)

isStableClass(c):
  if /^(css|sc|jsx|svelte|emotion)-/i.test(c) return false       // CSS-in-JS hash prefixes (heuristic)
  if /^jss\d+$|^makeStyles-|-\d+$/.test(c) return false            // JSS / MUI v4 (heuristic)
  m = c.match(/^([A-Za-z][\w-]*?)(?:_{1,3}|-module__)[\w-]*?_{1,3}[A-Za-z0-9_-]{4,}$/)  // CSS modules
  if m: c = m[1]  (keep the semantic prefix, e.g. "Button_primary")
  return wordLike(c)                                                 // port finder's wordLike
```

The CSS-in-JS patterns above are engineering heuristics. Only Playwright's `isGuidLike` and finder's `wordLike` were verified in source.

### 4.4 Features and weights

The score is a **normalized** weighted sum: `S = Σ w_f·sim_f / Σ w_f`, taken over the features **present in the stored fingerprint and applicable**. A feature stored for the target but absent on the candidate counts as sim 0 and its weight stays in the denominator. This gives a 0..1 scale comparable to the VON Similo / Healenium / Testim thresholds.

| Feature | Comparator | Weight | Rationale (source) |
|---|---|---|---|
| `attrs.testid` | eq | **3.0** | Highest-priority stable hook (Playwright score 1–2; Testing Library). |
| `name` (accessible) | textSim | **3.0** | Role+name is Playwright's best non-testid token. TUM-tuned weights 2.8–2.85. |
| `role` | roleSim | 1.5 | Playwright role tokens. |
| `type` (inputs) | eq | 1.5 | TUM-tuned typeName 2.75. A mismatch is also a veto, see 4.5. |
| `attrs.nameAttr` | eq | 1.5 | Similo 1.5; Robula+ priority #1. |
| `attrs.id` (stable only) | eq / lev ≥ 0.8 | 1.0 | Similo 1.5, TUM 0.5. Ids change in releases. |
| `attrs.ariaLabel`, `placeholder`, `autocomplete` | textSim / eq | 1.0 each | Testing Library label/placeholder. |
| `text` (if ≠ name) | textSim | 1.0 | |
| `icon` | eq | 1.0 | The only identity of icon buttons. |
| `attrs.title`, `alt` | textSim | 0.5 each | Testing Library "semantic" tier. |
| `attrs.hrefPath` | textSim | 0.75 | Robula+ blacklists raw href; we use the normalized path. |
| `classes` (stable) | jaccard | 0.75 | Similo 0.5; Healenium 40/330. |
| `tag` | tagSim | 0.5 | Similo 1.5, TUM 0.8. Mostly implied by role. |
| `chain` | lcsRatio | 1.0 | Healenium LCS. |
| `container` (role+name) | eq on role × textSim on name | **2.0** | mabl ancestor-first. The main duplicate-label separator. |
| `heading` | textSim | **1.5** | |
| `neighbors` | wordOverlap | **1.5** | Similo neighbor texts 1.5. |
| `row.keyNorm` (if stored) | textSim (raw key exact = 1) | **2.5** | The list-row separator. |
| `dup.index` (if `dup.count > 1`) | 1 same ordinal; 0.5 same ordinal from end; 0 otherwise | 1.0 | Playwright's `nth` as a last resort. Healenium gives index 0. |
| `rect` | posSim (container-relative) | 0.75 | Similo 0.5, TUM 1.2. Layout moves in releases. |
| `sel` hits | fraction of stored selectors that match this candidate | 1.0 | Similo uses non-unique locators as votes. |

When `lang` differs from the stored `lang` (i18n switch), multiply the weights of `name`, `text`, `heading`, `neighbors`, `row.key` (when it is not a number or code) and `placeholder` by **0.25**. Then force any non-fast-path decision through the LLM (4.6). The LLM can map «Сохранить» to "Save"; Levenshtein cannot (VON Similo LLM's "Save/Store" example).

### 4.5 Hard filters and penalties

- **Route gate:** if `normalizeRoute(location)` ≠ `fp.route`, return `{status:'wrong-page'}`. Do not search.
- **Candidate pool:** visible elements matching `CONTROL`, plus elements whose tag or role equals the stored one, plus all hits of `fp.sel`.
  - Retarget each to its interactive ancestor (Playwright).
  - Merge visual duplicates: when a wrapper and its inner node have IoU > 0.85, keep one candidate and take the max sim per feature (VON Similo).
  - Pierce open shadow roots.
- **Modal / occlusion:** if an `aria-modal`, `<dialog open>` or `[role=dialog]` is open, drop candidates outside it, unless the stored `container` is not a dialog *and* no candidate inside the dialog scores ≥ 0.4. Also require the `elementFromPoint(center)` hit test to land inside the candidate, unless the stored step allows "hidden/needs scroll".
- **Vetoes:**
  - Role family mismatch (button vs textbox) gives S × 0.5.
  - Input type category mismatch (text / checkbox / radio / file / range) gives S × 0.3.
- **Test-id conflict:** both have a test id and they differ, so S × 0.6. Vendors do rename them in releases, so this is a penalty, not a hard veto.

### 4.6 Decision rule, tie-breaking and when to give up

Constants [recommendation]:

| Constant | Value | Anchor |
|---|---|---|
| `T_ACCEPT` | 0.70 | Testim's 70% "improve" trigger; between VON Similo's best-accuracy 0.40 and 100%-precision 0.60 on *their* scale, but higher because a wrong highlight in a guide is worse than a question. |
| `MARGIN` | 0.10 | Required gap between the best and second-best candidate. |
| `T_AMBIG` | 0.45 | Healenium README example score-cap 0.5; VON Similo optimum 0.40. |
| `T_FLOOR` | 0.30 | Below this, nothing on the page resembles the target. |
| `K_LLM` | 8 | VON Similo LLM used 10; more candidates confused GPT-4 and raised cost. |

```js
async function resolve(fp, ctx) {
  if (!routeMatches(fp.route)) return { status: 'wrong-page' };

  // 0. Re-render fast path: reuse the last element if it is still attached and still matches.
  const last = ctx.lastRef?.deref();
  if (last?.isConnected && score(fp, features(last)) >= T_ACCEPT) return ok(last, 'cached');

  for (let attempt = 0; attempt < 3; attempt++) {
    await domSettled({ quietMs: 150, maxMs: 1500 });           // MutationObserver quiet window

    // 1. Fast path: strong unique hooks, but still verified by the fingerprint.
    for (const s of strongSelectors(fp)) {                       // testid, stable #id, tag[name]
      const hits = visibleQueryAll(s);
      if (hits.length === 1 && score(fp, features(hits[0])) >= 0.5) return ok(hits[0], 'fast');
    }

    // 2. Score the whole candidate pool.
    const ranked = candidatePool(fp)
      .map(el => ({ el, f: features(el, { lazyNeighbors: true }) }))
      .map(c => ({ ...c, s: score(fp, c.f, { skipExpensive: true }) }))
      .sort(bySDesc).slice(0, 20)
      .map(c => ({ ...c, s: score(fp, withNeighborsAndRow(c), { full: true }) }))  // expensive features only for top 20
      .sort(rankCompare);
    const [b1, b2] = ranked, s1 = b1?.s ?? 0, s2 = b2?.s ?? 0;

    // 3. Decide.
    if (s1 >= T_ACCEPT && s1 - s2 >= MARGIN && !fp.langChanged) return ok(b1.el, 'healed', s1);
    if (s1 >= T_AMBIG) return await askModel(fp, ranked.slice(0, K_LLM), ctx);  // ambiguous or i18n
    if (attempt < 2) continue;                                   // likely not rendered yet (Similo's sync caveat)
    if (s1 >= T_FLOOR) return await askModel(fp, ranked.slice(0, K_LLM), ctx);
    return { status: 'not-found', best: s1 };                    // let the planner re-plan (open menu? other page?)
  }
}

// Tie-break comparator: used only to ORDER candidates, never to auto-accept inside the margin.
function rankCompare(a, b) {
  return (b.s - a.s)                                         // 1. total score
    || (ctxScore(b) - ctxScore(a))                           // 2. container + heading + row + neighbors
    || (dupOrdinalMatch(b) - dupOrdinalMatch(a))             // 3. same ordinal among same-name twins
    || (posSim(b) - posSim(a))                               // 4. closer to stored container-relative position
    || (inViewport(b) - inViewport(a))                       // 5. on screen first
    || docOrder(a, b);                                       // 6. document order (deterministic)
}
```

`askModel(fp, topK, ctx)`:
- Send `fp.intent` (the step instruction, for example «Нажмите "Сохранить" в блоке "Пароль"»), the compact stored fingerprint, and K candidates as compact JSON: `{id, role, name, text, container, heading, rowKey, neighbors(≤15 words), testid, idAttr, nameAttr, rect(rounded)}`.
- Ask it to return **one candidate id or `NONE`**, with a one-line reason.
- Validate that the id belongs to the list.
- Cache the answer by `(stepId, hash(sorted candidate signatures))`, so re-render loops do not call the model again.
- If the answer is `NONE` or the call fails, return `ask-user`: highlight nothing and tell the user plainly that the control was not found.

### 4.7 Disambiguation by context (worked examples)

- **Two «Сохранить» buttons (Profile vs Password).**
  - The element-level features are identical.
  - `container` (form or region named «Пароль»), `heading` («Смена пароля») and `neighbors` («текущий пароль новый пароль…») match only one of them. On the weight table that is up to (2.0 + 1.5 + 1.5) / ~17 ≈ **0.29** of separation, well above `MARGIN`.
  - If both buttons sit in one form with no heading, only `dup.index` and `rect` differ (≤ 1.75 / 17 ≈ 0.10). That is borderline by design, so the case goes to the LLM, which sees the step intent.
- **List rows** («Удалить» in every row). `row.key` is the first non-empty cell text in the row other than the target name, for example «ООО Ромашка» or the order number.
  - `rowPolicy = 'same-key'` (default when the step mentions a specific record): `row.key` at weight 2.5 dominates. If no row has that key, **never fall back to the same index**; return `not-found`.
  - `'any'` (the step is generic, for example "click Edit on any deal"): drop `row.key` and `dup.index`, and prefer the first visible row.
  - `'same-index'` (rare, for example "the first row"): use `dup.index` at full weight.
  - At authoring time, if the target is inside a repeated row, have the model or the author pick the policy.
- **Dynamic ids:** these never enter `attrs.id` (4.3), so they cannot mislead. They still contribute weakly through `chain` signatures only when stable.
- **React re-renders:**
  - Hold a `WeakRef` to the resolved element.
  - On a `MutationObserver` batch (throttled to an animation frame), check `isConnected`. If the element is detached, re-run `resolve()`; the cached fast path makes this cheap.
  - Do not keep highlighting a detached node.
  - During loading states, the retry loop plus `T_ACCEPT` and `MARGIN` prevent grabbing a look-alike.
- **Vendor release:**
  - The fast path fails because test ids or ids changed, or the path broke.
  - The scored pool still finds the target through name, role, container, neighbors and chain.
  - A large re-label («Сохранить» to «Применить») drops `name` to about 0. Context features usually keep S in the 0.45–0.70 band, so the LLM gets the decision, as VON Similo LLM recommends.

### 4.8 Healing write-back (do not drift)

- After the user **successfully completes the step** on a healed match, append the new observed fingerprint to `fp.variants`. Keep at most 3. Successful completion means the click happened and the next step's precondition or target appeared. This mirrors mabl, which saves a heal only if the test passes, and Katalon, which proposes the fix after the run.
- Score with `max(score(fp), score(variant_i))`. Never overwrite the original from one observation.
- Promote a variant to canonical only after **≥ 2 successful heals from different sessions**, or after author confirmation (a server-side aggregate across users).
- Log `{stepId, path:'fast'|'cached'|'healed'|'llm'|'not-found', s1, s2}`. This telemetry is the calibration data for §6.

### 4.9 Authoring-time self-check (cheap, high value)

When `describe()` creates a fingerprint, immediately run the scorer against the **current** page, as Playwright's uniqueness check does:
- If the runner-up scores ≥ 0.6, or the margin is < 0.15, the step is ambiguous at birth.
- In that case, enrich the fingerprint (`row`, `container`, `heading`, `intent`) and, if it is still ambiguous, warn the author: "2 elements look like «Сохранить»; which section?".

---

## 5. Full scoring pseudo-code

```js
const W = { testid:3, name:3, role:1.5, type:1.5, nameAttr:1.5, id:1, ariaLabel:1, placeholder:1,
            autocomplete:1, text:1, icon:1, title:.5, alt:.5, hrefPath:.75, classes:.75, tag:.5,
            chain:1, container:2, heading:1.5, neighbors:1.5, row:2.5, dup:1, rect:.75, sel:1 };

function score(fp, c, opt = {}) {
  const k = fp.langChanged ? 0.25 : 1;
  const terms = [
    ['testid',      eq(fp.attrs.testid, c.attrs.testid)],
    ['name',        textSim(fp.nameNorm, c.nameNorm),                       k],
    ['role',        fp.role ? roleSim(fp.role, c.role) : null],
    ['type',        eq(fp.type, c.type)],
    ['nameAttr',    eq(fp.attrs.nameAttr, c.attrs.nameAttr)],
    ['id',          fp.attrs.id ? (c.attrs.id ? (fp.attrs.id === c.attrs.id ? 1 : levRatio(fp.attrs.id, c.attrs.id) >= .8 ? .5 : 0) : 0) : null],
    ['ariaLabel',   textSim(fp.attrs.ariaLabel, c.attrs.ariaLabel),         k],
    ['placeholder', textSim(fp.attrs.placeholder, c.attrs.placeholder),     k],
    ['autocomplete',eq(fp.attrs.autocomplete, c.attrs.autocomplete)],
    ['text',        fp.text ? textSim(fp.text, c.text) : null,              k],
    ['icon',        eq(fp.icon, c.icon)],
    ['title',       textSim(fp.attrs.title, c.attrs.title),                 k],
    ['alt',         textSim(fp.attrs.alt, c.attrs.alt),                     k],
    ['hrefPath',    textSim(fp.attrs.hrefPath, c.attrs.hrefPath)],
    ['classes',     fp.classes.length ? (jaccard(fp.classes, c.classes) ?? 0) : null],
    ['tag',         tagSim(fp.tag, c.tag)],
    ['chain',       fp.chain.length ? lcsRatio(fp.chain, c.chain) : null],
    ['container',   fp.container ? (c.container ? roleEq(fp.container, c.container) * (textSim(fp.container.name, c.container.name) ?? 1) : 0) : null, k],
    ['heading',     fp.heading ? (textSim(fp.heading, c.heading) ?? 0) : null, k],
    ['neighbors',   opt.skipExpensive ? null : (fp.neighbors.length ? wordOverlap(fp.neighbors, c.neighbors) : null), k],
    ['row',         opt.skipExpensive || !fp.row || fp.rowPolicy === 'any' ? null : rowSim(fp.row, c.row), isCode(fp.row?.key) ? 1 : k],
    ['dup',         fp.dup.count > 1 && fp.rowPolicy !== 'any' ? dupSim(fp.dup, c.dup) : null],
    ['rect',        posSim(fp.rect, c.rect)],
    ['sel',         fp.sel.length ? c.selHits / fp.sel.length : null],
  ];
  let num = 0, den = 0;
  for (const [f, sim, mult = 1] of terms) {
    if (sim === null || sim === undefined) continue;        // target lacks this feature, so skip it
    const w = W[f] * mult; num += w * sim; den += w;
  }
  let s = den ? num / den : 0;
  if (roleFamily(fp.role) !== roleFamily(c.role)) s *= 0.5;
  if (fp.type && c.type && typeCategory(fp.type) !== typeCategory(c.type)) s *= 0.3;
  if (fp.attrs.testid && c.attrs.testid && fp.attrs.testid !== c.attrs.testid) s *= 0.6;
  return s;
}
```

Note the asymmetry (see the comparator convention in 4.2): a value **present in `fp` but missing on the candidate** counts as 0 with its weight kept in the denominator; only values missing from `fp` are skipped. Similo's reference code instead skips a parameter when either side is null (`if(targetValue != null && candidateValue != null)`); our stricter rule penalizes disappearance, which is safer for a guide.

**Performance.** Similo reports about 3 ms per element lookup. Keep the pool to controls (≤ ~2000 nodes), compute the expensive features (neighbors, row, chain) only for the top 20, and cache `features(el)` in a `WeakMap` invalidated on mutation.

---

## 6. Calibration plan (needed before trusting the numbers)

1. Build a corpus of `(fingerprint captured on version A, true element on version B)` pairs:
   - from our demo apps across synthetic mutations: insert sibling, re-order rows, rename label, switch language, change ids, wrap in div;
   - from saved HTML snapshots of real vendor pages across releases.
2. Grid-search the weights and `T_ACCEPT`, `MARGIN` and `T_AMBIG` to maximize **precision at the auto-accept tier**. The target is ≥ 99%, because a wrong highlight is costly. Then maximize the recall of auto plus LLM.
3. Track production telemetry (§4.8) for the share of steps on each path ('fast', 'cached', 'healed', 'llm', 'not-found') and the LLM's NONE rate.

---

## 7. Sources

- Playwright selector generator: https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts
- @medv/finder: https://github.com/antonmedv/finder/blob/master/finder.ts
- css-selector-generator: https://github.com/fczbkk/css-selector-generator
- Testing Library priority: https://testing-library.com/docs/queries/about/#priority
- Healenium web: https://github.com/healenium/healenium-web ; how it works: https://healenium.io/docs/how_healenium_works ; tree-comparing sources: https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.11/
- Robula+: https://sepl.dibris.unige.it/publications/2016-leotta-JSEP.pdf ; https://sepl.dibris.unige.it/ROBULA.php
- Similo: https://arxiv.org/abs/2208.00677 ; code: https://github.com/michelnass/SimiloLLM , https://github.com/michelnass/Similo2
- VON Similo: https://arxiv.org/abs/2301.03863
- VON Similo LLM: https://arxiv.org/abs/2310.02046
- TUM Similo-like tuned weights: https://github.com/ast-fortiss-tum/web-element-localization-using-similo-like-approaches
- Testim (Tricentis docs): https://docs.tricentis.com/testim/content/overview/testim-overview/testim-automate.htm
- mabl auto-heal: https://help.mabl.com/docs/how-auto-heal-works
- Katalon self-healing: https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio
