---
name: verify-adrive
description: Drive tdrive's local web dashboard, CLI, and HTTP/content origins with disposable D1/R2/KV state. Use after user-facing changes to authentication, uploads, file management, search/tags, or site publishing; capture proof and preserve it after cleanup.
---

# Verify tdrive locally

The skill retains the repository name `verify-adrive`; current workspace and CLI commands use `tdrive`.

Read [features/README.md](features/README.md) first, then the matching feature recipe. The dashboard is the primary surface; `bun tdrive`, `/api/*`, and `/mcp` are additional user surfaces. This skill covers the first three; MCP needs a separate protocol journey. For real Cloudflare deployments use [verify-deployment](../verify-deployment/SKILL.md).

## Launch

From the repository root, require Linux (`/proc` and `ss`), Python 3, Node 26+, and Bun 1.4+. No Cloudflare credentials are needed. Run:

```bash
CONTROL="$PWD/.agents/skills/verify-adrive/control.py"
RUN="$("$CONTROL" new)"
printf '%s\n' "$RUN"  # retain this absolute path across shell tool calls
"$CONTROL" launch "$RUN"
```

`new` creates `$HOME/.local/state/adrive-verification/<UUID>/evidence/inputs/` with `verify-note.txt`, distinct `replacement.txt`, and `site/index.html`. No files are uploaded yet. `launch` copies the checkout's current tracked/unignored app, packages, scripts, and root files into `$RUN/runtime`; ignored local credentials, dependencies, build output, and storage are excluded. It installs with `bun install --frozen-lockfile`, applies **all** `bun db:migrate:local` migrations to empty storage, writes local-only `.dev.vars`, and starts the documented `bun --filter @tdrive/web dev` command in an owned process group. It creates one read-write CLI fixture key through the real authentication API and stores it at mode 0600 in the runtime's isolated XDG config. This setup is a fixture, not proof of browser or device authentication.

Readiness is `doctor` reporting PASS: authenticated `/api/files` reads work against the migrated database, unauthenticated reads return 401, content-host API requests return 421, and both listening ports belong to our process group. A Vite ready log alone is insufficient. Setup and server logs are in `$RUN/evidence/`. A failed launch invokes cleanup automatically; still run cleanup after any later failure.

The usable origins are **http://localhost:5173** (dashboard/API) and **http://localhost:5174** (content proxy). Sign in with the public disposable fixture passcode `adrive-verification-local-only`. Never use this fixture for another deployment. On localhost the browser accepts the Secure session cookie. Other plain HTTP hosts require the API key fallback and are a distinct journey.

**Isolation:** D1/R2/KV, secrets, and CLI config belong to the scratch runtime, but dev commands hardcode ports 5173/5174. Only one local instance can run on this host. Launch refuses occupied ports. Do not stop or drive another instance or reuse the user's browser tab. Do not run CLI upgrade, release, or remote Wrangler commands. Teardown is `"$CONTROL" cleanup "$RUN"`.

## Doctor

```bash
"$CONTROL" doctor "$RUN"
```

This read-only check verifies recorded PID start ticks, ownership of both ports, authenticated API access, expected content origin, disabled semantic bindings, and host/auth rejection statuses. It writes `evidence/doctor.json` including source SHA and runtime path. The source copy includes active edits, so SHA alone is not a complete source identity; retain the task diff in the report. Run doctor first whenever behavior looks wrong; inspect `setup.log` and `server.log` before retrying. It never migrates, resets data, logs in, or repairs credentials.

## Drive

Use the real browser controls, never internal Svelte state setters or JS-created fake uploads. In T3 Code call `preview_status`, then `preview_open` with `url: "http://localhost:5173"`, `profileId: "incognito"`, and `reuseExistingTab: false`. Keep the returned `tabId` for every call. Use `preview_snapshot` for fresh ARIA refs and `preview_act` with `locator: "aria-ref=<fresh ref>"`; stale refs must be refreshed. Use `preview_wait_for` for observed states. Upload a fixture using `preview_act` action `upload`, selector `input[type=file][multiple]`, paths containing the absolute `$RUN/evidence/inputs/verify-note.txt`. Never submit an API upload as evidence for the browser upload journey.

Start `preview_recording_start` before the action, and stop with `preview_recording_stop` after the resulting state; copy its returned local file into `$RUN/evidence/`. Save `preview_snapshot` with `save: true`, copy its PNG into evidence, and save its accessibility tree as a text file. Record sanitized action steps as well. If recording is unsupported, retain before/after screenshots and the action transcript and report the missing video. Stop recordings and close your tab with `t3_preview_close` before teardown. If preview automation is absent or reports unsupported, record the exact error and use Playwright in a fresh browser context as a fallback. Save video, screenshots, and sanitized actions in the same evidence directory; retain a trace only after removing credentials; never silently substitute HTTP for UI coverage.

CLI invocations use the package script's real `node --experimental-strip-types src/main.ts` entry point, in their own process with isolated configuration. Bypassing the Bun workspace wrapper keeps JSON and binary stdout free of runner prefixes:

```bash
"$CONTROL" cli "$RUN" -- --json list
"$CONTROL" cli "$RUN" -- --json put "$RUN/evidence/inputs/verify-note.txt"
"$CONTROL" cli "$RUN" -- --json status
```

Capture command, stdout, stderr, and exit code separately. File IDs printed by commands feed subsequent journeys; a command placeholder such as `FILE_ID` means the actual UUID you just observed, never a seed assumption. Device login must use its own XDG directory, rather than replacing the bootstrap key; see the authentication map.

Read-only HTTP cross-checks use the CLI fixture key without printing it:

```bash
"$CONTROL" http "$RUN" /api/files files
"$CONTROL" http "$RUN" /api/tags tags
```

The last argument is an evidence basename; each command writes `<basename>.json` and prints method/path/status/body SHA-256. A non-200 status fails. For file detail use `/api/files/FILE_ID`; for search use `/api/search?q=orchid`. These are actual public API routes, not test-only endpoints. Public content can be read with `curl -fsS http://localhost:5174/f/FILE_ID -o "$RUN/evidence/download.txt"`; compare to the input with `sha256sum` and `cmp`. Private signed links are credentials: sanitize them in evidence.

The executable Docker fallback proves `transfer-browser` without host browser libraries:

```bash
"$(dirname "$CONTROL")/browser-proof.sh" "$RUN"
```

It requires a running Docker daemon and downloads the pinned Playwright 1.56.1 Ubuntu image plus its matching npm package into an ephemeral container. It uses host networking to reach the same localhost app, mounts only this skill read-only plus evidence read/write, runs as your UID, and removes the container on exit. It signs in through the UI, cancels an empty-state upload, uploads through the toolbar, reloads/reopens detail, checks metadata, and compares an anonymous content download. Video, ARIA, PNGs, sanitized actions, JSON metadata, and downloaded bytes survive in evidence. No raw network trace is retained because it would include session cookies. The container supplies Chromium and Linux libraries; the app still runs directly on this host. A native/shared-browser setup remains unverified when this fallback is used. After a failed proof run cleanup and launch a new run before retrying; an existing upload violates the empty-state precondition.

## Evidence

All retained proof lives at `$RUN/evidence/`, outside disposable `runtime/`. Keep inputs, setup/server logs, doctor output, UI screenshots and ARIA snapshots, recording/trace when supported, HTTP response bodies/statuses, CLI transcripts with exit codes, and checksum comparisons. Write `report.md` with source SHA plus `source-files.json` hashes and task diff identity, run path, feature/sub-feature IDs, every entry point attempted, PASS/FAIL/SKIPPED and reason, observed results, cleanup result, and links to artifacts. Do not include passcodes, API keys, cookies, or private signed URLs in transcripts or screenshots. Pause recording before showing a newly minted key and move off that screen before taking evidence.

Exercise the real user path and capture both the action and resulting state. Verify a mutation by reopening/reloading and by a second user-facing read (CLI/API or downloaded bytes). A final screen or success toast alone is insufficient. API file metadata plus downloaded byte equality verifies the storage-facing behavior; it does **not** prove direct R2 object enumeration. If direct D1 inspection is needed, use `bun x wrangler d1 execute DB --local --command 'SELECT ...'` only from `$RUN/runtime/apps/web`, saving results in evidence. Never seed the behavior under test with SQL or a test-only endpoint. Mocks are allowed only at an existing production boundary. This skill has no dry-run mode: uploads, login, and site publishing really mutate local state. Observe file/network/git side effects when testing any future dry-run feature.

Local Wrangler supplies D1/R2/KV emulators. `SEMANTIC_SEARCH=off` means keyword behavior is covered; Workers AI, Vectorize, Cloudflare Browser Rendering, deployed routing/TLS, scheduled maintenance, and real cloud persistence remain unverified. Install fetches packages; all app test traffic must stay on the two localhost origins. The content proxy is the repo's normal local setup. No production resources/domains/secrets are provisioned, no production build is deployed, and no cloud cron is run. Do not turn a local PASS into a deployment PASS.

## Cleanup

Stop/save browser recordings, sign out of browser sessions, and close only tabs this run opened. Then, on success **or failure**, run:

```bash
"$CONTROL" cleanup "$RUN"
test ! -d "$RUN/runtime"
test -s "$RUN/evidence/doctor.json"
find "$RUN/evidence" -maxdepth 2 -type f
ss -H -ltnp '( sport = :5173 or sport = :5174 )'
```

Cleanup signals only the recorded process group after verifying PID start ticks, then removes its runtime, D1/R2/KV data, secrets, and isolated CLI config. It retains evidence and `instance.json` (sanitized ownership/source metadata), and writes `evidence/cleanup.json`. If ownership changed, it refuses to signal unknown processes: inspect metadata and report the exact residual state. Never kill by name, kill another listener, or remove the run directory. Port absence and surviving proof artifacts must be confirmed independently before reporting cleanup PASS.

## Helpers

[control.py](control.py) is executable. Its full interface is shown above: `new`, `launch RUN`, `doctor RUN`, `cli RUN -- ARGS...`, `http RUN /api/PATH BASENAME`, and `cleanup RUN`. `cli` forwards the command exit code and stdout/stderr; `http` only performs GET. `browser-proof.sh RUN` calls the executable `browser-proof.cjs` inside the container; it is not a host Node command. Runtime failures retain logs. No helper directly changes application tables. No server is needed after cleanup to view the retained evidence.
