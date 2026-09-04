<!--
Plan for hosted, multi-user, no-install CHT authoring ("rung 1"). Written from
measurements against the codebase and the four real configs on 2026-08-20.
Decisions in §4 were made by the PO on 2026-08-20. Built on 2026-09-04 — see §0.
-->

# Hosted CHT authoring

**Status:** BUILT (rung 1) · **Branch:** `feat/hosted-authoring` · **Run it:** `docs/hosted-deploy.md`

## 0. What was built, and where it departs from the plan below

Everything in §11 landed, in order. Verified by `scripts/hosted-acceptance.mjs`
(43 assertions, both modes, in CI) and by running `validate-generated-forms` and
`validate-templates` inside the image.

| plan item | landed as |
|---|---|
| §8.1 Dockerfile | `Dockerfile` + `.dockerignore`: node 22, python 3.11 + pyxform 4.5.0 in a venv, git; builds shared/server/client; serves the client from the same origin (`SERVE_CLIENT=1`). Toolchain proven inside the image. |
| §9 `cht-default` / `moment` | Two-part fix. The template now ships a `package.json` declaring `moment` (as cht-core's own config does). The image also installs `moment` at `/node_modules`, because webpack resolves bare imports by walking `node_modules` **up** from the project folder, so every project under `/data` resolves it with no `npm install` and nothing added to the user's project. cht-conf does **not** ship moment itself — that assumption in §9 was wrong. |
| §9 template compile guard | `scripts/validate-templates.mjs` + CI job `templates-validate`: copies each template (dotfiles included), `npm install`s if it has a package.json, runs compile + convert + validate for app and contact forms. All four pass. |
| §8.2 Auth | `server/src/auth.ts`: email + password, scrypt hashes, bearer tokens (sha256 stored), 30-day sessions, JSON files under `DATA_ROOT/auth`. `onRequest` hook stamps `req.userId`; the SSE stream route alone also accepts `?token=` (EventSource cannot set headers — the §8.2 gotcha). Desktop mode: one implicit `local` user, no sign-in. |
| §6.1 / §8.3 one commit | `state.ts` rewritten around a **per-user registry** (`registry.json`) and `x-project-id` on every request (`?project=` for SSE). `getProjectPath`/`setProjectPath` are gone; `resolveInsideProject(req, rel)`, `projectRootFor(req)`, `getDeployConfig(userId)` thread through all 31 sites. Desktop compatibility: the old `state.json` is migrated into the registry on first load, and a request with **no** id falls back to the last-opened project in desktop mode only — which keeps "reopen the browser, land in your project" and the Playwright suite's `POST /api/project/open` working. |
| §6.2 delete `browse` | **Departure:** moved to `routes/browse.ts` and registered **only when `CHT_UI_MODE=desktop`**, rather than deleted. The desktop app keeps its folder browser (§4 "the desktop app stays"); the hosted surface has no browse routes at all — not jailed, absent. |
| §6.3 layout | `DATA_ROOT/users/<userId>/projects/<slug>` (plus `users/<userId>/registry.json` and `auth/`). One extra level vs. the plan so auth files cannot collide with a user directory. In hosted mode every resolution additionally refuses an entry outside the user's projects dir. |
| §8.4 registry | `GET /api/projects`, `POST /api/projects/open {id}`, `PATCH`/`DELETE /api/projects/:id` (`?files=1` deletes from disk only under the user's projects dir), `POST /api/templates/create {template, name}`. `POST /api/project/open {path}` remains, desktop-only. |
| §8.5 import / export | `routes/transfer.ts`: `import-git` (shallow clone, size budget, project root found up to two levels down — nssd's `chis/`), `export-git` (add, commit, push `HEAD:refs/heads/<branch>`), `import-zip` (raw body, `adm-zip`, zip-slip refusal, common-root stripping, §6.5 exclusions), `export.zip`. Zip needed no multipart parser: the file is the request body. |
| §8.6 client base URL | `VITE_API_BASE` read once in `api.ts`, which also adds `Authorization` and `x-project-id` to every call. Project id lives in **sessionStorage** — per tab — so two tabs edit two projects. |
| §12 acceptance | `scripts/hosted-acceptance.mjs` (API level, spawns the server in both modes) in CI. The browser-level Playwright leg is not written yet; the desktop specs still pass through the unchanged `#project-path` path. |
| client | `SignIn`, a project list on `ProjectPicker` (open / delete / start blank / template / import git / import zip; the path input stays in desktop mode), the wizard asks for a name instead of a folder when hosted, `ProjectTransfer` on the overview (download zip; push branch for git imports). |

Still true from §10: last-write-wins for two people on one config; one API instance per volume; no deploy credentials reach the hosted server (rung 1 has no upload).

## 1. Why

CHT's value — offline-first workflows, tasks, longitudinal contact records — is
**invisible to anyone who cannot get past setup.** Today, before you see a single
form, you need git, node, pnpm, python, cht-conf, a checkout, and somewhere to
run CHT.

Kobo has no wall. Someone responding to a flood in China, or gathering child
health data in the US, opens a browser and starts. We have a better authoring
tool for a more capable platform, and almost nobody can reach it.

So this is a **test platform**: try CHT, build something real, see whether it
fits — without installing anything. It doubles as the evaluation channel we do
not currently have, and it feeds the desktop app once someone is serious.

## 2. What we are building

```
sign up → start BLANK or from a template
        → build forms / hierarchy / tasks in the browser
        → live preview with real skip logic, calculations, constraints
        → compile + convert + validate with the real cht-conf toolchain
        → download a deployable project
```

Both entry points are first-class. Blank is not a fallback — it is the honest
starting point for a use case nobody has templated, which is exactly the
flood-researcher case.

**Definition of done.** A person with no CHT knowledge and nothing installed
produces a project that passes `compile-app-settings`, `convert-app-forms` and
`validate-app-forms`, and that a CHT admin deploys unchanged.

## 3. What this changes, and what it keeps

Nothing is broken today. The current app works completely — for **one person,
on their own machine, editing folders on that machine.** Every work item below
removes exactly one of those three assumptions and nothing else.

| work item | assumption removed | kind |
|---|---|---|
| Dockerfile + volume | the server runs on your laptop | add — same server, packaged elsewhere |
| Auth + `userId` on the request | there is one user (today: no concept of a user at all) | add |
| Project ids, per-user state, 31 call sites | one open project; paths are your own disk | amend — `state.ts` (92 lines) is the only real rewrite |
| Project registry | you find a project by browsing your disk | replace `browse` (~150 lines) |
| Git / zip import + export | your config is on the same disk as the server | add — the only way in or out once disk is not shared |
| Client API base URL | client and server share a host | amend — one line |

**Untouched:** `shared/` (25,386 lines, 818 tests — every parser and
serializer), `client/src` (22,621 lines — the whole editor), and the ~4,000
lines of server route logic. Only how each route learns *which project* changes.

## 4. Scope boundaries — decided by the PO, 2026-08-20

- **Rung 1 only.** No upload to live instances, no hosted CHT runtime. Hosting
  CHT per tenant is a hosting business (CouchDB + api + sentinel per
  deployment) with real legal exposure; it must not gate the authoring win.
- **The user's data, the user's liability.** A test platform: build and validate
  here, deploy to your own CHT.
- **Blank start is first-class**, alongside templates.
- **Zip import is in.**
- **The desktop app stays.** Hosted for people with nothing; desktop for real
  configs like NSSD. Same codebase.

## 5. Architecture

**Vercel serves the client** — already a static Vite build. One change: the 42
relative `/api/…` calls in `api.ts` need an absolute base URL from an env var,
set in `jsonFetch`, the single outbound chokepoint.

**A container serves the API** (Fly / Render / Railway): node + python +
pyxform + cht-conf, and a volume at `/data`. The container is not optional:

| blocker | evidence |
|---|---|
| cht-conf shells out to python + pyxform | `routes/cht-conf.ts:11` spawns the binary; `convert-app-forms` fails without pyxform (verified) |
| the filesystem is the data model | 74 `fs.*` call sites across 13 server files |
| state lives on the machine | `state.ts:31` → `~/.cht-ui-builder/state.json` |
| run output is a minutes-long SSE stream | `cht-conf.ts:749-756` |

None of those survive a serverless runtime.

## 6. Technical decisions

### 6.1 Delete `projectPath` from server state

`state.ts:34` — `let cached: StateFile | null` — is the **only single-slot state
in the entire server**. Every other cache is already keyed per project
(`parsedFormCache` by `(absPath, mtime, size)`; `contactChoicesCache` by
`projectPath`).

Address projects by **id** on each request instead, resolving
`/data/<userId>/<projectId>` server-side. One decision, three wins:

- `getProjectPath` (13 sites) and `setProjectPath` (4) disappear outright,
  leaving 31 sites to thread instead of 48;
- one person can edit several configs in several tabs simultaneously — no
  server-side "current project" to fight over. The original
  `workspaceId`-in-localStorage idea made normal tabs *share* one workspace;
  this removes the limitation instead of scoping it;
- **no filesystem path ever crosses the wire.**

### 6.2 Delete `/api/browse` and `/api/browse/shortcuts`

`project.ts:252` resolves any absolute path and lists it, defaulting to `/`
(or every Windows drive). `project.ts:171` accepts any absolute path as the
project root. Hosted, that is a filesystem browser for the container and a way
to open another user's directory. `resolveInsideProject` guards traversal
*below* the project root but says nothing about what the root may be.

With project ids the routes have no purpose. **The vulnerability is removed,
not jailed.** ~150 lines deleted, replaced by the registry in §8.

### 6.3 Layout: `/data/<userId>/<projectId>`

Antony's new-from-template project and an imported NSSD are the same shape on
disk. Only the way in differs.

### 6.4 Import via `git clone`, export via a pushed branch — for real configs

The server **already runs git**: `forms.ts` `detectChangedForms()` shells out
to `git status --porcelain -- forms/` and already handles non-repos (`git:
false`). So git is a de-facto dependency of the image today, and `git clone
<url> /data/<user>/<project>` needs no new file handling.

Export is a pushed branch the user reviews and merges — non-destructive, and it
is the audit trail the MOH-reviewer persona already needs.

Zip in/out is the fallback for people with no repo. It needs a multipart parser
the stack does not have (`forms.ts:392`: "no multipart parser in this stack";
media goes base64-through-JSON) plus unzip and zip-slip hardening on entry
names. Zip export overwrites whatever is on the user's disk with no diff, so it
is documented as the second-class path.

### 6.5 Filter on import

Measured, excluding `node_modules` and `.git`:

| config | size |
|---|---|
| nssd | 8.1 MB |
| gandaki | 12 MB |
| moh-nepal | 10 MB |
| lumbini | **293 MB** — of which `map-export/` is 280 MB |

Budget ~10 MB per project. Exclude `map-export`, `exports`, `backups`,
`node_modules`, `.git` (for zip) or the volume fills with map tiles.

## 7. What already exists

| capability | evidence |
|---|---|
| Create from template | `templates.ts` (154 lines), 4 templates |
| Blank start produces a deployable project | `blank`, `empty`, `malaria` pass compile + convert + validate (verified 2026-08-20) |
| Live preview, renderer chosen | `docs/plans/live-form-preview.md` — planner-locked, enketo-core |
| Cold-start onboarding | `quick-hierarchy-creator.md`, `onboarding-order.md` |
| Offline toolchain | 14 of 38 `ACTION_CATALOG` entries are `requiresInstance: false` — every compile / convert / validate / compress, plus `csv-to-docs` |
| Local deploy prefix | `DEPLOY_STEPS` is 8; `UPLOAD_STEPS` is the last 5. Steps 1–3 run with no instance |
| Portable core | `shared/`: 3 of 50 non-test files touch `fs` (the FHIR starter-pack loaders) |
| Per-project caches | `parsedFormCache`, `contactChoicesCache` |
| Git in the server | `detectChangedForms()` |
| No hardcoded paths in product code | 0 in `server/src` + `client/src`; the 5 that exist are in `client/tests` demo specs |

## 8. Work items

### 8.1 Dockerfile + volume — FIRST

Prove pyxform and cht-conf run in the image before touching any code. If they
do not, everything below is wasted. `scripts/validate-generated-forms.mjs` is
the ready-made smoke test: it drives the real generator through real
cht-conf + pyxform and asserts both directions.

### 8.2 Auth + `onRequest` hook

Durable identity, no roles. Bearer token in a header (cross-origin cookies need
`SameSite=None` + credentialed CORS; a header rides the existing chokepoint).

**Gotcha:** `DeployPanel.tsx:561` opens run output with `new EventSource(...)`,
which cannot set headers. Either that endpoint takes its token in the query
string, or it moves to fetch-based streaming.

### 8.3 One commit: project ids, per-user state, threading, browse deleted

Lands as one commit with nothing else in it. A half-threaded server with an
unjailed browse is worse than either state alone.

Call sites, non-test, measured:

| file | `resolveInsideProject` | `getProjectPath` | `getDeployConfig` | `setProjectPath` |
|---|---|---|---|---|
| `routes/cht-conf.ts` | 0 | 2 | 4 | 0 |
| `routes/contactSummary.ts` | 4 | 0 | 0 | 0 |
| `routes/deploy.ts` | 0 | 1 | 0 | 0 |
| `routes/fhirMapping.ts` | 2 | 0 | 0 | 0 |
| `routes/forms.ts` | 6 | 2 | 0 | 0 |
| `routes/hierarchy.ts` | 4 | 0 | 0 | 0 |
| `routes/project.ts` | 0 | 1 | 0 | 3 |
| `routes/tasks.ts` | 2 | 0 | 0 | 0 |
| `routes/translations.ts` | 2 | 1 | 0 | 0 |
| `state.ts` | 1 | 2 | 1 | 1 |
| **total** | **26** | **13** | **5** | **4** |

`getProjectPath` and `setProjectPath` are deleted with `projectPath` (§6.1).
`resolveInsideProject` (26) changes signature to take the project root;
`getDeployConfig` (5) is keyed per user. **31 sites.**

### 8.4 Project registry

Replaces `browse`. Per user: list · create blank · create from template ·
import (git / zip) · delete. `POST /api/project/open` takes a project id.

### 8.5 Import / export

Git clone-in and branch-out first (cheap, safe). Zip in/out second (multipart
parser, unzip, zip-slip hardening, exclusion list from §6.5).

### 8.6 Client API base URL

One env var read in `jsonFetch`.

## 9. Gaps found while checking this plan

- **`cht-default` does not compile.** `contact-summary-extras.js` and
  `contact-summary.templated.js` `require('moment')`; no template ships a
  `package.json`, so the import cannot resolve. Verified 2026-08-20 with the
  real toolchain. Fix before hosting — it is the obvious "show me what CHT can
  do" template.
- **No per-template compile guard exists**, despite a standing directive that
  every template ship minimal-valid versions of every cht-conf-required file.
  Add one to CI: for each template, copy (including dotfiles) and run
  `compile-app-settings convert-app-forms validate-app-forms`. It would have
  caught the above.
- **`validate-app-forms` is partial without an instance.** It prints "Some
  validations have been skipped because they require a CHT instance." The
  XPath-resolution check runs — the class that caught this week's deploy
  blocker — but not all. The UI must say which ran.
- `check-git` is `requiresInstance: false` but meaningless in a hosted project
  with no repo; do not offer it.

## 10. Limits to state up front

- **Two people on the same config is still last-write-wins.** No locking at any
  rung. Per-user directories mean they cannot corrupt one folder — two copies
  diverge instead, and git is the only reconciler.
- **A volume pins the API to one instance.** No horizontal scaling; a redeploy
  is downtime. Fine at this scale; worth knowing it is a ceiling.
- **Deploy credentials.** Out of scope for rung 1 (no upload), so no CHT
  passwords ever reach the hosted server. If upload is added later, that is a
  security decision to take consciously.

## 11. Sequence

1. §8.1 Dockerfile — prove the toolchain runs in the image.
2. Fix `cht-default` (`moment`) and add the per-template compile guard to CI.
3. §8.2 Auth.
4. §8.3 The one commit.
5. §8.4 Registry.
6. §8.5 Git import/export, then zip.
7. §8.6 Client base URL; deploy client to Vercel, API to the container.

## 12. Acceptance

A Playwright spec against the hosted stack: sign in as two users; user A starts
blank and adds a form; user B imports the `mini-config` fixture as a zip; each
compiles and validates; A cannot list, open, or read B's project by any route;
A opens two of their own projects in two tabs and edits both without either
save affecting the other. Plus `scripts/validate-generated-forms.mjs` run
inside the container image.
