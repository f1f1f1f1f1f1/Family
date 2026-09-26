# Beacon — Project Instructions

## Architecture

- React 19 + TypeScript + Vite SPA
- Home Assistant add-on with ingress support
- Capacitor for native iOS/Android builds

## Learnings - 2026-03-29

### Single Add-on at Repo Root (this fork)
This fork (add-on slug `family`) is built by Supervisor from the repo root:
root `config.yaml` has no `image:` line, so the root `Dockerfile` builds
from `src/`, `server.js`, `run.sh` etc. at the root. Bump `version` in
`config.yaml` on every change or Supervisor may reuse a cached build.

Upstream's `beacon/` subdirectory was removed: Supervisor treats every
`config.yaml` in a repository as a separate add-on, so it showed up in the
add-on store as a stale second "Beacon" add-on. Don't reintroduce a nested
`config.yaml`.

### HA Add-on Auth: Long-Lived Token in Config
SUPERVISOR_TOKEN only works container-side (http://supervisor/core). postMessage auth doesn't work in HA companion app WKWebView. The `ha_token` config option (schema: password) with a user-provided long-lived access token is the only reliable browser-side auth approach.

### HA Todo Items: Service Call with ?return_response
Don't read `entity.attributes.items` — it doesn't exist. Use:
```
POST /api/services/todo/get_items?return_response
Body: {"entity_id": "todo.xxx"}
Response: { service_response: { "todo.xxx": { items: [...] } } }
```
Filter out `unavailable` entities during discovery. Calling get_items on unavailable entities returns HTTP 500.

### HA Add-on Store Cache Busting
HA aggressively caches add-on repos. To force update visibility: create a git tag + GitHub release. If that fails, user must remove and re-add the repo URL. The `update_entity` service does NOT trigger a repo refresh.

### Semantic Release
`.releaserc.json` and `.github/workflows/release.yml` handle automated versioning. Uses conventional commits (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major). Bumps both config.yaml files, syncs changelogs, creates GitHub releases.

## Learnings - 2026-09-26

### Google Tasks Chores Sync Runs in the Add-on Server
The sync lives in `chores-sync.cjs` (required by `server.js`), not in the
browser: one pass at a time, every 60s, ~5s after a write to the chores or
completions collection, and on POST `/beacon-action/chores-sync` (Sync Now;
GET returns status). `src/hooks/useChoresSync.ts` only polls that status and
refreshes screens when `lastChangeAt` moves. Server tests are root-level
`*.test.ts` files (vitest includes them). Any new server-side file needs its
own `COPY` line in the `Dockerfile` — only `server.js` and the files listed
there reach the container. Server-side files use `.cjs` because the root
`package.json` is `"type": "module"`.

### On-Demand Screens (code splitting)
Screens not needed to show the dashboard (Settings, Music, Photos, Weather,
Timer, Leaderboard, Onboarding, Kid Display, the Advanced Dashboard with
GridStack, and its dnd-kit classic-layout editor) are loaded with
`lazyNamed()` (src/utils/lazy-screen.ts) inside `<LazyBoundary>`. A plain
`import { X } from './X'` anywhere on the startup path pulls X (and its
libraries) back into the main bundle, so check `npm run build` output.
`manualChunks` in vite.config.ts only splits React out; don't widen it to
all of node_modules, or GridStack/dnd-kit end up in the startup download.
After an add-on update a running display asks for old file names and
server.js answers with index.html; `lazyNamed` reloads the page once.
