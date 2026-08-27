# CHT UI Builder

A no-code editor for [cht-conf](https://github.com/medic/cht-conf) project
folders. Runs locally, reads and writes the project folder on disk, and is
non-destructive by design — the same folder stays deployable with `cht-conf`
before, during, and after you edit it through the UI.

Built for district health teams who want to author CHT app forms, contact
hierarchies, follow-up tasks, and deploys without touching XLSForm cell
syntax, `tasks.js` AST surgery, or the `cht` CLI directly. The local-first
model means there's no platform lock-in: edits land back in your git-tracked
files.

## Quick start

**Prerequisites** — Node ≥ 20 (CI runs 22) and pnpm 11.2.2. If you don't have
pnpm, `corepack enable` installs the exact version pinned in `packageManager`.

> This is a pnpm workspace using the `workspace:*` protocol, and the root
> `package.json` has no `workspaces` field. **`npm install` and `yarn install`
> cannot install it** — they will fail to resolve `@cht-ui/shared`. Use pnpm.

```sh
pnpm install     # also builds `shared` — the client and server import its dist/
pnpm dev
```

Then open **http://localhost:5173**.

`pnpm install` runs a `prepare` hook that builds the `shared` workspace, because
`shared` is consumed through a compiled `dist/` that isn't checked in. If you
ever need it by hand — after a `git pull` that changes the parsers, say —
it's `pnpm --filter @cht-ui/shared build`.

`pnpm dev` starts three processes: the Vite client, the Fastify API, and a
`tsc --watch` on `shared` so parser edits recompile as you type.

| | URL | Notes |
|---|---|---|
| Client | **http://localhost:5173** | proxies `/api` to the server |
| API | http://localhost:5174/api/… | Fastify |

> **Use `localhost`, not `127.0.0.1`, for the client.** Vite binds to `[::1]`
> (IPv6) only, so `http://127.0.0.1:5173` hangs while `http://localhost:5173`
> works. The API is the opposite — it binds `127.0.0.1:5174`, which is why the
> test suite and every internal fetch address it that way.

On the first screen you can either:

- Type the absolute path to an existing cht-conf project folder, or
- Click **Browse…** to pick one with a folder browser, or
- Click **✨ Create new project…** to scaffold a fresh project from a starter
  template. Four ship, in `server/templates/`:

| Template | Ships |
|---|---|
| **CHT baseline** (`cht-default`) | 16 app-form `.xlsx` + settings + translations — **start here** |
| **Malaria screening** (`malaria`) | settings, tasks, targets, contact summary — but **no form `.xlsx`** yet |
| **Blank** (`blank`) | contact types declared, no forms |
| **Empty** (`empty`) | the bare minimum cht-conf will accept |

The last-opened path is remembered in `~/.cht-ui-builder/state.json`.

> You need an actual cht-conf project folder on disk to do anything useful.
> The repo doesn't bundle a deployable one — **CHT baseline** is the fastest
> way to get a project with real forms in it. A minimal fixture used by the
> test suite lives at `client/tests/fixtures/mini-config/` if you just want
> something to open.

## What's in v0.1

Every section below corresponds to one of the sidebar items inside an open
project.

### Overview

Lands you on the project at a glance — path, which expected files exist
(`app_settings/`, `tasks.js`, `contact-summary.templated.js`), and shortcuts
into each major section.

### Hierarchy

Visual editor for `place_hierarchy_types`, `contact_types`, and
`place-types.json`.

- Tree view with NSSD-style paired place + contact-person rendering
- **Topological order derivation** — `place_hierarchy_types` is recomputed
  from the parent graph on every edit, so inserting `ward` between
  `municipality` and `health_facility` produces the right linear chain
  automatically. The previous bug where the visual tree disagreed with the
  saved array is gone.
- Inline **Add type** modal with parent dropdown (no more
  `window.prompt`/`window.confirm`)
- Manual sibling reorder with `←` / `→` nudge controls
- Edits only touch `place_hierarchy_types`, `contact_types`, and
  `place-types.json` — every other key in `base_settings.json` is left
  byte-identical.

### Forms

The biggest section. Authors and edits XLSForms in `forms/app/` and
`forms/contact/`.

- **Kobo-style tile picker** for adding questions — ~30 tiles in 7
  categories (Text, Choice, Number, Date & time, Media, Location,
  CHT-specific, Advanced, Structure). CHT-only widgets badged: `db:person`,
  `select-contact`, `mrdt-verify`, `countdown-timer`,
  `bikram-sambat-datepicker`, etc.
- **Inline choices editor** inside any select_one / select_multiple / rank
  row. Add / reorder / rename options without jumping to the Choices tab
  (which is still there as the bulk view).
- **Unified condition builder strip** above the raw advanced fields:
  `[column ▼] [field ▼] [logic ▼] [value]  + insert`. Picks a column
  (relevant / calculation / constraint / choice_filter), a field, an
  operator, and a value (auto-becomes a dropdown of the field's choices for
  selects). Inserts the assembled fragment into the chosen column.
- **Plain-English column labels** with `❔` tooltips: *"Show this question
  when…"* + raw `relevant` tag underneath. Same pattern for calculation,
  constraint, choice_filter, default, repeat_count, hints, and constraint
  messages.
- **Type-aware advanced panel** — `choice_filter` only renders on selects,
  `repeat_count` only on `begin repeat`, `constraint_message::xx` only when
  a constraint is set.
- **Simple / Full mode toggle** — Simple hides structural / calculate /
  hidden rows so non-developers see only the user-facing questions.
- **Translate tab** — side-by-side per-row × locale grid with
  missing-translation badges per locale.
- **Drag reorder with dependency safety** — drops are blocked when a move
  would orphan a `${field}` reference; violations are highlighted
  continuously.
- **Diff preview before save** — confirms what will change on disk.
- **Appearance picker** with 60+ entries, type-aware filtering, CHT-only
  badges.
- **Inline 🚀 Deploy** shortcut in the form header (disabled until saved).

### Tasks

Structured editor for `tasks.js`.

- Each task is a card with name, title, icon, **priority** (high / medium /
  low), `appliesTo`, `appliesToType`, `appliesIf`, `resolvedIf`, events,
  actions.
- Visual builders for `appliesIf` (contact/report field pickers, comparison
  operators, age + date offset rules) and for events / actions /
  resolvedIf.
- **Translation-key hint** under `title` / `priorityLabel` — when the value
  looks like a translation key (e.g. `task.malaria.followup.title`), shows
  where the EN / NE strings live so non-developers find the
  `.properties` files.
- Save rebuilds only the exported array body via byte-range edit. Imports
  and helpers outside the array stay byte-identical.

### Contact summary

Edits `contact-summary.templated.js` across five tabs — **structured** (the
`context` object: each flag a card with name + JS expression, add / rename /
remove / edit), **values**, **cards**, **helpers** (the predicates in
`contact-summary-extras.js`), and **raw**.

`fields[]` is preserved byte-identical and not editable in this build
(deferred — see *Not in MVP* below).

### Translations

Edits the `.properties` translation files, parsed and rewritten losslessly —
duplicate keys, ordering, and unknown locales are preserved. Task titles
written by the Tasks editor land here as `task.<name>.title` keys.

### Standard codes

FHIR terminology workbench: map form questions to standard codes from the
vendored dictionaries (LOINC, ICD-11, CIEL — no SNOMED, for licensing
reasons, and a CI test enforces that). Mappings round-trip through a sidecar
file; starter packs seed common CHT question shapes. Gated on the project
having app forms.

### Decisions (sign-off)

A read-only aggregated view of every decision-shaped artifact in the
project, rendered as DMN-style decision tables. Categories surfaced:

- Eligibility helpers (predicate functions in
  `contact-summary-extras.js`)
- Context flags (from `contact-summary.templated.js`)
- Form context expressions (`forms/app/*.properties.json`)
- XLSForm `calculation` cells
- Task `appliesIf` rules
- Task `resolvedIf` rules

Each table shows readable conditions, outputs, and which forms / tasks the
decision affects. Designed as a clinician sign-off surface — neither Kobo
nor CommCare exposes this.

### Deploy

Wraps the bundled `cht-conf` CLI.

- **35 actions** surfaced, grouped by category (validate, compile, convert,
  compress, backup, upload, utility, danger).
- **Four chained-run macros**: *Deploy app forms* / *Deploy app settings* /
  *Deploy everything* / *Validate everything (no upload)*. Stop on first
  failure, stream a single combined log via SSE.
- **Friendly error translator** — 13 regex-tagged patterns catch pyxform,
  webpack, optional-chaining, auth, network, port-in-use, and
  missing-directory failures. Plain-English summary with a hint and an
  optional docs URL. **Strictly additive**: raw stderr still streams in
  full, the friendly hint is rendered above it as a warning card. A
  contract test pins byte-equality through the pipeline.
- **Known upstream bugs** (e.g. the cht-conf `compile-app-settings`
  optional-chaining failure) render with a distinct *"upstream — tracked"*
  badge in neutral indigo so they don't read as user errors.
- **Dry-run mode** replays scripted fixtures from
  [server/src/cht-conf/fixtures/](server/src/cht-conf/fixtures/) so you (or
  CI) can rehearse a deploy without touching a real CHT instance.
- **Test connection** button (`cht check-for-updates` against the configured
  target) and a setup-help link.
- Three deploy targets: `--local` (default localhost CHT), `--instance` (a
  hosted Medic Mobile instance), `--url` (any URL). Target + username
  persist in `~/.cht-ui-builder/state.json`; **password is held in memory
  only and never written to disk**.

## Round-trip safety

The non-negotiable invariant: **parse → serialize → parse is byte-stable
for anything the editor doesn't explicitly touch.** Concretely:

- XLSForm parse separates known columns from per-row `extras`; on save,
  unknown columns are written back in their original column position. New
  extras keys are appended to the end (documented and lossless, but the
  only deliberate exception to byte-stability).
- Sheets the parser doesn't understand (e.g. gandaki's `choices-backup`)
  are preserved verbatim.
- Hierarchy edits mutate only `place_hierarchy_types`, `contact_types`, and
  `place-types.json`. Every other key in `base_settings.json` is left
  untouched.
- `tasks.js` edits rebuild only the exported array body via byte-range
  edit; imports and helpers outside the array stay byte-identical.
- Contact-summary edits rewrite only the `context` object; `fields[]` and
  `cards[]` are preserved verbatim.

When changing anything in `shared/`, the bar is: round-trip on real
configs (the smoke test is the lower bound; the round-trip tests in
[shared/src/xlsform/inlineChoices.roundtrip.test.ts](shared/src/xlsform/inlineChoices.roundtrip.test.ts)
and [shared/src/hierarchy/hierarchyOrder.test.ts](shared/src/hierarchy/hierarchyOrder.test.ts)
are the upper bound).

## Tests

**982 tests across three suites.** See [docs/testing-map.md](docs/testing-map.md)
for the per-file index.

```sh
pnpm --filter @cht-ui/shared build && pnpm --filter @cht-ui/shared test
pnpm --filter @cht-ui/server build && pnpm --filter @cht-ui/server test
pnpm --filter @cht-ui/client test:e2e
```

| Suite | Files | Cases | Coverage |
|---|---:|---:|---|
| `shared` (`node --test` over `dist/`) | 56 | 818 | parse/serialize round-trip safety across `xlsform`, `tasks`, `contactSummary`, `preflight`, `fhir`, `hierarchy`, `translations`, `conditionBuilder` |
| `server` (`node --test` over `dist/`) | 7 | 73 | `errorPatterns` regex sanity, `pushLine` additive-pipeline contract (byte-equal stderr reconstruction), parse cache, deploy routes |
| `client` (Playwright) | 29 | 91 | the editor driven through the real UI |

> **The `shared` run prints `✖ failing tests:` and a stack of AssertionErrors,
> then exits 0.** That is expected: 37 cases are `todo` pins in the
> `*.hostile.test.ts` files, each recording the *correct* behaviour for an input
> shape a parser currently gets wrong. A todo flipping to pass is the signal a
> bug is fixed — don't delete them to quieten the output.

**Round-trip smoke test** against any form:

```sh
pnpm --filter @cht-ui/shared build
node scripts/smoke-parser.mjs client/tests/fixtures/mini-config/forms/app/pregnancy.xlsx
# Expected: survey stats + "Round-trip stable: YES"
```

It takes the form path as an argument (or `CHT_FORM`) and has no default —
point it at the committed fixture above, or at a form in your own project.

## Persona-driven dogfood

Each substantive UI change in v0.1 was run through three in-character
review agents before being declared ready:

- **Bhishan KC** — District Health Officer, Gandaki, Nepal. Excel power
  user. Used KoboToolbox once. Never opened cht-conf. Reviews for task
  completion: *can I get my malaria-screening form to a CHW without a
  developer next to me?*
- **Lal Bahadur** — Senior UI/UX/HCD lead. Reviews for affordance,
  microcopy, typographic hierarchy, accessibility (keyboard, ARIA, target
  size, color semantics), and responsive behavior.
- **Anita Tamang** — QA engineer, 6 years health-tech. Reviews for
  testability: fixtures, deterministic replay, CI gating, contract tests,
  reproducibility on a fresh clone.

The personas live as memory files (per-user, outside this repo) and are
spawned in parallel via the workflow tooling. Their friction lists drive
the next sprint's punch list.

## What's deliberately NOT in v0.1

- **Live Enketo form preview** — the current "preview" pane is a simplified
  stacked-field view, not a real XPath evaluator. A real live preview is
  scoped as a separate two-sprint project after the next polish round.
- **`fields[]` editor** in contact summary — preserved byte-identical; the
  visual editor is the next CommCare-parity item after live preview.
  (`cards[]` **is** editable — see *Contact summary* above.)
- **`targets.js`** — explicitly out of scope (user decision).
- **SMS forms** / `registrations[]` / `schedules.json` / `forms.json`
  (Devanagari forms) — preserved verbatim, no UI editor.
- **pyxform invocation on save** — we don't rebuild `*.xlsx` → `*.xml`
  inside the editor. Use the **Deploy → Convert app forms** button (or
  `cht-conf convert-app-forms` from CLI).
- **Git integration** (status / diff / commit) — out of scope.

## Tech stack

Every pick below is a trade-off answer for a tool shaped like this one: **local, single-user,
round-trip-safe, with a shared parser core**. Versions are what the manifests actually declare.

### Foundation

| Package | What it does | Considered instead | Why this one |
|---|---|---|---|
| **pnpm** `11.2.2` | Package manager + monorepo | npm workspaces, Yarn, Nx, Turborepo, Lerna | Needs to link `shared` into client+server via `workspace:*`. pnpm is fast and **strict** — no phantom dependencies, so you cannot import something you never declared. Nx/Turborepo are build-orchestration frameworks: overkill for three packages. npm workspaces are weaker on isolation. |
| **TypeScript** `5.7` | Typed JS | plain JS, Flow, JSDoc types | The **data model is the contract** between all three workspaces — a form parsed in `shared` must type-match what the client renders and the server writes. Types catch drift at that boundary. Flow is effectively dead; plain JS gives no safety on the parser layer, which is exactly where the bugs are dangerous. |
| **Node** `>=20` | Runtime | Deno, Bun | `cht-conf` and the whole CHT tooling ecosystem assume Node. Bun/Deno add compatibility risk for a tool whose job is to shell out to Node CLIs. Boring and compatible beats fast and novel here. |

### Frontend

| Package | What it does | Considered instead | Why this one |
|---|---|---|---|
| **React** `18.3` | UI components | Vue, Svelte, Solid, Angular, Preact | The editor is component- and state-heavy — React's sweet spot — and critically, **the two specialist libraries we need (dnd-kit, React Flow) are React-first**. Vue/Svelte would shrink the pool of ready-made libraries for exactly the hard UI bits. |
| **Vite** `6.0` | Dev server + bundler | Create React App, Next.js, webpack, Parcel | Instant hot-reload, ESM-native, and a **one-line `/api` proxy** to Fastify. Next.js brings SSR/routing/server we don't need; CRA is deprecated and webpack-slow; raw webpack is config-heavy. |
| **Zustand** `5.0` | Global state | Redux Toolkit, Context API, Jotai, Recoil, MobX | We need a **small** shared store (dirty / saving / view / project). Zustand does it in one file with almost no boilerplate. Redux is ceremony at this size; Context causes re-render pain and prop-less coupling; MobX's proxy magic is harder to reason about. |
| **dnd-kit** `6.3` | Drag-and-drop reordering | react-beautiful-dnd, react-dnd, SortableJS, native HTML5 DnD | **Accessible and keyboard-operable out of the box** — reordering survey rows must work without a mouse — plus modern and maintained. react-beautiful-dnd is archived; react-dnd is lower-level; SortableJS is imperative and not React-idiomatic. |
| **React Flow** `11.11` | Node/edge graph | D3, Cytoscape.js, vis-network, mermaid, dagre + custom SVG | The logic graph needs **pan, zoom, arrowed edges and controls for free**. React Flow gives all of that as React components. D3 means building interaction from scratch; mermaid renders static diagrams, not an interactive graph. |

### Backend

| Package | What it does | Considered instead | Why this one |
|---|---|---|---|
| **Fastify** `5.1` | HTTP API | Express, Koa, Hapi, NestJS, raw `http`, Hono | Small, fast, TypeScript-first, clean plugin model — right-sized for an API whose only job is file I/O. Express is older/slower and needs more middleware; NestJS is a heavy DI framework; raw `http` reinvents routing and parsing. |
| **@fastify/cors** `10.0` | Dev cross-origin | `cors` middleware, hand-rolled headers | Official first-party plugin; lets the 5173 dev UI call the 5174 API. No reason to hand-roll. |
| **@fastify/static** `8.0` | Serve the built UI | `serve-static`, a separate web server | Official plugin; in production the API can serve the bundled client from the same origin, so no proxy is needed. |
| **tsx** `4.19` | Run the TS server in dev | ts-node, nodemon + ts-node, `node --loader`, compile-then-run | esbuild-based, fast, ESM-friendly, built-in `watch` — **no build step in the dev loop**. ts-node has ESM friction and is slower; compiling first slows every restart. |
| **cht-conf** `6.5` | Validate + deploy the config | *(reimplement pyxform + deploy ourselves)* | **Not a choice among rivals — it is the canonical CHT tool.** The entire premise is that the folder stays deployable with cht-conf, so the app **runs the real thing** rather than reimplementing it. Reimplementing deploy was a deliberately rejected non-goal. |

### The shared core

| Package | What it does | Considered instead | Why this one |
|---|---|---|---|
| **ExcelJS** `4.4` | Read/write `.xlsx` | SheetJS (xlsx), node-xlsx, write-excel-file | Round-trip safety needs **cell-, column- and sheet-level control** to write back untouched columns verbatim. ExcelJS (MIT) gives that low-level buffer read/write. SheetJS splits features across a paid "pro" tier and has known write-fidelity gaps; node-xlsx is a thin wrapper with less control. |

### Quality & tooling

| Package | What it does | Considered instead | Why this one |
|---|---|---|---|
| **ESLint** `9.17` | Linting (zero-warnings gate) | Biome, oxlint, tslint | Mature, with first-class TypeScript + React plugin coverage. Biome/oxlint are faster but younger with narrower rule/plugin support — risky for a strict `--max-warnings=0` gate. |
| **Prettier** `3.4` | Code formatting | Biome, dprint, `eslint --fix` | The de-facto standard; zero-config consistency. Fine to revisit alongside Biome later, but not worth the churn now. |
| **Playwright** `1.49` | End-to-end browser tests | Cypress, Selenium, Puppeteer, WebdriverIO | Cross-browser, reliable auto-waiting, first-party from Microsoft, and it can drive a **real** browser against the running app. Cypress is single-tab and pushes a paid dashboard; Selenium is flaky/heavy; Puppeteer is Chrome-only and lower-level. |
| **`node --test`** | Unit tests in `shared` | Jest, Vitest, Mocha, AVA | **Zero extra dependencies** — it runs straight over the compiled `dist/` output, which is exactly the round-trip artifact we want to test. Jest is heavy with ESM config pain; Vitest is excellent but would add a dependency for something Node now does natively. |

> **One caveat on that last row, learned the hard way.** Testing the compiled artifact is necessary
> but not sufficient: fixtures written in the shape the code already expects will pass while the
> code corrupts real input. Round-trip tests must exercise the **serializer** over
> **non-canonical** fixtures. See [Round-trip safety](#round-trip-safety).

## Project layout

```
.
├── client/                     Vite + React 18 + TypeScript (port 5173)
│   ├── src/
│   │   ├── state/              Zustand store + useHistory<T> undo hook
│   │   └── ui/                 Editor components
│   └── tests/                  Playwright specs + the committed
│                               fixtures/mini-config project
├── server/                     Fastify 5 API (port 5174)
│   ├── src/
│   │   ├── cht-conf/           Error patterns, dry-run driver, fixtures
│   │   ├── routes/             project / forms / hierarchy / tasks /
│   │   │                       contact-summary / templates / cht-conf /
│   │   │                       fhirMapping / dictionaries / deploy
│   │   └── state.ts            ~/.cht-ui-builder/state.json persistence
│   └── templates/              Starter projects (cht-default, malaria,
│                               blank, empty)
├── shared/                     Parsers, serializers, types (the core)
│   └── src/
│       ├── xlsform/            parse, serialize, types, dependencies,
│       │                       relevantParser, calculationBuilder,
│       │                       renameList, diff
│       ├── tasks/              jsParser, contactSummaryParser,
│       │                       appliesIfParser, eventsParser, ...
│       ├── contactSummary/     context-key discovery, cards parser
│       ├── conditionBuilder/   rule-builder state machine
│       ├── preflight/          pre-save validation rules
│       ├── fhir/               mapping codec, dictionaries, starter packs
│       ├── hierarchy/          hierarchyOrder (topological derivation)
│       └── translations/       .properties parse/edit
├── docs/                       Plans, handoffs, reviews, testing-map.md
├── .github/workflows/ci.yml    build + test + pyxform oracle + e2e
└── scripts/                    smoke-parser, corpus-sweep,
                                validate-generated-forms, ...
```

## Commands

```sh
pnpm install                            # Restore deps + build shared (pnpm only)
pnpm dev                                # client + server + shared tsc --watch
pnpm build                              # Build all workspaces
pnpm typecheck                          # typecheck every workspace
pnpm lint                               # eslint --max-warnings=0  (see note)
pnpm format                             # prettier --write        (see note)

# Shared-only iteration:
pnpm --filter @cht-ui/shared build      # or `dev` for tsc --watch
pnpm --filter @cht-ui/shared test       # node --test over dist/**/*.test.js

# Server-only iteration:
pnpm --filter @cht-ui/server build
pnpm --filter @cht-ui/server test

# Browser-driven e2e (needs shared + server built first):
pnpm --filter @cht-ui/client test:e2e
pnpm --filter @cht-ui/client test:e2e:ui
```

The Shared workspace must be built before client/server typecheck resolves its
workspace import. `pnpm install` does this for you via the `prepare` hook;
rebuild by hand after pulling parser changes if the watcher isn't running.

> **`pnpm lint` is currently red** — ~115 problems, almost all pre-existing
> `no-undef` false positives from an eslint config that declares no browser
> globals, plus dead `eslint-disable` directives. CI runs build, typecheck,
> tests, the pyxform oracle and e2e, but the lint step is commented out
> pending a cleanup PR — see the note in
> [.github/workflows/ci.yml](.github/workflows/ci.yml). Treat the
> zero-warnings gate as the intent, not the current state.
>
> **`pnpm format` rewrites ~235 files** — the tree has never been fully
> Prettier-formatted. `.prettierignore` keeps it away from the lockfile,
> vendored dictionaries, and the CHT-shaped fixture/template projects (which
> must stay byte-identical to what `cht-conf` writes), but a bulk format is
> still its own commit. Format the files you touch, not the repo.

## Contributing

See [CLAUDE.md](CLAUDE.md) for the dev workflow, the round-trip invariant
in detail, and the conventions enforced (zero-warnings lint, ESM
everywhere, dependency-aware reorder validation).

## Copyright

Copyright 2026 Medic Mobile, Inc. <hello@medic.org>

## License

The software is provided under AGPL-3.0. Contributions to this project are
accepted under the same license.
