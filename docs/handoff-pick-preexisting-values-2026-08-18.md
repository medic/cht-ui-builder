<!--
Status handoff for docs/plans/pick-preexisting-context-values.md.
Commits 7f9d576..be5f97e. 2026-08-18.
-->

# Pick pre-existing values — status

Both halves are built, wired end to end, and verified against the four real
configs. Eight commits, `7f9d576..be5f97e`.

## Half B — the picker offers what the config already computes

The picker reported **0** context keys on `config-nssd/chis`. It now reports
**70**. Verified through the live HTTP route, not just in unit tests:

| project | keys | house idiom derived | extras file discovered |
|---|---|---|---|
| nssd/chis | **70** | fallback-to-current | `contact-summary-extras.js` |
| lumbini | **39** | coalesce | `contact-summary.extras.js` |
| cht-default (ours) | **14** | guarded-fallback | `contact-summary-extras.js` |
| gandaki | **9** | guarded-fallback | `contact-summary.extras.js` |

Three channels, consumption before definition, reproducing the plan's own
measured figures exactly (NSSD 63 form calculations / 7 form eligibility / 21
static scan → union 70). **49 of NSSD's 70 keys are visible only through
consumption** — the `*_vax` series, the ANC set, the `baby_*_ctx` families.

Three things the plan asked for that changed on measurement:

- **Scan the `.xlsx`, not the compiled `.xml`.** The plan specifies
  `forms/app/*.xml`. Measured, the sources carry the identical 63 keys and all
  147 occurrences — so scanning what we already parse also works on a project
  nobody has run `convert-app-forms` on.
- **The house idiom is not `once()`.** The plan states NSSD reads context as
  `once(instance(…))`. Measured over NSSD's own cells: `if(REF, REF, .)` 46,
  guarded 40, `once()` 9, bare 2. Defaulting to `once()` would have matched 9
  of 97 — and the answer differs per project, which is why it is derived.
- **The extras filename has two spellings.** `contact-summary.extras.js` (four
  customer configs) and `contact-summary-extras.js` (NSSD *and all four
  templates we ship*). The route hardcoded the first, so it was blind to the
  extras file in NSSD and in every project this tool generates itself.

Honesty is a first-class output: `indeterminate` reports dynamic keys,
template-literal key families and spreads-from-a-call with evidence;
`definitionsFound` distinguishes "looked and found nothing" from "could not
find the context object"; and `unreadableForms` reports workbooks that failed
to parse. The UI says all three.

## Half A — the contact-field path (was a total deploy blocker)

`insertContactFieldRef` wrote the reference without declaring the node, and
`validate-app-forms` fails the **entire** run on one bad XPath — so one form
blocked every form and the app settings. Four parts, all landed:

1. `name` in the scaffold (measured: `contact/name` is declared in 60 real
   forms, referenced in 68 — and of every `../inputs/*` reference in those
   forms, **zero** are undeclared, so the pairing is an invariant real configs
   already hold).
2. Declare-on-demand for anything else, in the same patch so one gesture stays
   one undo. Refuse-and-explain when it cannot be done safely.
3. `danglingRefs` enforces the invariant instead of assuming it — a bare-XPath
   scan channel plus resolution against the form's real `inputs` block, and the
   `../` step count.
4. A real `validate-app-forms` leg in CI (`scripts/validate-generated-forms.mjs`,
   its own job because it needs python + pyxform), asserting **both**
   directions so a validator that stopped looking cannot show green.

## What is NOT done

- **Tier 2, live values.** Out of scope for this queue (the plan's own
  implementation order puts it third). The heads-up stands for whoever takes
  it: `new Function` silently returns `{}` for the UMD bundle, so an execution
  failure must be its own state — a silent `{}` is visually identical to the
  zero-keys bug this work just fixed.
- **R3's literal payload on the instance.** BMI 27.6 / BP 138 / sugar 145 for
  Devi Kumari Thapa lives in `config-nssd/chis`, which we do not commit as a
  fixture. `client/tests/pick-preexisting-values.spec.ts` proves the mechanism
  hermetically (both legs, in CI); the NSSD run with a live instance is a
  manual step.
- **`danglingRefs` skips structural rows**, so 149 real `relevant` cells on
  `begin group` rows go unchecked and the `repeat_count` entry in `REF_COLUMNS`
  is unreachable dead code. Pre-existing, wider than this feature, needs its
  own change.
- **Seven private copies** of the JS scan/skip/match trio remain, and all seven
  share the regex-literal gap fixed in `jsScan.ts`. Consolidating them is a
  mechanical refactor across parsers that carry the round-trip invariant.
- **The `/files` read/write route** still names the two literal filenames.
  Editing the extras file is explicitly out of scope for this plan, so it was
  left alone rather than half-changed.

## For QA

An adversarial review of the first five commits produced 25 findings; 15
reproduced and are fixed in `e8cf5f8`, `9188bed` and `be5f97e`. Two were worth
the whole exercise:

- **Silent data loss.** Opening the calc builder on any `if(…)`-wrapped context
  cell and pressing Save **deleted the calculation** — 87 real cells, 47 of
  them broken before this work started. Single mode was seeded from
  `parsed.otherwise`, which is `"."` for those shapes.
- **`begin_group` / `end_group`.** pyxform accepts the underscore spellings and
  real configs use them: 61 / 85 / 3 / 4 occurrences across 30 of 175 real
  forms, almost all NSSD app forms. Every group-nesting walk in the repo
  matched only the space form, including the canonical `isStructural`. On 8
  real NSSD forms the tool declared nothing, reported a false reason, and still
  wrote the reference — recreating the exact blocker part 1 above set out to
  fix, with the new gate silent on the same forms.

Both were found by pointing real cht-conf + pyxform at generated forms. Nothing
else we run could see either.

Two CI specs in the allowlist were **already red on master** before this work,
from `c66cfcb` adding a row to the mini-config fixture without updating the
specs that count it. Fixed here; the whole allowlist is 34/34.
