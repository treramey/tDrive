# Overseer Infrastructure Lifecycle

## tdrive lifecycle

tdrive uses Wrangler, a SvelteKit application Worker in `apps/web`, and a separate static
Worker in `apps/site`. D1 owns canonical metadata/credentials, R2 owns bytes, AUTH_GUARD
provides KV mitigation/cache, and AI/Vectorize/BROWSER supply additional capabilities.
Local development and route tests use isolated emulator state.

Use [release.md](release.md) and the checked-in Wrangler configurations for current
provisioning, builds, migrations, and deployment; see [testing.md](testing.md) for validation.
Wrangler environments must declare their bindings explicitly. The isolation, ownership,
creation order, reverse cleanup, and permanent-versus-disposable resource principles below apply.

## Upstream architecture reference

The complete resource matrix below describes the source project's Alchemy event-data system.
It is retained as a detailed lifecycle example; its Stack, Queue/Pipeline, Axiom, and Access
resources are not current tdrive infrastructure.

Overseer has one shared-infrastructure Stack and one API Stack. Both use the same Alchemy stage for every production, preview, test, and local invocation.

## Resource matrix

| Environment           | `OverseerSharedInfrastructure/<stage>`                                                                                                                                                                                                                                                                                                    | `Overseer/<stage>`                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production            | Live Queue, R2 event lake, R2 Data Catalog, Pipeline stream, three sinks, and three SQL Pipelines. The Queue, event bucket, Data Catalog, and production Axiom trace dataset are retained. Established physical names are fixed. Also owns the E2E Axiom dataset, Axiom tokens, and reusable Access policy.                               | Live API Worker, Durable Objects, service token, agent policy, and Access application.                                                                             |
| Preview/deployed test | Isolated live Queue and complete isolated live event-data subsystem. Physical names are Alchemy-generated and include Stack, stage, logical ID, and instance entropy. The event bucket is destroyable and uses `forceDestroy`. Permanent Axiom and reusable Access outputs are referenced from `OverseerSharedInfrastructure/production`. | Isolated live API Worker, Durable Objects, service token, agent policy, and Access application.                                                                    |
| Local test/dev        | Local `dev:` Queue through Alchemy's workerd Queue broker. The R2 bucket, catalog token, R2 Data Catalog, Pipeline stream, sinks, and SQL Pipelines remain isolated-live as one connected subsystem.                                                                                                                                      | API Worker and Durable Objects run in workerd with the existing local authentication substitute. The Worker uses the native `Cloudflare.Queues.WriteQueueBinding`. |

Alchemy has local providers for Queue and R2 Bucket, but the pinned `Cloudflare.Pipelines.Stream`, `Sink`, and `Pipeline` providers and `Cloudflare.R2.DataCatalog` provider are live-only. The event-data resource Effect is therefore wrapped in `Alchemy.remote()` during local runs. This boundary deliberately keeps the live Data Catalog and Pipeline sinks attached to a live, stage-owned R2 bucket instead of a local `dev:` bucket. The Queue remains local because workerd lowers a `dev:` Queue binding to its local broker, while a future local Queue consumer can bind the isolated-live Pipeline stream: workerd lowers `pipelines` bindings to its remote Pipeline binding by stream ID.

## Ordering

Create in this order:

1. Reconcile `OverseerSharedInfrastructure/production` when permanent Axiom or reusable Access outputs are needed.
2. Deploy `OverseerSharedInfrastructure/<stage>`.
3. Deploy `Overseer/<stage>`.
4. Run tests or serve the environment.

Destroy in reverse dependency order:

1. Destroy `Overseer/<stage>` so Worker bindings are removed first.
2. Destroy `OverseerSharedInfrastructure/<stage>`.

The E2E harness deploys both dynamic-stage Stacks with one `alchemy/Test/Vitest` instance, which gives them the same stage, `dev` flag, and local sidecar. Deployed teardown uses reverse-registered Vitest hooks. Local teardown intentionally waits for Vitest to close the dev sidecar, then the outer runner destroys the API Stack before the shared Stack.

Production's fixed-stage Vite task dependency remains valid. E2E Vite tasks may still reconcile production shared infrastructure for the explicitly permanent outputs, but dynamic shared and API deployment happens inside the harness after the runner generates the test stage.

If production shared Stack state is absent or partial while retained resources still exist, follow [Recover retained production resources](production-retained-resource-recovery.md) before deploying the API.
