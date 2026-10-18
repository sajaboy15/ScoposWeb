# Model evals

Which Claude model each Scopos job should use, how accurate it is and what it costs. Results and the
recommendation are in `research/10-model-eval.md`.

Every script uses the real request builders from `extension/core/brain.js` and only overrides `model` (and
`output_config.effort`) on the body. The key is read inside `lib.mjs` from `ANTHROPIC_API_KEY` or
`.scopos-key.local` and is never printed. Every call is appended to `$EVAL_OUT/spend.jsonl`; a run stops
before a call once the ledger reaches `$EVAL_BUDGET` (default $4).

| file | what |
|---|---|
| `lib.mjs` | brain, key, prices (verified 2026-10-17), cost per call with 1h cache writes and reads, spend ledger |
| `grade.mjs` | automatic grading of a map answer against a task |
| `tasks-tms.json`, `tasks-ledgerly.json` | 32 tasks for Haulr TMS, 13 for Ledgerly (task format: top of `grade.mjs`) |
| `eval-ask.mjs` | ask-map: every task in sequence on one model/effort (cache warm after the first call) |
| `run-learn-compare.mjs` | learn: writes the guides with each model and grades them |
| `capture-pages.mjs` | real `Scopos.scan()` pages of TMS states the explorer did not open (for locate/continue) |
| `eval-locate.mjs` | locate: renamed / removed controls on shuffled real pages |
| `eval-continue.mjs` | continue: 5 live-guide continuations on real pages |
| `summarize.mjs` | one line per saved run, re-graded with the current grader; no Claude call |
| `run-deep-learn.mjs` | deep learn (`buildDeepLearn` → `learnRun` → `finishLearn` → `buildFaq`): prints the plan and cost estimate, sends with `--yes`, keeps each part's reply, writes `knowledge-<name>.json` (`--docs file`: vendor workflows) |
| `eval-local.mjs` | instant answers: every task through `Brain.instantMatch` (no Claude), the guide it runs graded like ask-map; share right / wrong / suggestions / to Claude, and speed on 300 guides × 6 phrasings (`--extra`, `--holdout`) |
| `tasks-*-extra.json`, `tasks-tms-holdout.json` | more questions for instant answers (extra was used while tuning; holdout was written after it) |
| `tasks-replica.json` | 34 tasks from the vendor tutorials of a real TMS, on its replica `demo/replica` (research/13) |

Instant answers (research/12): `node dev/eval/run-deep-learn.mjs --map $EVAL_OUT/walk-tms.json --product "Haulr TMS" --name tms --yes`
(~$0.5), then `node dev/eval/eval-local.mjs --product tms --map $EVAL_OUT/walk-tms.json --knowledge $EVAL_OUT/knowledge-tms.json --extra --holdout`.

## Rerun

Needs the demo server on :4173 (`npm run demo`) for the maps and pages; the evals themselves call the API directly.

```sh
export EVAL_OUT=/some/dir          # default dev/eval/out
export EVAL_BUDGET=4               # $ cap across everything that shares $EVAL_OUT/spend.jsonl

# 1. maps (free: the throwaway profile has no key, the walk ends in status 'mapped')
node dev/explore-walk.mjs http://localhost:4173/demo/tms/index.html $EVAL_OUT/walk-tms.json
node dev/explore-walk.mjs http://localhost:4173/ $EVAL_OUT/walk-ledgerly.json
# (run the two walks one after another: in parallel the Ledgerly walk ended in 'error' once)

# 2. ask-map (~$0.21 per Sonnet run on TMS, ~$0.015 Haiku; Ledgerly ~$0.05 / $0.002)
node dev/eval/eval-ask.mjs --product tms --map $EVAL_OUT/walk-tms.json --model claude-sonnet-5-5 --effort low
node dev/eval/eval-ask.mjs --product tms --map $EVAL_OUT/walk-tms.json --model claude-haiku-5-5 --effort low
node dev/eval/eval-ask.mjs --product ledgerly --map $EVAL_OUT/walk-ledgerly.json --model claude-sonnet-5-5
#   --lang-fix   what-if with the language rule changed (brain.js is not touched)
#   --suffix r2  a repeat run into its own file;  --only id,id  a few tasks;  --regrade  no calls;  --dry  sizes only

# 3. learn (Opus ~$0.45, Sonnet ~$0.21, Haiku ~$0.015 on TMS)
node dev/eval/run-learn-compare.mjs --map $EVAL_OUT/walk-tms.json --models claude-opus-5-5,claude-sonnet-5-5

# 4. locate and continue (cents)
node dev/eval/capture-pages.mjs
node dev/eval/eval-locate.mjs
node dev/eval/eval-continue.mjs

# 5. table of everything saved
node dev/eval/summarize.mjs --tms $EVAL_OUT/walk-tms.json --ledgerly $EVAL_OUT/walk-ledgerly.json
```

Task paths are control labels, not refs, so the tasks survive a new explorer run. If the fixture changes,
check the labels in `tasks-*.json` against `Brain.mapText(map).text`.

## Grading, in short

- **exact**: every expected label is a step's control, in order (extra navigation, look and field steps are
  allowed); no other click; the last action is the expected commit; no ref outside the map. Tasks that should
  have no steps (facts, impossible tasks): no steps, and the answer matches the fact (or says it can't be done).
- **usable**: as exact, but one non-critical expected step may be missing or one extra click may be there.
- **live** (eval-local): a live guide (it stops at a control the explorer did not open and continues on the page) whose
  steps are the start of an expected path, the missing labels all after them and no other press: not right, not wrong,
  counted on its own. A live guide that went the wrong way is wrong. A click on a radio, checkbox or switch is a field.
  Labels marked `!` in a path are critical.
- **lang**: the answer and every instruction are in the language of the question. Quoted labels («…», "…")
  are left out of the check, since they stay as on screen.
