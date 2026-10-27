# Vite+ monorepo workflow

## tdrive commands

tdrive uses Bun workspace scripts and Vite for SvelteKit. Use [test commands](testing.md#target-commands)
for current commands: `bun format:check`, `bun check`, `bun run test`, and workspace scripts.
`bun check` runs the workspace typechecks and repository checks, then `vp check`
for Oxfmt formatting and Oxlint linting through Vite+. Run `bun format` to format,
`bun format:check` to check formatting, or `bun lint` to lint separately. Their
shared settings live in the root `vite.config.ts`, including the vendored
anti-slop and Effect rules in `tools/oxlint/anti-slop/`. Their source provenance
is recorded in `tools/oxlint/anti-slop/UPSTREAM.md`.

Infrastructure lifecycle ordering is owned by `scripts/release.sh`; commands that mutate
external state must actually execute rather than be skipped by a cache.

## Upstream task-runner reference

The complete task-graph and cache-policy guidance below is retained as reference.
The task graph commands and Alchemy tasks below are not configured tdrive commands.

Vite+ owns repository checks and workspace task execution. The root `vite.config.ts` contains shared formatting, linting, type-checking, and Vite Task defaults; workspace `vite.config.ts` files own package-specific task graphs.

## Workspace boundaries

- `apps/*` contains independently runnable or deployable composition roots.
- `packages/*` contains cohesive capabilities shared by applications.
- Declare every workspace edge in the importing workspace's `package.json`; Vite Task uses this dependency graph for scheduling.
- Applications may depend on packages, but packages must not depend on applications.

## Commands

```sh
vp check
vp run ready
vp run @overseer/api#test:e2e:local
vp run @overseer/api#test:e2e:deployed
vp run @overseer/api#destroy:production
vp run @overseer/shared-infrastructure#plan:production
vp run @overseer/shared-infrastructure#deploy:production
```

`vp test`, `vp build`, and `vp dev` are built-in commands. `vp run <task>` executes a package script or configured Vite Task.

## Vite Task policy

Package scripts are uncached by default. Configured tasks are cached by default, but every task that deploys, destroys, plans, synchronizes external state, or starts a long-running process must set `cache: false`.

Alchemy infrastructure lifecycle commands belong in workspace Vite tasks rather than duplicate package scripts. Root aliases invoke those tasks through exact `package#task` selectors so every entrypoint uses the same dependency graph.

Cross-workspace infrastructure prerequisites belong in `dependsOn`. The API production deployment depends on `@overseer/shared-infrastructure#deploy:production`. Both API E2E tasks may use that fixed prerequisite to reconcile the explicitly permanent Axiom and reusable Access outputs, but the E2E harness itself deploys `OverseerSharedInfrastructure/<generated-stage>` before `Overseer/<generated-stage>` because Vite Task cannot know a stage generated inside the runner. Shared-infrastructure commands require the non-sensitive `OVERSEER_ACCESS_ALLOWED_EMAIL` deploy-time environment variable and Axiom provider credentials. The Cloudflare deployment principal must have Account API Tokens Write permission so Alchemy can create each stage's scoped account-owned token used by R2 Data Catalog maintenance and Pipelines sinks.

Runner flags precede task names. Use exact `package#task` selectors for infrastructure operations and `--fail-if-no-match` with filters in automation.
