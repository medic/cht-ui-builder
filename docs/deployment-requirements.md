# Deploying CHT UI Builder

What this application needs from its runtime, so you can deploy it however you
prefer. It makes no assumptions about orchestrator, instance type or storage
backend — those are your call. What follows is the set of requirements and
constraints any deployment has to satisfy.

---

## 1. Shape of the thing

A **single container**. One Node process (Fastify) listening on **port 5174**,
serving both the HTTP API and the web UI from the same origin. There is no
separate frontend to deploy, no database, and no other services.

The image also carries a build toolchain — Python + pyxform, git, and a
JavaScript bundler — because the app shells out to it to compile and validate
the projects users author. That is why the image is ~1.4 GB and why build
requests are expensive.

**All state is on the filesystem**, under `DATA_ROOT`. Nothing is stored
anywhere else.

---

## 2. Hard constraints

These hold regardless of how you choose to run it.

### Exactly one instance

The filesystem is the datastore. There is no clustering, leader election or
cross-instance coordination.

- Two instances sharing one volume will interleave writes to the same JSON
  files and corrupt accounts.
- Two instances on separate volumes will silently split users between them — a
  user's projects appear or disappear depending on which instance they reach.
- **Replace, don't overlap.** Any deployment strategy that starts a new instance
  before stopping the old one will either contend for the volume or fail to
  attach it, depending on your storage. Stop the old one first; a short outage
  on redeploy is expected and acceptable.
- No autoscaling.

Horizontal scaling would require application changes and cannot be configured
around.

### Persistent storage

`DATA_ROOT` must be durable storage that survives restarts and instance
replacement. If it is lost, every account and every project is gone — there is
no second copy, and the only user-facing export is a manual per-project zip
download. **Back it up on a schedule.**

### A writable root filesystem

The bundled toolchain writes outside `DATA_ROOT` during builds, so a read-only
root filesystem will break compilation.

---

## 3. Runtime interface

| | |
|---|---|
| Port | `5174` (HTTP) |
| Health check | `GET /api/health` → `{"ok":true,"mode":"hosted",...}` |
| Persistent volume | mounted at `DATA_ROOT` |
| Protocol | plain HTTP; terminate TLS in front of it |
| Secrets to provision | none — nothing is read from the environment and nothing is stored. **But see §8: users can submit CHT credentials per-request, and the server makes authenticated outbound calls to a URL they choose.** |

The port, health check and volume mount above are declared in the `Dockerfile`
(`EXPOSE`, `HEALTHCHECK`, `VOLUME`) — but note that `VOLUME` only declares a
mount point. It does not make the storage durable; §2 does.

### Environment variables

The first five are set by the image and need no action. The last three have
defaults in `server/src/config.ts` and are **not** in the Dockerfile, so
reading the Dockerfile alone will not reveal them.

| Variable | Value | Set by image | Notes |
|---|---|---|---|
| `CHT_UI_MODE` | `hosted` | yes | **Required.** Any other value registers a server-side filesystem browser and an open-by-absolute-path endpoint, exposing the container's filesystem. §6 verifies it. |
| `DATA_ROOT` | `/data` | yes | Must point at the persistent volume. |
| `PORT` | `5174` | yes | |
| `HOST` | `0.0.0.0` | yes | Already the default in hosted mode. |
| `SERVE_CLIENT` | `1` | yes | Serves the web UI from this process. Keep it — it is why there is no CORS configuration. |
| `CORS_ORIGIN` | *(unset)* | no | Only if the UI is served from a different origin, which it is not by default. Exact-match, comma-separated; no wildcards. |
| `IMPORT_MAX_BYTES` | default 100 MB | no | Per-project limit on git/zip import. |
| `LOG_LEVEL` | `info` | no | pino levels. |

---

## 4. Resource characteristics

**Storage.** Everything lives under `DATA_ROOT`:

```
<DATA_ROOT>/auth/users.json                  accounts (scrypt password hashes)
<DATA_ROOT>/auth/sessions.json               session token hashes, 30-day expiry
<DATA_ROOT>/users/<userId>/registry.json     that user's project list
<DATA_ROOT>/users/<userId>/projects/<slug>/  one project tree per project
```

Measured on a real instance: **11 MB total for 6 accounts**, 2–4 MB per user
with several projects each. It is small at rest. The figure that actually sets
the ceiling is `IMPORT_MAX_BYTES` (100 MB per imported project), so budget for
imports rather than for authored projects: **a 2 GB volume is generous** for a
group of this size. Growth is gradual and user-driven; pick a size you can
expand.

**Host disk is a separate and much larger number.** The image is **1.41 GB** and
a from-source build leaves roughly **4.5 GB of build cache**, so a machine that
builds the image wants **~20 GB free** — sizing the host like the data volume
will fail during `docker build`, not at runtime. Building elsewhere and pulling
a published image avoids this entirely.

**Memory.** Measured idle: **~120 MB**. A build spawns a real bundler process —
allow **at least 1 GB** for a single concurrent build. **There is no queue, no concurrency cap and no run timeout**, so
concurrent builds add to that roughly linearly and the container's memory limit
is the only thing protecting the host. Expect OOM kills under concurrent load
rather than graceful queueing. Size for your expected peak concurrency, and
keep the user group small.

**CPU.** Idle cost is negligible. Builds saturate a core for their duration
(minutes). Set liveness thresholds generously enough that a busy instance is
not killed mid-build.

---

## 5. Networking requirements

**Streaming output must not be buffered.** Build output reaches the browser as
**server-sent events** on `GET /api/cht-conf/runs/:runId/stream`, and a build
runs for minutes. Any proxy that buffers responses turns this into an
apparently frozen log that dumps everything at the end. Disable response
buffering for this path (or globally) on whatever proxy or ingress you use.

**Idle timeouts must exceed build duration.** Every hop — load balancer, proxy,
ingress — needs a timeout longer than the longest build. A 60-second default
will cut the stream mid-run. Minutes, not seconds.

**One origin.** The UI and API are served by the same process, so there is no
cross-origin configuration and no mixed-content concern beyond terminating TLS
somewhere in front.

---

## 6. Verification after deploying

Platform-independent; run these against the deployed URL.

```sh
# 1. Health, and confirm the mode
curl -s https://<host>/api/health
# → {"ok":true,"mode":"hosted","time":"..."}

# 2. Confirm the filesystem browser is ABSENT, not merely guarded.
#    Unauthenticated requests return 401 because the auth hook runs before
#    routing, so this check is only meaningful WITH a token.
TOKEN=$(curl -s -X POST https://<host>/api/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"deploy-check@example.org","password":"<pw>"}' | jq -r .token)

curl -s -o /dev/null -w 'browse       %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" https://<host>/api/browse

curl -s -o /dev/null -w 'open-by-path %{http_code}\n' \
  -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"/"}' https://<host>/api/project/open
```

**Both must return `404`.** A `200` means the container is not running in
hosted mode — stop and correct `CHT_UI_MODE` before anyone is given the URL.
(Verified behaviour: hosted returns 404; any other mode returns 200, so this
check genuinely discriminates.)

Then, in a browser: sign up, create a project from a template, open the Deploy
panel and start a compile. The log must stream line by line. If it only appears
when the run completes, response buffering is still on somewhere — see §5.

Finally remove the check account: delete its entry from
`<DATA_ROOT>/auth/users.json` and its `<DATA_ROOT>/users/<id>/` directory, then
restart the instance.

---

## 7. Building the image

See the `Dockerfile` at the repository root — its header comment carries the
build, run and smoke-test commands, and is the authority on them. It takes no
build arguments.

Two things the Dockerfile does not say:

- **Tag with the git SHA, not `latest`**, so "which build is live?" always has
  an answer.
- **Run both smoke tests before deploying** (the header comment lists them).
  They exercise the real python toolchain inside the image and must exit 0. If
  pyxform is broken in the image, this is where you find out; otherwise the
  first symptom is a user reporting a failed compile.

---

## 8. Security posture

Current, deliberate properties. State them to whoever signs off on the
deployment.

- **Signup is open.** Email and password, with **no email verification, no
  password reset and no invite mechanism**. Anyone who can reach the URL can
  create an account. Put authentication in front of it unless the endpoint is
  on a private network.
- **No third-party credentials are stored.** A compromise of `DATA_ROOT`
  exposes scrypt password hashes and users' project files, but grants no
  external access. `DeployConfig` (`server/src/state.ts`) has no password
  field; CHT passwords are per-request only.
- **But credentials do transit the server, and outbound calls are not
  restricted.** `server/src/routes/deploy.ts` and `routes/cht-conf.ts` carry
  **no `MODE` guard** and are registered in hosted mode.
  `/api/cht-conf/test-connection`, `/api/cht-conf/run` and `/api/deploy/run`
  accept a password in the request body and spawn cht-conf with
  `COUCH_PASSWORD` set. A deploy target of `{target:'url'}` takes an arbitrary
  URL, so any signed-up user can make the server issue authenticated requests
  to a host of their choosing (SSRF). **Gate these on `MODE === 'desktop'`
  before exposing the instance publicly**, matching how `/api/project/open` is
  already handled.
- **Per-user isolation is enforced server-side** and covered by an automated
  test suite: a user cannot list, open, read, export or delete another user's
  project through any route.
- **`CHT_UI_MODE` must be `hosted`** — see §3 and the §6 check.
- The container runs as root. Acceptable for a time-boxed deployment; worth
  revisiting if it becomes long-lived.

---

## 9. Known limits

- One instance per volume; a redeploy means brief downtime.
- Two people editing the same project is last-write-wins. Per-user directories
  prevent corruption between users, not divergence within a shared project.
- Completed build logs are retained in memory for replay and are never evicted,
  so a long-lived instance leaks slowly. A periodic restart is an adequate
  mitigation.
- No build queue or timeout, as noted in §4.
