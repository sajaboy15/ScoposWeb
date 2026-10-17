# 07 · Contract verification after the parallel rewrite

Date: 2026-10-17. Scope: every module boundary in `extension/`, `sdk/`, `server/`, `demo/`, `dev/`. No project file was edited.
Note: `extension/core/explore.js` and `extension/core/guard.js` were changed by another agent while this check ran
(about 13:52). The logic cited below did not change, only line numbers. The explore.js line numbers here are the current ones.

## What was run

| Check | Result |
|---|---|
| `node --check` on all 14 JS/MJS files, plus the inline `<script>` blocks in demo/index, demo/setup, dev/stress, dev/panel-preview | all pass |
| `node dev/scan-selftest.mjs` | 70 passed, 0 failed |
| `require('./extension/core/brain.js')`, then buildAsk / buildAskMap / buildLearn / buildLocate / mapText (GLOBAL and over budget) / viewOf / pageKey / refSteps on a fake map | all pass except `refSteps` when a control has `d: null` (finding 1) |
| `node sdk/build.mjs` → `node --check dist/scopos.js` | pass (221.9 KB). The build rewrote `dist/scopos.js` |
| vm harness: background.js with a stubbed `chrome.*` API and a fake Claude SSE stream (52 cases: ask on the page path, cache hit, cache:drop, playbook match, heal through Haiku and commit after the step, suggestions, stop, PANEL_TYPES gate for 15 content types, guard:inject → MAIN pageMain, learn:start → explore:save/load/progress → explore:done → guides written (1 kept, 1 dropped), learn:state shape, ask from the map, explore:abort, learn:stop then a late explore:done is ignored, learn:finish, tabs.onRemoved, an API error reaching the session, a dead "thinking" run) | 52 pass, 1 fail (finding 1) |
| Claude API request shape checked against the claude-api reference: model ids `claude-sonnet-5-5` / `claude-haiku-5-5` / `claude-opus-5-5`, `thinking:{type:'adaptive'}`, `output_config:{effort, format:{type:'json_schema'}}`, `fallbacks:'default'` + `server-side-fallback-2026-07-01` (left off for Haiku, as required), 1h cache_control, the PRICE tables | all correct |

Contracts that match on both sides: every `S.*` symbol and its signature (`scan({query})`, `inventory`, `describe` → `{v,sel,text,role,path,fp}`, `resolve`, `resolveDetailed` → `{el,score,margin,ambiguous,candidates,via}`, `candidatesFor` → `[{id,line}]`, `pointer.point` options including `relocate`/`avoidRect`/`explore`, `guide.start` with `index/missingDelay/onChange/onEnd/onMissing(step,i)`, `explore.start/resume/stop/running/toMap/pageKey`, `guard.on/off/inject/pageMain/pageScript/blocked`); load order in the manifest, CORE_FILES and build.mjs (no file uses a later file's symbol at load time); every `Brain.*` call in background.js and server.mjs; the `toMap()` shape against `mapText`/`refSteps`/`viewOf`; every chrome.runtime message type and reply shape (panel → worker, content → worker, worker broadcasts `session/progress/learn/learn:progress/record:stop-request`); widget ↔ server endpoints, NDJSON progress/result/error lines, learn check and token header, knowledge shape, source names `map/cache/claude`.

## Findings, by severity

### 1. High · Map answers and learning crash when a control has no descriptor
- **Where:** `extension/core/brain.js:282` (`refSteps`). The producer is `extension/core/explore.js:450` (`d = null` when `S.describe` throws), kept as-is by `toMap` at `explore.js:717`.
- **What breaks:** `target: c ? { ...c.d, text: c.d.text || c.name, ... }` reads `.text` of `null`. In the extension the map is stored raw, so:
  - an ask from the map that picks such a control fails with "Cannot read properties of null (reading 'text')" (reproduced in the harness);
  - in `learnFrom` → `learnedGuides`, one such ref throws, so no guides are saved and learn ends in `error`.
  The server is not affected, because `cleanDescriptor` never returns null.
- **Fix:** in brain.js:282
  ```js
  target: c ? (c.d ? { ...c.d, text: c.d.text || c.name, role: c.d.role || c.role } : { sel: [], text: c.name, role: c.role || null }) : null,
  ```

### 2. High · SDK learn rejects real maps: the server caps views at 80, the explorer makes up to 100
- **Where:** `server/server.mjs:176` (`m.views.length > 80`) against `extension/core/explore.js:33` (`views: 40` pages + `extra: 60` dialogs/panels; all captured views are returned by `toMap`).
- **What breaks:** on a product with many dialogs or panels, `POST /api/scopos/learn` returns 400 «Нет карты продукта или она слишком большая» after a walk of up to 5 minutes, and the widget shows that error.
- **Fix:** share one limit. In server.mjs use `m.views.length > 100`, and update the error text to «до 100 экранов и окон». Better still, export `LIMITS` from explore (`S.explore.limits`) and keep the server at `views + extra`.

### 3. Medium · Three different "same page" rules, so healing and the away-card misfire
- **Where:**
  - `extension/content.js:15-19` and `sdk/widget.js:402-403`: exact string match, no id normalisation, any `#hash` counts;
  - `extension/core/guide.js:49-59`: `S.pathKey` with `:id`, 20+ char tokens, and no query;
  - `extension/core/scan.js:291-298`: a private `pathKey` used by `resolveDetailed` at `scan.js:1290`, with a smaller id regex and not exported as `S.pathKey`;
  - `scan.js:1047` `pathNow()`: `describe().path` drops the query;
  - `explore.js` `pageKey` and `brain.js:291`: keep route query params (`?page=`, `?tab=` …).
- **What breaks:**
  - On record routes (`/invoices/42` recorded, user on `/invoices/43`), guide.js treats it as the same page and calls `onMissing`. content.js and widget.js then say it is a different page and return null, so self-heal never runs on parameterised routes. The same happens when the URL has a plain `#section` hash.
  - In query-routed apps (`?page=invoices` vs `?page=clients`) the explorer maps separate views. But `d.path` has no query, so guide.js counts both as the same page: the «Перейдите на страницу …» card never shows, and resolve accepts a look-alike at 0.70 instead of 0.85.
- **Fix:**
  1. Keep one implementation in scan.js: a `pathKey` that matches explore/brain's `pageKey` (id segments including 20+ char tokens, route query params kept, only `#/` and `#!` hashes), exported as `S.pathKey`.
  2. Have `pathNow()` keep the route query params, the same way `pageUrl()` does.
  3. In guide.js, delete the local `pathKey`/`ID_SEG` and use `S.pathKey`.
  4. In content.js and widget.js, change `samePage` to `path => !path || S.pathKey(path) === S.pathKey(location.pathname + location.search + location.hash)`.

### 4. Medium · "Отменить" during a page load does not stop the walk
- **Where:** `extension/core/explore.js:758` (`boot` sets `stopping = false`); `extension/background.js:707-717` (`learn:stop`) and `718-725` (`learn:finish`) only message the tab.
- **What breaks:** if `explore:stop` reaches the new document before `resume()` runs (the content script is still waiting for `explore:load`), `stop()` sets `stopping = true` and returns, because `st` is still null. Then `boot()` clears the flag and the walk carries on clicking for up to 5 minutes. With learn:stop its result is thrown away; with learn:finish the guides are written late. The same thing happens when toTab re-injects during navigation.
- **Fix:** (a) explore.js: remove `stopping = false` from `boot()`; `start()` already resets it, and a page load gives a fresh module anyway. (b) background.js, in `learn:stop` and `learn:finish`: before messaging, persist the stop:
  ```js
  const k = exploreKey(target); const st = (await chrome.storage.session.get(k))[k];
  if (st && st.status === 'running') await chrome.storage.session.set({ [k]: { ...st, stopping: true } });
  ```
  boot already honours `st.stopping` at explore.js:781.

### 5. Medium · A redirect to login ends as "done", so guides get written from login pages
- **Where:** `extension/core/explore.js:803`, where `finish('stopped')` notifies `onDone`. Dead branches for `'redirect'`: `extension/background.js:791` and `sdk/widget.js:123`.
- **What breaks:** when the explorer detects "everything lands on the same page" (logged out), it calls `onDone(map)`. Both the extension and the SDK then spend an Opus call writing guides from that map, and the "Войдите и запустите снова" message is never shown.
- **Fix:** explore.js:803 → `st.stopReason = 'redirect'; quit(); await finish('stopped', false); if (o.onAbort) { try { o.onAbort('redirect', toMap(st)); } catch (e) {} } return false;`

### 6. Low · pointer.js has no double-load guard
- **Where:** `extension/core/pointer.js:21-23`. scan, guide, guard, explore and content.js all have one.
- **What breaks:** `toTab` re-injects `CORE_FILES` (`background.js:146`) when the ping fails, for example during load, and the manifest copy may run as well. The second pointer.js replaces `S.pointer`, while the kept guide.js keeps the old card on screen, orphaned in the top layer.
- **Fix:** add `if (S.pointer) return;` after `const S = …` in pointer.js.

### 7. Low · The on-page «Остановить» acts like «Хватит, писать гайды», not like «Отменить»
- **Where:** `explore.js:535` (card `onClose: stop`) → `finish` → `onDone` → `explore:done` → `learnFrom` (background) / `POST /learn` (widget).
- **What breaks:** a user who presses the card's Stop button to cancel still triggers an Opus guide-writing call. The panel's «Отменить» (learn:stop) does not.
- **Fix:** pick one meaning. Either rename the card button «Хватит», or have card-stop call `finish('stopped', false)` plus `onAbort('user')`, and handle `'user'` in the background (set status `stopped`) and in the widget.

### 8. Low · Widget learn check ignores a missing key
- **Where:** `sdk/widget.js:151`; the server replies `{ ok, key }` at `server/server.mjs:308`.
- **What breaks:** with no key on the server, the walk runs to the end and only then fails with 503.
- **Fix:** `const c = await post('/learn', { check: true }, …); if (!c.key) { learning = { status: 'error', error: 'Сначала подключите ключ Claude на сервере (/setup).' }; render(); return; }`

### 9. Info · Dead or loose contracts (no breakage)
- `extension/content.js:65` passes `exploreOpts.guard`, but explore.js never reads `opts.guard`; it calls `S.guard` directly (`explore.js:418-419`). Either remove the option or make explore prefer `opts.guard`.
- `dev/stress.html:97` loads `/scopos.js` but not `/dev/stress-check.js`, so `scoposStress()` does not exist until you load it by hand. Add `<script src="/dev/stress-check.js"></script>`.
- `extension/core/scan.js` exposes `pathKey` only as `S._test.pathKey`; `S.pathKey` is defined by guide.js. Covered by fix 3.
- Nobody passes `pointer.point({ avoidRect })`. The widget could pass its open panel so the card never lands under it.
