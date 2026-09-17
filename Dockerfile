# Hosted CHT authoring — the API container (docs/plans/hosted-authoring.md §8.1).
#
# One image, the whole toolchain the editor shells out to:
#   node 22        the Fastify server + the bundled cht-conf CLI
#   python3        cht-conf's `convert-*-forms` runs pyxform's `xls2xform`
#   git            `detectChangedForms()` and git import/export
#
# The client is built into the image too and served from the same origin
# (SERVE_CLIENT=1), so a single container is a complete deployment. Vercel can
# host the client separately instead — then set VITE_API_BASE at client build
# time and CORS_ORIGIN here.
#
# Projects live on the volume at DATA_ROOT (/data/<userId>/<projectId>). The
# image itself holds no project state.
#
#   docker build -t cht-ui-builder .
#   docker run -p 5174:5174 -v cht-ui-data:/data cht-ui-builder
#
# Prove the toolchain (what §8.1 asks for before any code is touched):
#   docker run --rm cht-ui-builder node scripts/validate-generated-forms.mjs
#   docker run --rm cht-ui-builder node scripts/validate-templates.mjs

FROM node:22-bookworm-slim

# python + pyxform for xls2xform, git for import/export. pyxform goes in a
# venv because Debian's system python refuses `pip install` (PEP 668).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/pyxform \
  && /opt/pyxform/bin/pip install --no-cache-dir pyxform==4.5.0
ENV PATH=/opt/pyxform/bin:$PATH

RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

WORKDIR /app
COPY . .
# `prepare` builds shared; then build server (tsc) and client (vite).
RUN pnpm install --frozen-lockfile && pnpm build

# cht-conf's compile-app-settings bundles the project's JS with webpack, which
# resolves bare imports by walking `node_modules` UP from the project folder.
# cht-core's own default config `require('moment')`, and a hosted project has
# no node_modules of its own. Installing moment at the filesystem root makes it
# resolvable from anywhere under /data without touching the user's project.
# Pinned to the range the cht-default template declares in its package.json.
RUN mkdir -p /opt/projectdeps && cd /opt/projectdeps   && npm install --no-package-lock --no-audit --no-fund --loglevel=error moment@^2.30.1   && mv /opt/projectdeps/node_modules /node_modules   && node -e "console.log('moment', require('/node_modules/moment/package.json').version)"

ENV CHT_UI_MODE=hosted \
    DATA_ROOT=/data \
    HOST=0.0.0.0 \
    PORT=5174 \
    SERVE_CLIENT=1
VOLUME ["/data"]
EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:5174/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
