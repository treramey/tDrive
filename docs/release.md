# Releases, deployment, and rollback

## First-time setup (once)

App Worker commands run from `apps/web`. Landing-site commands run from
`apps/site` (no `--env`). `bun release` and the backup installer run from
the repository root.

1. From `apps/web`: `wrangler d1 create adrive-production` — paste the id
   into `wrangler.jsonc` `env.production.d1_databases[0].database_id`.
2. From `apps/web`: `wrangler r2 bucket create adrive-production`
3. From `apps/web`: `wrangler kv namespace create AUTH_GUARD --env production`
   — paste the id into `env.production.kv_namespaces[0].id`.
4. From `apps/web`: create the semantic-search index (the production env
   sets `SEMANTIC_SEARCH=required`, so the deploy fails without it):

   ```
   wrangler vectorize create adrive-production --dimensions=384 --metric=cosine
   wrangler vectorize create-metadata-index adrive-production --property-name=deleted --type=boolean
   wrangler vectorize create-metadata-index adrive-production --property-name=kind --type=string
   wrangler vectorize create-metadata-index adrive-production --property-name=visibility --type=string
   ```

   The Workers AI binding needs no provisioning — it activates with the
   `ai` binding already declared in `wrangler.jsonc`. Both services sit
   inside the Workers Paid plan's included allocation at personal scale
   (50M queried + 10M stored vector dimensions per month ≈ 26k chunks at
   384 dims; embeddings run within the 10k neurons/day allocation).

5. In the Cloudflare dashboard, open **Images → Transformations**, select
   the zone that owns `CONTENT_ORIGIN` (`trevors.link` for
   `files.trevors.link`), and enable transformations. Dashboard thumbnails
   require this zone-level setting.
6. From `apps/web`: `wrangler secret put PASSCODE --env production`
   (12+ characters).
7. The `trevors.link` zone must be active in Cloudflare. Remove existing
   CNAME records for `drive.trevors.link`, `files.trevors.link`, and
   `tdrive.trevors.link` before deployment; the custom-domain routes in
   the `wrangler.jsonc` files create the required DNS records
   automatically. `tdrive.trevors.link` serves the static landing page
   (`apps/site`, an assets-only Worker with no build step).
8. From the repo root: `bun release`
9. From the repo root: set up backups on your backup host
   (`scripts/backup/install-backup-host.sh`) and complete the restore drill
   in `docs/backup-restore.md`.

Semantic search notes for the first deploy:

- Files uploaded before the index existed (or while bindings were absent)
  sit in `index_state = 'disabled'` and are backfilled by the maintenance
  cron at 5 files per 5 minutes. A large pre-existing corpus takes hours;
  the settings page's "indexed chunks" count shows progress.
- Vectorize contents are derived state (like the FTS tables): after a D1
  restore, vectors for purged files are orphaned but harmless, and
  missing vectors regenerate on reindex. They are deliberately not part
  of the backup set.

## Configure release automation

1. Enable GitHub Actions for the repository.
2. Add the repository secret `RELEASE_TOKEN`. Use a repository-scoped PAT or GitHub
   App token with Contents and Pull requests write permissions. Allow that identity
   to push normal fast-forward commits to `main`, the `changeset-release/main`
   branch, and `v*` and `cli-v*` tags. The default `GITHUB_TOKEN` cannot trigger
   downstream tag workflows.
3. Create the GitHub environment `production`. Add `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` as environment secrets. Give the Cloudflare token access
   to the existing Workers and their production resources, including D1 migrations.
4. Add environment approval rules if your deployment policy requires them.

The Changesets workflow serializes main pushes under `changesets-main`. Before
release preparation, it checks `RELEASE_TOKEN`, sets the bot author, and writes
`.netrc` inside a temporary home directory. The pinned Changesets action uses the
same token and home. The workflow removes that directory even on failure.
Checkout never persists credentials. Cloudflare credentials exist only in the
production deploy step.

## Release the app

1. Merge app work into `main`. App authors do not add a Changeset.
2. Let **Changesets** generate a patch release. It updates the root, web, and site
   versions and both app changelogs, then pushes a normal main commit and an
   immutable `vMAJOR.MINOR.PATCH` tag. There is no app release PR.
3. Let **App release** verify that tag and run `bun release`.
4. Run `verify-deployment` against `drive.trevors.link` and `files.trevors.link`.
   Call the release complete only after its report passes.

Web and site source, shared source, and app deployment inputs trigger this lane.
Notes contain the subjects and short SHAs of the relevant first-parent commits.
The generated commit starts a second Changesets run that recognizes release
bookkeeping and creates no additional app version. Its tag starts the deployment
workflow. App preparation changes only web and site
workspace versions in `bun.lock`. It preserves every dependency resolution,
CLI version, and pending CLI note. Automation creates no app GitHub Release.

## Release the CLI

1. Run `bun changeset` for CLI, shared, installer, or CLI build changes.
2. Select `@tdrive/cli` or `@tdrive/shared` and write a patch, minor, or major note.
   Include the note in the feature PR. Add or update a note with or after the latest consumer
   change. An old pending note does not approve later work, even after a docs push.
3. Merge the feature PR into `main`.
4. Review the generated `chore: release versions` PR. Check both CLI and shared
   versions, both changelogs, consumed notes, and regenerated `bun.lock`.
   Regeneration can change dependency resolutions and needs review.
5. Merge the release PR. Automation recovers the approved transition and pushes
   `cli-vMAJOR.MINOR.PATCH`. **CLI release** verifies the transition before building
   and uploading the bundle, installer, and `checksums.txt`.

Changesets 2.29.8 fixes CLI and shared together and ignores web and site. CLI
preparation fetches `origin/main` after the pinned action resets its branch to the
original event SHA. Its release PR retains the latest app metadata. Internal
`workspace:^` links stay unchanged. The app and CLI lanes can have different
versions. All packages remain private, and automation publishes no npm packages.

Shared source affects both lanes. Root tooling, root dependencies, and lock
resolution changes conservatively affect both. A mixed push deploys the app while
CLI notes remain pending for review. Missing or invalid CLI notes fail the CLI
path after eligible app tagging, so that failure does not prevent app deployment.
Validated version, changelog, consumed-note, and lock regeneration output does not
request another release.

Installers and upgrades use [treramey/tDrive releases](https://github.com/treramey/tDrive/releases).
The migration changeset starts the reviewed CLI stream at `0.2.0`, above the
existing `cli-v0.1.7` assets. Those earlier builds used tag-injected versions while
the package manifests remained at `0.1.0`.
The landing page's bootstrap command requires the first CLI release assets to
exist there. `tdrive upgrade` uses the installer from its selected `cli-v*` release
and verifies its SHA-256 checksum before execution. That installer downloads and
verifies the bundle from the same release.

### Recover a failed release

Rerun **Changesets** or dispatch it manually on `main`. Preparation fetches the
remote tip, finishes any missing app tag, and recovers an approved CLI tag before
the action chooses its version or publish path. Later pending notes do not block
recovery of an earlier CLI transition. That transition must itself have consumed
CLI notes, left no pending notes, and introduced matching CLI and shared changelog
headings. The initial `0.1.0` version has no release evidence and is never tagged.
A manual dispatch with no previous app transition and no push range creates no
initial app release.

A rejected app main push fetches the new tip and recomputes the release, up to
three attempts. It never force-pushes main. An existing local or remote tag
succeeds only when its peeled target is the exact transition commit. A conflicting
tag or uncertain remote response fails. Do not move release tags. A tag that
already exists does not trigger another deployment.

If deployment fails, rerun **App release** for the same tag. Applied migrations
remain applied, and the script repeats validation and both deployments. If the
site fails after the app succeeds, inspect the archived `.release-history` and
use the site rollback commands below. The app and site deployments are separate
operations.

All automated app deployments share `tdrive-production` concurrency and never
cancel a running deployment. Verification checks the canonical tag, lane versions,
new changelogs, transition commit, exact remote and local targets, and main
ancestry. A newer release in the same lane supersedes an older attempt. A newer
release in the other lane does not. GitHub does not guarantee queue order. Reserve
local `bun release` for coordinated recovery because local commands do not acquire
the GitHub production lock.

### Deploy manually for coordinated recovery

```
bun release
```

`scripts/release.sh` refuses a dirty tree or placeholder ids in the target
environment. It runs format, type, lint, and test gates, audits dependencies,
builds the app, and dry-runs both deployments. It then applies D1 migrations,
deploys the app and landing site, and appends the deployed commit to
`.release-history`. If the landing site fails after the app Worker is live,
the script records the app commit and prints rollback commands for `apps/site`.

A release is **complete** only after the production verification skill
passes against the live deployment (the script prints the reminder).
Run it before the first deployment is considered done, and after any
storage, authentication, upload, routing, or migration change.

## Migration compatibility rule

Migrations apply before the new Worker deploys, and rollback re-runs the
previous Worker against the migrated schema. Therefore every migration
must be backwards-compatible for at least one release: additive tables
and columns (with defaults) only; never drop, rename, or repurpose a
column until the release _after_ the last code that used it is gone.

## Rollback

### Worker

```
cd apps/web
bun x wrangler deployments list --env production   # find the previous version
bun x wrangler rollback --env production           # interactive picker
```

Rollback redeploys the previous Worker bundle. It does not touch D1, R2,
KV, or secrets — which is why the migration rule above matters.

### Landing site

The landing page is a separate assets-only Worker (`apps/site`). Roll it
back the same way:

```
cd apps/site
bun x wrangler deployments list
bun x wrangler rollback
```

### D1

There is no in-place downgrade. Recovery options, in order of blast
radius:

1. **Cloudflare Time Travel** (point-in-time restore, 30-day window):
   `wrangler d1 time-travel info DB --env production` then
   `wrangler d1 time-travel restore DB --env production --timestamp <unix>`.
   This rewinds the whole database — anything written after the
   timestamp is lost.
2. **Nightly export**: restore per `docs/backup-restore.md` (full
   database or targeted rows).

### Secrets

`wrangler secret put PASSCODE --env production` any time. The scheduled
maintenance job detects the change and revokes all browser sessions and
pending device codes automatically (API keys stay).

## Deployment records

`.release-history` in the repo root accumulates
`<timestamp> <env> <commit>` lines locally. The deployed commit is also
visible via `wrangler deployments list --env production`.

The file remains ignored by Git. **App release** archives it whenever it exists,
including when the site deployment fails. Each artifact name includes the GitHub
run ID and attempt number. Download that attempt's artifact when you investigate
a partial deployment.
