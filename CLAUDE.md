# CLAUDE.md

Guidance for Claude Code working in this repo. See `README.md` for the full
feature list and phase-by-phase scope; this file covers how to work here.

## What this is

A no-code editor for **cht-conf project folders**. It runs locally and reads /
writes a project folder on disk so the same folder stays deployable with
`cht-conf`. The whole point is **non-destructive editing**: open a real CHT
config, change it through the UI, write it back without disturbing anything the
UI doesn't explicitly own.

## Stack & layout

pnpm monorepo (`pnpm@11.2.2`, Node ≥ 20). Three workspaces:

- `client/` — Vite + React 18 + TypeScript, Zustand store, dnd-kit, React Flow.
  UI on port **5173**. Editor components live in `client/src/ui/`.
- `server/` — Fastify 5 API on port **5174** (client proxies `/api` to it).
  Routes in `server/src/routes/`: project, forms, hierarchy, tasks,
  contactSummary.
- `shared/` — the parsers/serializers/types. **This is the core of the project.**
  - `shared/src/xlsform/` — XLSForm `parse`, `serialize`, `types`,
    `dependencies`, `relevantParser`, `calculationBuilder`, `diff`.
  - `shared/src/tasks/` — JS-source parsers for `tasks.js`,
    `contact-summary.templated.js`, context expressions, etc.

`client` and `server` both depend on `shared` via `workspace:*`. `shared` has
no `dev`-time transpile for consumers — it builds to `dist/`, so **`shared` must
be built before the client/server typecheck cleanly**.

## Commands

```sh
pnpm install              # restore deps
pnpm build                # build all workspaces (shared, then client/server)
pnpm dev                  # run client + server in parallel
pnpm typecheck            # tsc -b across all workspaces
pnpm lint                 # eslint, zero-warnings enforced
pnpm format               # prettier write

# shared-only iteration
pnpm --filter @cht-ui/shared build      # or `dev` for tsc --watch
pnpm --filter @cht-ui/shared test       # node --test over dist/**/*.test.js
```

Note `pnpm test` only exists in `shared` (uses Node's built-in test runner over
**compiled** output — build first). Client tests are Playwright e2e
(`pnpm --filter @cht-ui/client test:e2e`).

## You need a cht-conf project folder to actually test

This repo does **not** contain any CHT config. The app operates on an external
folder whose absolute path you enter on the first screen — the directory holding
`app_settings.json` and `forms/`. **Clone or obtain a cht-conf project folder
before expecting the editor (or the smoke test) to do anything.** The last-opened
path is remembered in `~/.cht-ui-builder/state.json`.

Scripts that need a project folder take it as an argument or via the
`CHT_PROJECT` environment variable — none of them hardcode a path.

## Non-negotiable invariant: round-trip safety

Every parser/serializer must be **lossless** for things it doesn't edit:

- XLSForm parse separates known columns from per-row "extras"; on save, unknown
  columns are rewritten in their original column position. Sheets the parser
  doesn't understand (e.g. gandaki's `choices-backup`) are preserved verbatim.
- Hierarchy edits mutate only `place_hierarchy_types`, `contact_types`, and
  `place-types.json`; every other key in `base_settings.json` is untouched.
- `tasks.js` edits rebuild only the exported array body via byte-range edit;
  imports and helpers outside the array stay byte-identical.
- contact-summary edits rewrite only the `context` object; `fields[]` and
  `cards[]` are left verbatim.

When touching anything in `shared/`, the bar is: **parse → serialize → parse is
byte-for-byte stable** on real configs. Validate with the smoke test:

```sh
pnpm --filter @cht-ui/shared build
node scripts/smoke-parser.mjs <path-to-a-real>/forms/app/pregnancy.xlsx
# expect: survey stats + "Round-trip stable: YES"
```

Prefer adding a `node --test` case in `shared/src/**/*.test.ts` for new parser
behavior (see `appliesIfParser.roundtrip.test.ts` as the pattern).

## Conventions

- TypeScript, ESM (`"type": "module"`) everywhere. `tsconfig.base.json` is the
  shared base; each workspace extends it.
- Lint is zero-warnings (`--max-warnings=0`) — don't leave warnings.
- Dependency-aware UX: the survey editor blocks reorders that would move a row
  ahead of a `${field}` it references. Keep that validator authoritative when
  editing ordering logic (`shared/src/xlsform/dependencies.ts`).
- Visual rule builders fall back to a raw-text editor for any expression outside
  their supported grammar, and **preserve the raw text on save**. Maintain that
  fallback rather than rejecting unparseable input.

## Workflow & subagent cost discipline

Measured from this project's transcript history: ~90% of subagent token spend
was `Workflow` fan-out running at top model tier, because no `agent()` call
ever set a model. When authoring a `Workflow` script in this repo, tier every
stage instead of leaving it to inherit the session model:

```js
agent(scanPrompt, { agentType: 'searcher' }); // pure file/symbol location
agent(logPrompt, { agentType: 'log-scanner' }); // extract failures from build/test/CI output
agent(refutePrompt, { model: 'sonnet' }); // redundant "is this real?" voter
agent(synthPrompt, { effort: 'high' }); // synthesis / persona lens / final verify
```

`searcher` and `log-scanner` (both `model: haiku`, read-only tools) are defined
in `.claude/agents/` — prefer them over `Explore`/`general-purpose` for pure
search or log-triage fan-out. Reserve top tier for stages that actually make a
judgment call: synthesis, persona lenses (PO/Designer/QA dogfood), final
verify/scoping. Full rules and rationale: `docs/workflow-cost-authoring.md`. An
`agent()` call with no `model`/`effort`/`agentType` and no stated reason it
needs top tier is the default mistake this section exists to prevent.

## Out of scope (don't build unless asked)

targets.js (dropped by user decision), SMS/Devanagari forms (preserved, no
editor), pyxform recompile on save (users still run `cht-conf` /
`cht --local`), live enketo preview, and git integration. See README
"What's deliberately not in MVP".
