# Authentication and credentials

Users sign into the drive with a passcode, passkey, or API key, manage scoped keys in Settings, and connect the CLI by approving a device request.

## Sub-features

- `auth-session`: passcode sign-in, persistence after reload, sign-out, unauthorized reads.
- `auth-passkey`: enrollment, inventory, password-free sign-in, removal, and passcode recovery.
- `auth-api-fallback`: API key sign-in for local HTTP use.
- `auth-key-scope`: create read-only/read-write keys and revoke them.
- `auth-device`: approve a headless CLI login and persist its credentials.

## How to get to it (user POV)

- Open `/`, fill `Passcode`, choose `Sign in`.
- Choose `Sign in with a passkey` after enrolling through Settings > Passkeys.
- Expand `Sign in with an API key`, fill `API key`, choose `Connect`.
- Choose `Settings` in account navigation, then `API keys`; choose `Sign out` in account navigation.
- Run `bun tdrive login http://localhost:5173 --headless`, open the printed approval URL, and approve it.

## Driving it with browser/CLI/HTTP

Preconditions:

- Doctor passes; use a fresh browser context and the local fixture passcode from Launch.
- For API fallback/scope checks create disposable named keys through Settings first. Do not use the bootstrap key as evidence for key creation.

- **Session.** Record the signed-out page, fill `Passcode` and choose `Sign in` with fresh preview refs. Expect the drive controls (`Files`, `Trash`, `Upload`). Navigate again to `/`; expect the signed-in listing. Choose `Sign out`, navigate to `/`, and expect `Sign in to your drive` (detail/settings routes have their own signed-out messages). Cookie-less `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/api/files` must return 401. Save the actions and resulting snapshots.
- **Bad passcode.** In a fresh context submit one wrong passcode; expect a visible error and no signed-in controls. Stop after one attempt; this is not a lockout load test.
- **Keys.** In Settings, fill placeholder `Key name, e.g. backup agent` with `verify-reader`, select `Key scope` value `read-only`, choose `Create key`. Retain its token only in a mode-0600 scratch file in runtime; pause recording while it is visible. A Bearer GET `/api/files` must succeed while PUT `/api/files` and GET `/api/auth/keys` return 403. Create a read-write key and prove a small upload succeeds. Revoke each created key using its row's `Revoke`, then `Revoke key` in the confirmation dialog. A subsequent Bearer GET must return 401. Save sanitized statuses, never tokens.
- **API fallback.** Sign out, expand `Sign in with an API key`, enter the disposable write key before revoking it, and choose `Connect`. Expect the listing and reopen a file. This branch does not prove passcode cookies.
- **Device login.** From `$RUN/runtime`, run `XDG_CONFIG_HOME="$RUN/runtime/device-config" bun tdrive login http://localhost:5173 --headless` in its own PTY. Open the exact printed approval URL in a signed-in context, choose `Approve device` shown in a fresh snapshot, and wait for CLI exit 0. Then run `XDG_CONFIG_HOME="$RUN/runtime/device-config" bun tdrive --json whoami`; expect an authenticated identity. Confirm `device-config/tdrive/config.json` exists at mode 0600 without printing it. Capture a redacted PTY transcript; approval URLs carry device credentials.

## Passkeys with a virtual authenticator

Run the real CDP proof against a fresh isolated runtime after Doctor passes:

```bash
apps/web/scripts/passkey-browser-proof.sh "$RUN"
```

The script uses the pinned Docker Playwright image and a real CTAP2 authenticator
with resident credentials and user verification. It does not stub
`navigator.credentials`. It signs in with the disposable passcode, adds a named
passkey in Settings, reloads the inventory, signs out, and signs in with only the
passkey. It checks authenticated files, current-session metadata, and the real
Secure, HttpOnly, SameSite Strict, host-only cookies. A second browser context
cannot finish an attempt without its binding cookie. Navigating away aborts a
pending prompt. Removing the current passkey ends its session, rejects another
login using that credential, and leaves passcode recovery working with an empty
inventory.

The script saves `passkey-result.json`, sanitized `passkey-actions.json`, PNG and
ARIA snapshots, and video under `$RUN/evidence/`. Raw CDP credentials and cookies
are never retained. On failure, clean the runtime and launch a fresh run before
retrying. Run the normal cleanup commands after success too. This proves local
browser behavior, not deployment behavior or physical authenticator support.

After `cd apps/web && bun x vite build`, run the generated Worker proof from the
repository root:

```bash
node apps/web/scripts/passkey-worker-proof.mjs "$RUN/evidence"
```

This proof bundles the generated Worker with Wrangler's esbuild dependency,
executes it in workerd with disposable D1 and KV, and upgrades a database with an
existing password session. It registers signed ES256 and RS256 credentials,
signs in through the HTTP boundary, and rejects replays and invalid signatures.
It exports the populated authentication tables through D1's local exporter and
imports them into empty D1, then checks preserved rows and session revocation
after passkey removal. It does not use or change the browser runtime. Its
`passkey-worker-result.json` survives runtime cleanup.

## Gotchas

- Secure cookies work on localhost; a non-localhost HTTP host requires API fallback. Do not treat these as equivalent proof.
- The launch helper's session and key are fixtures only. It revokes its bootstrap browser session after making the key.
- API tokens are shown once. Screenshots, video, traces, and HTTP bodies on the key screen can disclose credentials; pause capture and sanitize before retaining evidence.
- Auth rate limits use local KV. Repeated wrong-passcode tests can lock out the instance. Report a failure and use a new run instead of deleting guard state.
