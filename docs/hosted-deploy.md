# Running the hosted CHT UI Builder

The same codebase runs two ways (`server/src/config.ts`):

| | desktop (default) | hosted (`CHT_UI_MODE=hosted`) |
|---|---|---|
| who | one implicit local user | CHT users: sign in with CHT credentials against `CHT_INSTANCES` (as cht-user-management does), bearer tokens |
| projects | any folder on this machine, opened by path or the folder browser | created, imported or cloned into `DATA_ROOT/users/<user>/projects/` |
| state | `~/.cht-ui-builder/` | `DATA_ROOT` (default `/data`) — a volume |
| filesystem browsing | yes | not registered |
| paths over the wire | yes (it is your disk) | never |

## One container, everything included

```sh
docker build -t cht-ui-builder .
docker run -d --name cht-ui -p 5174:5174 -v cht-ui-data:/data \
  -e CHT_INSTANCES=https://my-cht.dev.medicmobile.org cht-ui-builder
# open http://localhost:5174 — sign in with a CHT user, start blank or from a template
# (no CHT to hand? `node scripts/fake-cht.mjs` and CHT_INSTANCES=http://host.docker.internal:5995)
```

The image holds node 22, python + pyxform, git, cht-conf and the built client,
so compile / convert / validate run for real inside it. Prove that on any new
build:

```sh
docker run --rm cht-ui-builder node scripts/validate-generated-forms.mjs
docker run --rm cht-ui-builder node scripts/validate-templates.mjs
```

### Environment

| variable | default | meaning |
|---|---|---|
| `CHT_UI_MODE` | `desktop` (image sets `hosted`) | see table above |
| `DATA_ROOT` | `/data` hosted · `~/.cht-ui-builder` desktop | where users, registries and projects live |
| `PORT`, `HOST` | `5174`, `0.0.0.0` hosted / `127.0.0.1` desktop | listen address |
| `SERVE_CLIENT` | `1` in the image | serve `client/dist` from this server |
| `CORS_ORIGIN` | empty | comma-separated extra origins (a separately hosted client) |
| `IMPORT_MAX_BYTES` | 100 MB | per-project budget on git / zip import |
| `LOG_LEVEL` | `info` | pino level |

`/data` must be a persistent volume: it holds every account and every project.
Back it up like a database. One API instance per volume; a redeploy is a short
downtime.

### Fly.io / Render / Railway

Any container host with a persistent volume works. The container listens on
`PORT` (5174), health-checks on `GET /api/health`, and needs the volume at
`/data`. Give it at least 1 GB of memory: `compile-app-settings` runs webpack.

## Client on Vercel, API in a container

Optional split. Build the client with the API's public URL and let the API
accept that origin:

```sh
# client (Vercel build command)
VITE_API_BASE=https://api.example.org pnpm --filter @cht-ui/client build
# api container
CORS_ORIGIN=https://builder.example.org
```

Tokens ride the `Authorization` header (no cookies), so cross-origin needs
nothing beyond that.

## What a hosted user can do

sign in with CHT credentials → start blank / template / import (git URL or zip) → edit forms,
hierarchy, tasks, contact-summary → **Deploy** panel: `compile-app-settings`,
`convert-app-forms`, `validate-app-forms` and the other offline cht-conf
actions run inside the container → overview: **Download zip**, or **Push
branch** back to the repo it was cloned from.

There is no upload to a CHT instance in hosted mode by design (rung 1,
`docs/plans/hosted-authoring.md` §4): no CHT credentials ever reach this
server. The user deploys the downloaded project with their own `cht-conf`.

## Accounts and data

- Sign-in: `server/src/chtAuth.ts`. The person picks one of `CHT_INSTANCES`
  and enters their CHT username and password; the server checks them with
  `POST /_session`, reads their roles (`medic/org.couchdb.user:<name>`) and the
  instance's permissions (`/api/v1/settings`), and lets them in if they are an
  admin or hold every permission in `CHT_REQUIRED_PERMISSIONS` (default
  `can_configure`) — the checks cht-user-management makes. The CHT session is
  closed straight after; no CHT password or cookie is stored.
- Accounts: `DATA_ROOT/auth/users.json` holds (instance, username) per CHT user,
  created on first sign-in, with an id derived from that pair so the same
  person always lands on the same projects. `sessions.json` holds sha256 of
  tokens, 30-day expiry. Delete a session row to sign someone out; losing CHT
  access stops new sign-ins but not a live session.
- Each user: `DATA_ROOT/users/<id>/registry.json` and `projects/<slug>/`.
- A user can only ever resolve project ids in their own registry; a path outside
  their projects dir is refused even if the registry says otherwise.
- Import budget and exclusions (`node_modules`, `.git`, `map-export`,
  `exports`, `backups`) keep one config from filling the volume — lumbini is 293
  MB of which 280 MB is map tiles.

## Private repositories

Import with a token in the URL: `https://<user>:<token>@github.com/org/repo.git`.
The clone keeps that remote so **Push branch** works; the registry and every
error message store and show the URL with credentials stripped.

## Acceptance

`node scripts/hosted-acceptance.mjs` spawns the built server in hosted and
desktop mode and runs 48 assertions: two users, isolation by every route,
zip import/export, zip-slip refusal, delete-with-files, desktop fallbacks. It
runs in CI on every push.
