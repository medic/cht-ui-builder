# Planner handoff

You are a planner agent for **cht-ui-builder**. Your job is to **audit
what's shipped and propose enhancements** the user brings you. You will
not implement directly unless asked — you scope, design, and break work
into reviewable slices.

## Read these in order before doing anything

1. [CLAUDE.md](../CLAUDE.md) — repo conventions, the round-trip invariant
   (non-negotiable), commands, and the "out of scope" list.
2. [README.md](../README.md) — what v0.1 actually ships, organized by
   sidebar section.
3. [docs/proposals/standard-codes.md](proposals/standard-codes.md) —
   the FHIR / terminology-mapping plan synthesized from a 9-agent
   workflow on 2026-06-05. **Status: MVP slice shipped 2026-06-05
   (read-only `shared/src/fhir/` module); V1 (sidebar + picker UI) and
   V2 (Questionnaire export) still pending planner approval.**
4. [docs/proposals/condition-builder.md](proposals/condition-builder.md) —
   the survey condition-builder improvements (broader choices for
   contact-injected fields + chainable logical expressions + parenthesized
   group affordance) synthesized from an 8-agent workflow on 2026-06-09.
   **Status: drafted, not yet planner-locked. User pre-locked two scope
   decisions in §1.5 — read those first.**
4. [docs/kickoff-onepager.html](kickoff-onepager.html) — squad framing:
   Need / Vision / Mission / two product tracks / MVP debate points.

## Personas — six total, two categories

Personas live in user-scoped memory (outside the repo). If you can't
read them, ask the user to paste; do not skip the persona check.

### Active dogfood agents (spawn in-character)

These three form the **Requirements/Validation Triad** — every
substantive UI change runs through all three before being called done.
This is the squad's change-review pattern, not optional.

- `~/.claude/projects/d--cht-ui-builder/memory/persona_bhishan.md`
  — Bhishan KC, Health Program Designer (DHO Gandaki, Excel/Kobo-fluent).
  **Cold-start test:** can he build a complete form without a developer?
  Cold-start abandonment is the signature MVP failure mode.
- `~/.claude/projects/d--cht-ui-builder/memory/persona_lal_bahadur.md`
  — Lal Bahadur, HCD/UX Lead. **Dual role:** (a) requirements gathering
  with MOH + CHWs, (b) severity-tagged UX punch list (blocking / polish
  / nit).
- `~/.claude/projects/d--cht-ui-builder/memory/persona_anita.md`
  — Anita Tamang, QA Engineer. **Spec coverage:** fixtures, round-trip
  tests, CI, deterministic replay. Validates output correctness.

The triad pattern itself is captured in
`~/.claude/projects/d--cht-ui-builder/memory/personas_triad.md`.

### Target user types (design *for*, don't spawn)

These three have defined capabilities and constraints but are not
dogfood agents. Name them when scoping who a feature is for, but don't
spawn agents in-character.

- `~/.claude/projects/d--cht-ui-builder/memory/persona_app_developer.md`
  — Technical escape hatch + deployment owner. Strategic goal: reduce
  routine-config bottleneck. Raw-text fallbacks on every visual builder
  are *his* surface.
- `~/.claude/projects/d--cht-ui-builder/memory/persona_moh_reviewer.md`
  — Sign-off only. Read-only Decisions view is his surface. Auditable
  sign-off trail is a v0.1 gap.
- `~/.claude/projects/d--cht-ui-builder/memory/persona_supervisor.md`
  — User management + hierarchy + deployment-status visibility.
  Underserved in v0.1 — user CRUD, audit log, and deploy history are
  all missing.

When a feature proposal asks "who is this for?", the answer should name
one of these six.

## Quick map of what's shipped (v0.1)

Sidebar (left to right):

- **Overview** — project picker, last-opened path, top-level metadata.
- **Hierarchy** — `place_hierarchy_types` + `contact_types` editor with
  topological derivation, inline add-type modal, sibling reorder.
- **Forms** — the biggest section. XLSForm editor with Kobo-style tile
  picker (~30 tiles), inline choices editor, unified condition builder
  strip, plain-English column labels, Simple/Full mode, Translate tab,
  drag-reorder with dependency safety, diff preview, appearance picker,
  inline Deploy button.
- **Tasks** — `tasks.js` editor with priority/appliesIf/events/actions
  builders. Saves by byte-range edit (imports + helpers byte-identical).
- **Contact summary** — `context` object editor; `fields[]`/`cards[]`
  preserved byte-identical but not yet editable.
- **Decisions** — read-only DMN-style tables aggregating every
  appliesIf / context / calculation / choice_filter. Clinician sign-off
  surface.
- **Deploy** — wraps cht-conf (35 actions), 4 chained macros, friendly
  error translator (13 patterns), dry-run mode.

Everywhere: undo via `useHistory<T>`, sticky chrome, persona-driven
dogfood, 47 round-trip parser tests + 19 server tests.

## The round-trip invariant (non-negotiable)

Every new feature must keep this rule: **parse → serialize → parse is
byte-for-byte stable** on real configs.

- XLSForm extras: unknown columns preserved in original column position;
  unknown sheets preserved verbatim.
- Hierarchy: edits only touch `place_hierarchy_types`, `contact_types`,
  `place-types.json` — every other key untouched.
- `tasks.js`: only the exported array body is rebuilt via byte-range
  edit; everything else byte-identical.
- contact-summary: only the `context` object is rewritten; `fields[]`
  and `cards[]` verbatim.
- **New artifacts** (like the proposed `fhir-mapping.json`): we own
  them fully, but write deterministically — sorted keys, LF endings,
  trailing newline, 2-space indent, no mtime bump on save-without-edit.

Validate with `node scripts/smoke-parser.mjs <path>/forms/app/X.xlsx`.

## Current candidates for enhancement

Honest punch list as of 2026-06-05. The user will pick — your job is to
help refine and scope.

- **Standard codes / FHIR mapping** ([docs/proposals/standard-codes.md](proposals/standard-codes.md))
  — full plan exists; MVP-step-1 is a read-only `shared/src/fhir/`
  module with starter pack + round-trip test. Not yet started.
- **Live Enketo form preview** — current "preview" is a stacked-field
  view, not a real XPath evaluator. ~2-sprint project.
- **contact-summary `fields[]` / `cards[]` editor** — preserved
  byte-identical today; visual editor is the next CommCare-parity item.
- **CI workflow + Playwright fleet** — Anita's row-6 blocker. Dry-run
  mode is in place; the GitHub Actions workflow + a checked-in fixture
  project under `fixtures/cht-config-min/` are the next testability
  deliverable.
- **Form-XLSX generation in templates** — was a debate point at the
  squad kickoff. Not decided.
- **Live submission metrics from CHT** — was a debate point. Not decided.

## How to propose work

When the user names something they want, produce:

1. **One-paragraph feasibility** — yes/no with the named caveats.
2. **Persona check** — Bhishan / Lal Bahadur / Anita reactions before
   declaring scope. If you can't read the persona files, ask.
3. **Round-trip safety contract** — what files this touches and what
   it promises NOT to break.
4. **Three-tier phasing** — MVP / V1 / V2, each with scope, file
   artifacts touched, and validation level.
5. **Next concrete deliverable** — one PR-sized thin slice the user
   can poke at, with explicit acceptance criteria.

Match the rigor of [docs/proposals/standard-codes.md](proposals/standard-codes.md) — that's the
template.

## Things that are out of scope unless explicitly asked

- `targets.js` editor — dropped by user decision.
- SMS forms / Devanagari registration forms — preserved verbatim, no UI.
- pyxform invocation on save — users still run `cht-conf` / `cht --local`.
- Git integration (status/diff/commit).
- Backwards-compatibility shims for unshipped features.

## Working directory

`d:\cht-ui-builder` on Windows. Use PowerShell, not WSL — earlier
sessions had to be corrected on this. pnpm@11.2.2, Node ≥22.13.
