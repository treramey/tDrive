# Publish a site

Users publish a directory as a public site, then atomically republish new assets at the same stable URL.

## Sub-features

- `site-create`: staged directory upload and publish.
- `site-assets`: index and relative asset paths.
- `site-republish`: stable URL switches to a new version with updated assets.
- `site-dashboard`: site listing/detail, open link, audit history.

## How to get to it (user POV)

- Run `bun adrive site put DIRECTORY --name NAME`.
- Republish with `bun adrive site put DIRECTORY --id SITE_ID`.
- Open the site from Files and use Share `Open` on its detail page, or navigate to its printed `/s/SITE_ID/` content URL.

## Driving it with browser/CLI/HTTP

Preconditions:

- Doctor passes; baseline `$RUN/evidence/inputs/site/index.html` contains `Verification orchid site`. CLI fixture auth is valid.
- For the relative-asset journey add a real stylesheet/image and reference it in index.html **before** publishing. Without assets the journey fails its precondition; an index-only load does not prove relative resolution.

- **Publish.** Run `"$CONTROL" cli "$RUN" -- --json site put "$RUN/evidence/inputs/site" --name verify-site`. Capture command/stdout/stderr/exit 0 and the actual SITE_ID/URL. In a fresh unauthenticated browser tab navigate to `http://localhost:5174/s/SITE_ID/`; capture `Verification orchid site` and the rendered asset. Save downloaded index/asset responses and compare their bytes to inputs.
- **Dashboard.** In the signed-in dashboard reload Files and open `verify-site`; expect site metadata, public Share `Open`, and current audit version. Follow Share Open and confirm the same content-origin stable URL. Site detail must not expose ordinary file replacement upload.
- **Republish.** Preserve original inputs in evidence, then change the site's heading to `Verification orchid site v2`, update one asset, and remove another. Run `"$CONTROL" cli "$RUN" -- --json site put "$RUN/evidence/inputs/site" --id SITE_ID`. Expect the same site ID/stable URL. Reload the unauthenticated content page, verify updated heading/assets and removed asset 404, then compare current bytes with inputs. Reload dashboard detail; audit history must include both versions, with only current content addressable.

## Gotchas

- A folder dropped in the dashboard is rejected with guidance to use `adrive site put`; it is not another publish entry.
- Directories need index.html; do not weaken the journey if the manifest is invalid.
- The CLI does not follow symlinks. Use regular assets and report rejected path/manifest cases separately.
- Sites are always public and old audit versions do not provide addressable historical assets via `?v=`.
- This local journey proves staged API/R2 behavior in emulators, not Cloudflare edge caching or production deployment.
