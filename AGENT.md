# Agent Instructions

Adapted from [dmmulroy/overseer](https://github.com/dmmulroy/overseer/blob/9810d13bb930144ba92a00bc99401fcb886cb8e7/AGENT.md) with project-specific tooling and applicability notes.

## Project Standards

Read [`docs/coding-standards.md`](docs/coding-standards.md) before writing or reviewing code. Review finished code against those standards before declaring the work complete.

Read [`docs/errors.md`](docs/errors.md) before adding or changing typed errors, error messages, public error contracts, HTTP error statuses, retry guidance, or failure telemetry.

Read [`docs/testing.md`](docs/testing.md) before adding or changing application behavior, public endpoints, or tests. Apply its acceptance strategy and error-path accounting before declaring the behavior complete.

Before adding or moving a workspace, package dependency, or cross-workspace import, apply [`Monorepo Boundaries`](docs/coding-standards.md#monorepo-boundaries).

Before changing a parser, schema boundary, persisted representation, migration, or constrained state, apply [`Provenance and Parsing`](docs/coding-standards.md#provenance-and-parsing) and [`Persistence Provenance and Recovery`](docs/coding-standards.md#persistence-provenance-and-recovery).

Before proposing or changing lint rules, plugin behavior, parser-API enforcement, or complexity policy, read [`Slop Prevention Research`](https://github.com/dmmulroy/overseer/blob/9810d13bb930144ba92a00bc99401fcb886cb8e7/docs/research/slop-prevention.md).

Every environment must receive isolated infrastructure with the same capability topology where supported: production and preview/test deployments use environment-owned live resources, while local development uses Wrangler's faithful emulators where available. Apply [`Environment-Isolated Infrastructure`](docs/coding-standards.md#environment-isolated-infrastructure) before adding resources, fixed physical names, shared-resource references, or infrastructure script dependencies.

## tdrive Workflow

Read [docs/release.md](docs/release.md) for deployment/migration compatibility, [docs/backup-restore.md](docs/backup-restore.md) for recovery, and [docs/security-notes.md](docs/security-notes.md) for dependency exceptions.

Use Bun workspace scripts. Relevant code checks are `bun format:check`, `bun check`, and `bun run test`; see [test commands](docs/testing.md#target-commands). Preserve existing dashboard/content origin separation and compatibility identifiers. Regenerate binding declarations with `bun --filter @tdrive/web types:worker` after Wrangler binding changes.

After relevant user-facing changes, use [verify-adrive](.agents/skills/verify-adrive/SKILL.md) and its feature recipes. Use [verify-deployment](.agents/skills/verify-deployment/SKILL.md) for live deployment acceptance. First-ever deployment uses [deploy-fresh-instance](.agents/skills/deploy-fresh-instance/SKILL.md); routine releases use `bun release`. Read [use-tdrive](.agents/skills/use-tdrive/SKILL.md) when asked to use tdrive.

The detailed standards and examples are intentionally preserved. Applicability notes distinguish current tdrive tooling from reference designs; they do not weaken transferable type, error, testing, ownership, or recovery principles. Existing wire formats remain compatibility boundaries.

## Library Reference

tdrive has no vendored `repos/` tree. Prefer installed package source/types and matching first-party documentation over generated guesses. Read any library-provided agent guidance before making related changes. Do not import dependency internals or copied reference sources into application code.
