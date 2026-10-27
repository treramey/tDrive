# Testing

Adapted for tdrive with the original acceptance strategy, error-path accounting, and worked
examples retained. The current implementation uses Bun, Vitest, SvelteKit, and Wrangler.
Named Alchemy/Workspace harness examples are reference designs, not installed tdrive APIs.

## Strategy

tdrive favors deployed-stack integration tests over every other test form. These tests exercise Overseer end to end through its deployed public API.

For tdrive, deployed acceptance exercises the actual dashboard/content origins, HTTP API, CLI, and relevant MCP tools against Cloudflare D1/R2/KV and enabled platform capabilities. Use [verify-deployment](../.agents/skills/verify-deployment/SKILL.md) with uniquely prefixed disposable resources and cleanup. Wrangler-backed route tests and [verify-adrive](../.agents/skills/verify-adrive/SKILL.md) provide fast isolated local feedback but do not replace deployed acceptance.

Every public feature and endpoint must have deployed end-to-end coverage for:

- successful behavior;
- authentication and authorization;
- malformed external input;
- every caller-reachable error contract;
- persistence across requests;
- state transitions and idempotency guarantees;
- meaningful concurrency, recovery, or asynchronous behavior.

A feature is not complete merely because a unit, service integration, or local-runtime integration test covers it.

For the retained upstream Alchemy and `@effect/vitest` API investigation, see [`research/alchemy-effect-vitest-testing.md`](https://github.com/dmmulroy/overseer/blob/9810d13bb930144ba92a00bc99401fcb886cb8e7/docs/research/alchemy-effect-vitest-testing.md).

## Test Targets

- `local` uses Wrangler's migrated D1/R2/KV test state and the disposable browser/CLI/HTTP verification runtime. It is the fast debugging and development loop.
- `deployed` verifies the real Cloudflare deployment through the production verification skill. Its mandatory checks and PASS/FAIL/INCONCLUSIVE rules define the acceptance boundary.

Keep feature behavior independent of target-specific readiness, authentication, and teardown. Current tdrive suites use the existing route/platform fixtures and public CLI/HTTP/MCP contracts. The reusable typed-client, automatic-deployment, and trace-retention architecture below is a reference for a future harness; it is not an installed requirement.

## Default Test Lifecycle

For current tdrive local journeys, use the verification skill's new → launch → doctor → drive → cleanup lifecycle. Route tests apply all migrations to isolated `.wrangler/test-state`, acquire a shared Wrangler platform proxy, run sequentially, and dispose it. Live checks use only uniquely prefixed disposable resources and always attempt cleanup.

### Upstream lifecycle example

The full deployment-lifecycle example below preserves environment isolation, dependency ordering, and fallback cleanup principles. Its Stack, Access, Queue, and Axiom resources belong to the upstream harness.

In that reference harness, every deployed test invocation:

1. Reconciles the independently managed production shared-infrastructure Stack that owns the reusable human Access policy, using `OVERSEER_ACCESS_ALLOWED_EMAIL` as its single allowlisted address.
2. Generates a unique DNS-safe Alchemy stage such as `test-<user>-<timestamp>-<entropy>`.
3. Deploys `OverseerSharedInfrastructure/<stage>` with an isolated Queue and complete isolated event-data subsystem.
4. Deploys a fresh `Overseer/<stage>` API Stack through the same provider mode and references both the stage-owned Queue and the permanent Access policy without transferring ownership.
5. Waits for the Access-protected API Worker and Workspace Durable Object to become ready.
6. Runs the registered feature tests.
7. Destroys the API Stack and then the shared-infrastructure Stack through Vitest lifecycle hooks.
8. Runs outer fallback cleanup in the same reverse dependency order only if the deployed test process fails or is interrupted.

Assume provisioning test infrastructure is cheap, fast, and free. Cost is not a reason to reuse infrastructure, skip a deployed provider boundary, or replace deployed-stack coverage with a local runtime.

A stage is shared only within one test invocation. Never test against `local`, a developer deployment stage, `production`, or another test run's stage. Concurrent invocations remain isolated through distinct stages.

## Alchemy Harness

**Reference implementation:** the registration, lifecycle, tracing, and client examples in this section describe the upstream harness. Preserve these design details when evaluating a future tdrive harness; current tdrive does not acquire Alchemy Stacks or Axiom tokens.

The suite creates one registration-time harness and shares its Stack lifecycle across feature modules:

```ts
const harness = OverseerTestHarness.fromStack(OverseerApiStack);

registerAccessTestSuite(harness);
registerWorkspaceTestSuite(harness);
```

`OverseerTestHarness.fromStack` owns `alchemy/Test/Vitest` deployment, readiness, service Layers, and teardown. Readiness verifies the API identity, then retries a safe known-absent Workspace read until the Workspace Durable Object returns its stable not-found contract. `TestExecutionTracing` wraps each running test in an execution root span, exports standard OTLP JSON directly to Axiom, and explicitly flushes after the root span closes. The finished `TestExecution.trace` stores `Completed` evidence containing the provider, permanent dataset name, and trace ID.

Tracing acceptance is an explicit after-run check rather than an implicit product-test verdict. `AxiomTraceQuery` uses the query-only token to poll retained spans until every execution trace has a closed parent graph, every HTTP server span resolves to its HTTP client parent, every HTTP client span has its server child, and one execution trace contains the independently running `overseer-e2e-harness` and `overseer-api-worker` services plus the `api-worker` and `workspace-durable-object` values of the `overseer.runtime.component` span attribute. Polling accommodates Axiom ingestion and telemetry emitted by late scope finalizers. The Durable Object classes share the API Worker's deployment and therefore remain runtime components of that OpenTelemetry service rather than claiming separate `service.name` resources. Product execution status remains determined only by the test Effect exit.

Deploy once per integration suite file. Keep deployed tests sequential so Vitest workers cannot race deployment and destruction.

## Suite Organization

**Reference layout:** the proposed API harness layout is retained below. Current tdrive tests live beside shared/CLI/web modules; web runes and route tests have separate Vitest configurations. Route fixtures are in `apps/web/src/lib/server/test`, and route integration tests in `apps/web/src/lib/server/routes`.

```text
apps/api/
  scripts/
    run-e2e.ts                   # selects target, creates stage, and owns fallback cleanup
  test/
    e2e.test.ts                  # composes one shared harness and feature suites
    e2e/
      api/                       # target deployment readiness and typed API client
      evidence/                  # persisted run, execution, assertion, and artifact evidence
      harness/                   # test registration, run identity, fixtures, and lifecycle
      suites/                    # public product guarantees grouped by capability
      tracing/                   # Axiom export, query, and distributed-trace acceptance
```

Only `e2e.test.ts` is independently discovered by Vitest. The feature modules export functions that register tests into that shared integration suite without using test-runner-discovered filenames.

Split the integration suite into multiple independently discovered `*.e2e.test.ts` files only when each file owns a separate stage and Stack lifecycle, or when a run-wide deployment fixture safely coordinates them.

## Initial Public API Matrix

**Worked example:** retain the complete Workspace matrix below as a template for success, malformed input, persistence, transitions, and concurrency. For tdrive, apply the same accounting to files, versions, tags, sites, credentials, and MCP tools using the actual routes and [feature map](../.agents/skills/verify-adrive/features/README.md). File creation uses `PUT /api/files`, reads use `GET /api/files/:id`, mutations use the existing PATCH/DELETE contracts, and version uploads use `PUT /api/files/:id/versions`.

Assume the main Worker adds public Workspace handlers backed by `WorkspaceClient`, which routes operations to the `WorkspaceServer` Durable Object keyed by `WorkspaceId`.

The concrete public `HttpApi` remains the source of truth. This initial outline assumes:

```text
GET  /
POST /v1/workspaces
GET  /v1/workspaces/:workspaceId
POST /v1/workspaces/:workspaceId/rename
POST /v1/workspaces/:workspaceId/archive
POST /v1/workspaces/:workspaceId/unarchive
```

### Access and API identity

- A provisioned Agent service token reaches `GET /` and receives the API identity.
- Missing Access credentials are rejected at the public edge.
- Invalid service-token credentials are rejected.
- Every Workspace endpoint rejects an unauthenticated request, proving authentication middleware is attached to each route.
- Access secrets and complete response headers are never logged or snapshotted.

### Create Workspace

- A valid name creates an active Workspace with a canonical generated ID and parseable timestamps.
- A separate GET returns the persisted Workspace.
- Distinct creates return distinct IDs backed by independent Durable Object state.
- Missing, malformed, empty, whitespace-only, overlong, multiline, control-character, and otherwise invalid names return the declared request error without creating a Workspace.
- Success followed by a separate GET demonstrates that Workspace Durable Object persistence completed.

### Get Workspace

- A created Workspace is returned by ID with its complete representation.
- A valid unknown ID returns the public not-found contract.
- A malformed path ID returns the public request-parsing contract.

### Rename Workspace

- Rename changes only the name and update timestamp.
- ID, creation timestamp, and lifecycle state are preserved.
- A following GET observes the new name.
- A valid unknown ID returns not found.
- Invalid names return the declared request error and leave the Workspace unchanged.
- The contract must explicitly decide whether archived Workspaces can be renamed; test the resulting behavior.

### Archive and unarchive Workspace

- Archive changes and persists the state to `archived`.
- Unarchive changes and persists the state to `active`.
- Identity, name, and creation timestamp remain unchanged.
- Archive and unarchive of an unknown ID each return not found.
- Repeated archive and unarchive operations cover the declared idempotency or transition-error contract.
- A complete create, rename, archive, read, unarchive, read journey preserves coherent state and nondecreasing timestamps.

### Protocol and concurrency

- Wrong methods, malformed JSON, unsupported content types, and unexpected payload fields cover Overseer's declared HTTP behavior.
- Concurrent mutations against one Workspace verify that deployed Durable Object serialization and SQLite transactions prevent corruption.
- Concurrency assertions describe legal final outcomes without assuming request arrival order.
- Typed clients verify normal application responses. Raw status and body assertions cover Access edge and malformed protocol responses.

## Error-Path Accounting

Maintain a matrix beside each feature spec that maps every declared success and error variant to a test.

Caller-inducible errors must run against the deployed application. Examples include:

- missing or invalid authentication;
- malformed payloads, paths, and queries;
- unknown IDs;
- illegal state transitions;
- ownership failures and conflicts;
- invalid pagination cursors.

Some internal failures cannot be safely induced through the production public API, including the upstream example's Workspace reasons `database_unavailable`, `stored_workspace_invalid`, and `workspace_id_mismatch`.

Never add production test-only endpoints, corruption switches, or fault flags. Prefer, in order:

1. An additional isolated scenario deployment using the same public handlers with a controlled dependency Layer.
2. A deployed-stack integration test through an existing operational boundary that naturally creates the condition.
3. A focused integration test through the real service or HTTP interface when a scenario Stack would misrepresent production.

Every error covered below the deployed application records why it cannot safely be induced there.

## Supporting Tests

Supporting tests are narrower tools, not substitutes for deployed-stack acceptance.

### Integration

Use integration tests for otherwise uncontrollable failure translations, real SQLite migrations and transactions, and application behavior through public Effect service or HTTP interfaces. Provide complete test Layers; do not mock production behavior with `vi.mock`. tdrive's existing `$app/server` request-context bridge is a contained framework adapter seam; its synthetic cookies do not prove browser enforcement.

### Unit and property

Use focused tests for nontrivial pure invariants, state transitions, normalization, ordering, idempotency, and regressions. Property execution belongs in this supporting-test layer, not in the local or deployed end-to-end harness. Do not restate straightforward Schema declarations or Effect/library behavior.

### Local runtime

The local-runtime integration target is an explicitly selected emulator-only feedback mode. It does not cover custom-domain deployment, provider permissions, live AI/Vectorize or Browser Rendering, scheduled cloud execution, or real cloud persistence. It remains a qualified local counterpart rather than a separate test category or a substitute for the deployed-stack integration suite.

## Generated End-to-End Test Data

End-to-end tests may sample a small, deterministic set of valid mock values from Effect Schema-derived FastCheck arbitraries. Sampling is only test-data construction: the harness executes each registered test once and does not run FastCheck properties, shrinking, or repeated generated infrastructure scenarios.

## Effect Vitest Conventions

The Effect-specific helpers below apply when using `@effect/vitest`; tdrive currently uses ordinary Vitest and its existing Effect runners. Do not assume those helpers are installed.

- Use ordinary `it` for synchronous pure behavior.
- Use `it.effect` for scoped Effect programs and test services such as `TestClock`.
- Alchemy's harness uses live runtime services for deployment and HTTP I/O.
- Use `layer(...)` only when one acquired Layer is intentionally shared by the block.
- Provide a fresh Layer per test when mutable state must be isolated.
- Assert public values, errors, responses, and persisted state—not implementation calls or spies.
- Use bounded schedules for polling and explicit timeouts for deployment and provider operations.

## Target Commands

Current tdrive commands, from the repository root:

```sh
bun format:check
bun check
bun run test
bun --filter @tdrive/web test
bun --filter @tdrive/web test:runes
bun --filter @tdrive/web test:routes
bun --filter @tdrive/cli test
bun --filter @tdrive/shared test
```

`bun run test` runs workspace tests plus the web runes and route suites; it does not deploy.
Run relevant local verification journeys after user-facing changes. Releases additionally require
the live verification skill. Documentation-only changes need formatting and reference checks.

### Upstream runner example

The commands and trace/teardown details below belong to the original harness and are retained as
reference. They are not tdrive scripts.

The upstream repository provides these commands:

```sh
pnpm test                 # unit tests, then real Cloudflare acceptance
pnpm test:unit            # unit tests only
pnpm test:e2e:local       # fast workerd end-to-end feedback with Axiom traces
pnpm test:e2e             # real Cloudflare acceptance with Axiom traces
pnpm test:e2e:deployed    # explicit alias for real Cloudflare API acceptance
```

`pnpm test` is the complete suite. `test:e2e` runs without task caching so every invocation deploys and verifies a fresh Stack. `test:unit` is an explicit narrower choice and must not be described as equivalent confidence.

Inspect retained traces in Axiom's OpenTelemetry Traces app by searching the `overseer-e2e-traces` dataset for the trace ID stored in execution evidence. E2E runtimes receive only the ingest token; acceptance tooling receives only the query token.

The outer runner generates a unique stage for every invocation. The harness deploys the shared-infrastructure Stack before the API Stack through one Alchemy Vitest instance, preserving the generated stage and provider mode. Deployed runs use Alchemy's Vitest `afterAll(destroy(Stack))` hooks as primary teardown; the outer runner invokes fallback destruction only after failure or interruption. Local runs first close the dev sidecar, then let the outer runner destroy API and shared local Stack state in that order to avoid the pinned sidecar teardown deadlock.
