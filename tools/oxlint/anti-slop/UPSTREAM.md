# Anti-slop provenance

Installed from the bundled assets of the local `install-anti-slop` skill on
2026-10-27. This is the installed bundle, not a claim to match current upstream.

- Source repository: <https://github.com/dmmulroy/anti-slop>, as recorded by
  `/home/tmr/.agents/.skill-lock.json`.
- Skill path in that repository: `skills/install-anti-slop/SKILL.md`.
- Local source: `/home/tmr/.agents/skills/install-anti-slop/assets/anti-slop/`.
- Skill installer metadata: `skillFolderHash`
  `97962dc9fad565ca7695bf57805d9d0138ce1def`. This is not treated as a source
  commit or proof of the copied assets' revision.
- Exact upstream commit: **unknown**. The installed skill does not include Git
  history or an immutable source revision. Do not use upstream HEAD as the base
  for a later update.
- All 38 copied files match the local bundle byte for byte. `SHA256SUMS` records
  their relative paths and SHA-256 digests; verify from this directory with
  `sha256sum --check SHA256SUMS`. The manifest's SHA-256 is
  `388580c057cb1000858d097c1ff84541bac14453bc3c07e66f33bb50e99797f7`.
  These digests identify the bytes but cannot reconstruct a missing baseline.

## Installed paths and local policy

The generic entry point is `tools/oxlint/anti-slop/index.ts`; the Effect entry
point is `tools/oxlint/anti-slop/effect/index.ts`. Both are registered in the root
`vite.config.ts` under `lint.jsPlugins`. All 18 generic rules, the native
`oxc/no-accumulating-spread` companion rule, and all five Effect rules are errors.
Effect rules are enabled because the web, CLI, and shared packages directly
depend on `effect`. The Effect service import rule covers relative imports;
package-alias imports are not enforced by that rule.

There are no source deviations. This provenance record and `SHA256SUMS` are
local additions. The nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md`
are preserved, including the Stylistic revision and documented adapters.

Vite+ is pinned to `1.4.0` and supplies Oxlint `1.89.0` and Oxfmt `0.74.0`.
The directly imported `@oxlint/plugins` dependency is pinned to `1.89.0` to match
Vite+'s bundled Oxlint. Keep that pair aligned when upgrading Vite+. The initial
standalone Oxlint installation used `1.90.0` for both packages.

`bun lint` runs `vp lint .`; `bun format` and `bun format:check` run Oxfmt through
`vp fmt`. `bun check` runs the existing workspace typechecks and repository
checks, then `vp check`, including in release gates. Agent assets, the vendored
plugin, and generated Worker types are excluded from both lint and formatting
to preserve their original bytes.

The 2026-10-27 Vite+ migration changed configuration and dependencies only for
these rules. It preserved every rule, severity, plugin path, ignore, and copied
source file. Formatting settings moved from Prettier into `fmt` in the root
`vite.config.ts`, with Svelte support enabled, the original 80-column width,
tabs, single quotes, and no trailing commas. Package key sorting is disabled
to preserve existing manifest order. Oxfmt's two formatting differences in
`apps/web/src/app.css` and `apps/web/src/lib/server/errors.ts` were applied.
The root config is a plain typed object so existing Vitest 4 suites do not load
Vite+'s Vitest 5 plugins. App build and test dependencies retain their versions.
The pre-migration configuration, lockfile, and vendored tree were backed up at
`/tmp/tdrive-before-vite-plus-vjz0hqxn`.

## Installation verification

- Verified all copied files against the skill bundle and checked the lint file
  list excludes vendored code, agent assets, and generated Worker declarations.
- CLI smoke checks accept typed code and reject unknown parameters, runtime
  `typeof` checks, and manual Effect tag comparisons through the registered
  plugins. The bundle contains no upstream tests; these checks do not claim full
  rule conformance.
- `bun run format:check` passes for all 271 matched files, including Svelte.
  A second Oxfmt write pass leaves files unchanged. The Vite+ root configuration
  also passes TypeScript checking.
- Workspace TypeScript, Effect diagnostics, and Svelte checks pass, as do the
  forbidden API and Wrangler drift checks.
- `bun run test` passes all 296 tests across 53 test files, including the CLI,
  shared package, web unit tests, Svelte runes tests, and route integration tests.
- Vite+ smoke checks accept typed code and reject the same generic and Effect
  violations. Vendored checksums still match and lint/format ignores were
  exercised through Vite+.
- Before application cleanup, `bun run lint` and `vp check` reported 2,581 errors
  and nine warnings across 194 files, including 2,293 spacing errors.

## Application cleanup

On 2026-10-27 the existing findings were resolved without changing vendored
rules, severities, or ignore patterns. Spacing fixes were applied before
semantic edits. Response and database parsing now use schema decoders;
Effect branches use typed matchers and constructors. Test module mocks were
replaced by explicit API dependencies or SvelteKit's real request context.
Remaining fixture assertions document their specific safety assumptions.
Zod Mini validates dashboard responses and the root Wrangler configuration
check; the latter declares Zod as a root development dependency.

`bun run lint` and `bun run check` pass with zero lint errors and warnings.
Oxfmt and a second lint-fix/format pass leave files unchanged. All 296 workspace
tests, the Wrangler check tests, web and CLI builds, and the built CLI's contract
tests pass. The generated production Worker proof passes for ES256/RS256
authentication, replay/signature rejection, session migration, and D1 restore.

The initial local browser attempt was blocked by occupied ports. A fresh retry
passes browser sign-in, upload cancellation, toolbar upload, reload/detail,
anonymous download byte equality, and sign-out with API rejection afterward.
CLI file and stdin/stdout round trips also pass. T3's browser lacked host
libraries, so the skill's Docker Chromium fallback supplied the browser proof.
The harness now waits for sign-out completion before navigating and checks the
file detail page's sign-in link. All disposable runtimes were cleaned up.
Retry evidence is retained under
`/home/tmr/.local/state/adrive-verification/437faf6f-da7a-4321-8b04-e5cb65b9ad68/evidence`.
