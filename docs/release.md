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
   to push `changeset-release/main` and `v*` tags under your repository rules.
   The default `GITHUB_TOKEN` cannot trigger the downstream tag workflow.
3. Create the GitHub environment `production`. Add `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` as environment secrets. Give the Cloudflare token access
   to the existing Workers and their production resources, including D1 migrations.
4. Add environment approval rules if your deployment policy requires them.

The Changesets workflow checks `RELEASE_TOKEN` after the frozen install and before
any release mutation. The pinned action receives it as `GITHUB_TOKEN` for API calls
and writes `.netrc` in a temporary home directory for branch and tag pushes.
The workflow removes that directory after the action. Checkout never persists
credentials. Cloudflare credentials exist only in the production deploy step,
which checks both secrets before invoking `bun release`.

## Release the app

1. Run `bun changeset` from the repository root.
2. Select the affected workspace and a patch, minor, or major bump. Write release
   notes and include the generated `.changeset/*.md` file in the feature PR.
3. Merge the feature PR into `main`.
4. Review the generated `chore: release versions` PR. Check the notes, all four
   workspace versions, the root version, and `bun.lock`.
5. Merge the release PR to approve deployment. The Changesets workflow pushes
   the immutable `vMAJOR.MINOR.PATCH` tag, and **App release** deploys production.
6. Run `verify-deployment` against `drive.trevors.link` and `files.trevors.link`.
   Call the release complete only after its report passes.

The fixed group includes `@tdrive/web`, `@tdrive/site`, `@tdrive/shared`, and
`@tdrive/cli`. A shared-library or CLI-only changeset advances the same application
version. All packages remain private. Automation publishes no npm packages,
CLI bundles, or app GitHub Releases. The existing CLI workflow still runs only
when you manually push a `cli-v*` tag.

`scripts/app-release.mjs` owns version preparation, tag creation, and tag
verification. Version preparation runs Changesets 2.29.8, mirrors the workspace
version to the root, regenerates `bun.lock` with Bun 1.4.0, and formats the
manifests and changelogs. Regeneration can update dependency resolutions, so review
the lockfile in the release PR. Internal `workspace:^` dependencies stay unchanged.
The bootstrap changeset prepares `0.1.1`. Installing the tooling does not release
or tag the existing `0.1.0` version.

### Recover a failed release

If release PR creation or tagging fails, rerun **Changesets** or dispatch it
manually on `main`. With no pending notes, the tag command finds the commit that
introduced the current version and its new workspace changelog entries. This
also recovers a lost run after later commits retain the same version.

An existing tag succeeds only when its peeled target is the exact release commit.
A conflicting tag or uncertain remote response fails. Do not move or force-push
an application tag. A tag that already exists does not trigger another deployment.

If deployment fails, rerun **App release** for the same tag. Applied migrations
remain applied, and the existing script repeats validation and both deployments.
If the site fails after the app succeeds, inspect the archived `.release-history`
and use the site rollback commands below if needed. The app and site deployments
are separate operations.

All automated app deployments share `tdrive-production` concurrency and never
cancel a running deployment. Inside that lock, verification checks the canonical
tag, root and workspace versions, release commit, remote tag, and main ancestry.
It rejects a queued or retried release once a newer release version reaches main.
GitHub does not guarantee queue order. Prepare a new release to deploy after a
superseded attempt. Reserve local `bun release` for coordinated recovery because
local commands do not acquire the GitHub production lock.

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
