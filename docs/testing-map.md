<!--
Index of the test suite: what exists, what each file covers, what it needs to
run. Every test file already carries its own header comment explaining its
purpose — this is the map across them, not a replacement for those.
-->

# Testing map

Two suites, run by different tools, answering different questions.

| Suite                 | Location                  | Runner                                  | Files | Tests                                       | Needs                               |
| --------------------- | ------------------------- | --------------------------------------- | ----- | ------------------------------------------- | ----------------------------------- |
| **Unit / round-trip** | `shared/src/**/*.test.ts` | `node --test` over **compiled** `dist/` | 56    | 806 declared (**818** with nested subtests) | nothing                             |
| **End-to-end**        | `client/tests/*.spec.ts`  | Playwright                              | 29    | 91                                          | dev server; 10 also need a live CHT |

```sh
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm --filter @cht-ui/client test:e2e
```

**`shared` tests run against `dist/`, not source — build first or you are testing
the previous version.** Current state: **781 pass, 0 fail, 37 todo**. The todos are
deliberate (see _Hostile corpus_ below), not failures.

---

## Why the split

`shared/` is the core: the parsers and serializers that read a real cht-conf
project and write it back. Its one non-negotiable invariant is **round-trip
safety** — parse → serialize → parse must be byte-stable for anything the tool
doesn't explicitly edit. That is a pure-function property, so it is tested
without a browser, and it is where most of the coverage lives.

The Playwright specs answer the other question: _does the product actually let a
non-developer do this?_ They drive the real UI. Several exist because a bug was
only visible at runtime — the `modifyContent` binding rule and the Enketo
choice-label behaviour were both found this way and are invisible to unit tests.

---

## `shared/` by module

| Module             | Files | Tests | What it protects                                                                  |
| ------------------ | ----- | ----- | --------------------------------------------------------------------------------- |
| `xlsform`          | 23    | 321   | XLSForm parse/serialize, survey edits, renames, scaffolds, structural balance     |
| `tasks`            | 14    | 211   | `tasks.js` and `contact-summary.templated.js` JS-source parsing, byte-range edits |
| `conditionBuilder` | 1     | 57    | the rule-builder state machine                                                    |
| `preflight`        | 6     | 57    | pre-save validation rules (dangling refs, identifiers, required files)            |
| `contactSummary`   | 2     | 55    | context-key discovery, cards parser                                               |
| `fhir`             | 6     | 48    | FHIR mapping codec, dictionaries, starter packs                                   |
| `hierarchy`        | 2     | 31    | `place_hierarchy_types` derivation, linear-hierarchy scaffold                     |
| `translations`     | 2     | 26    | `.properties` parse/edit                                                          |

### The shapes that recur

**`*.roundtrip.test.ts`** — the invariant suites. Parse a real-shaped input,
serialize, re-parse, assert byte-stability. `appliesIfParser.roundtrip` (59
tests) is the largest single file in the repo and the pattern to copy when adding
parser behaviour.

**`*.hostile.test.ts`** (8 files, 37 todos) — the hostile corpus. Each pins the
_correct_ behaviour for an input shape the parser currently gets wrong, marked
`todo` so the suite stays green. **A todo flipping to pass is the signal the bug
is fixed** — the developer removes the marker in the same commit as the fix.
Never delete a todo to make the suite quieter.

- `tasks/`: `actionsParser`, `appliesIfParser`, `contextExpressionParser`,
  `helpersParser`, `jsSerializer`, `resolvedIfParser`
- `translations/propertiesParser`, `xlsform/parse`

**`jsSerializer.test.ts`** — loads every shipped template's `tasks.js`, saves it
with zero edits, and asserts the bytes are unchanged. This is the test that
catches "the serializer emits its own conventions instead of what it read".

---

## Playwright specs

### Tier 1 — offline, no CHT instance (15 specs)

Run against the committed fixture `client/tests/fixtures/mini-config`. A fresh
clone runs these with no configuration.

| Spec                               | Tests | Covers                                             |
| ---------------------------------- | ----- | -------------------------------------------------- |
| `form-editing`                     | 12    | the bread-and-butter UAT editing flows on a survey |
| `condition-builder`                | 11    | the visual rule builder                            |
| `geriatric-build`                  | 10    | building a multi-section form through the UI       |
| `fhir-mapping`                     | 6     | FHIR server-route contracts                        |
| `helper-builder`                   | 5     | contact-summary → Helpers tab                      |
| `demo`                             | 4     | three watchable chapters driving the real UI       |
| `geriatric-blockers`               | 4     | buildability blockers, numbered §1–§4              |
| `hierarchy-ux-polish`              | 4     | hierarchy-editor polish items                      |
| `form-context-types`               | 3     | the "Contact type is" dropdown                     |
| `contact-form-tile-classification` | 2     | bare `string` row classification                   |
| `form-data-passing`                | 2     | cross-form references                              |
| `geriatric-iha-demo`               | 2     | full-scale form build + demo recording             |
| `pick-preexisting-values`          | 2     | contact-summary value picker                       |
| `quick-hierarchy`                  | 2     | Quick Hierarchy Creator                            |
| `poc-build`                        | 1     | rebuild a project from scratch through the UI      |

### Tier 2 — needs a real cht-conf project (`CHT_PROJECT`) (4 specs)

Build into a project rather than just reading one. All default to the fixture;
set `CHT_PROJECT` to drive a real config.

| Spec                                | Covers                                            |
| ----------------------------------- | ------------------------------------------------- |
| `geriatric-nssd-build`              | builds the assessment form into the target config |
| `geriatric-nssd-followup-build`     | builds the follow-up form                         |
| `geriatric-nssd-task-build`         | builds the task connecting the two                |
| `geriatric-nssd-task-fix-appliesif` | regression: the OR-pill logic bug                 |

### Tier 3 — needs a live CHT instance (10 specs)

These deploy and assert on runtime behaviour. They need Docker, a deployed
config, and seeded contacts, so they are **not** fresh-clone runnable.

`anc-build-deploy`, `anc-build-deploy-only-3-anc`, `anc-full-arc-demo`,
`cht-anc-demo`, `geriatric-full-arc-demo`, `geriatric-nssd-full-arc`,
`geriatric-nssd-live-flow`, `geriatric-task-demo`, `geriatric-workflow-e2e`,
`task-title-i18n-deploy`

Several are marked in their own headers as **recordings, not CI tests** — one
continuous take for a demo video. They are kept because they are also the only
proof of the full loop, but they are not part of a normal run.

---

## Shared fixtures and helpers

| File                                          | Role                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/tests/setup.ts`                       | exports `PROJECT_PATH` (defaults to the committed fixture, override with `PLAYWRIGHT_PROJECT_PATH`), the auto `projectOpen` fixture, and `makeScratchProject()` |
| `client/tests/fixtures/mini-config/`          | committed minimal cht-conf project — checked in so a fresh clone runs                                                                                           |
| `client/tests/fixtures/build-mini-config.mjs` | regenerates that fixture                                                                                                                                        |
| `client/tests/helpers/geriatric.ts`           | demo assessment content + the builder drivers (`addSection`, `addRow`, `setRelevance`, `saveForm`, …), imported by 8 specs                                      |

**Specs that build must not write into the committed fixture.** Use
`makeScratchProject()` — it `mkdtemp`s and copies `PROJECT_PATH`, so the fixture
stays clean and every run starts from the same place.

⚠️ `helpers/geriatric.ts` content is **synthetic demo material, not clinical
guidance** — see the warning in its header. The identifiers (`refer_*`,
`yes_fail`, `not_see_612`, …) are stable because specs assert on them; the
labels are invented.

---

## Environment variables

| Variable                  | Effect                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `PLAYWRIGHT_PROJECT_PATH` | project the whole suite opens (default: the fixture)                    |
| `CHT_PROJECT`             | project the build specs write into (default: `PROJECT_PATH`)            |
| `BUILD_OUTPUT_DIR`        | where build specs put generated projects (default: OS temp dir)         |
| `ANC_OUTPUT_DIR`          | same, for the ANC specs                                                 |
| `CHT_BIN`                 | path to the `cht` binary (default: resolved from `server/node_modules`) |
| `DEMO=1`                  | slow the run down for screen recording                                  |
| `LIVE_DEPLOY=1`           | opt into the deploy step in `task-title-i18n-deploy`                    |

---

## Adding tests

**Parser or serializer change** → add a `node --test` case in
`shared/src/**/*.test.ts`. Follow `appliesIfParser.roundtrip.test.ts`. The bar is
parse → serialize → parse byte-stable on realistic input. A test that never calls
the serializer does not protect round-trip safety — that gap once shipped a
fail-open corruption bug through a fully green suite.

**A bug the parser gets wrong today** → add it to the matching
`*.hostile.test.ts` as `todo`, pinning correct behaviour. The fix flips it.

**UI capability** → add a Playwright spec. Keep it Tier 1 if you can; reach for a
live instance only when the behaviour genuinely only exists at runtime.

**Every test file carries a header comment** explaining its purpose and the plan
or handoff item it traces to. Keep that up — it is why this map could be
assembled from the files themselves.
