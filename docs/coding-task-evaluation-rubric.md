# Coding Task Evaluation Contract (Draft)

Use this contract to implement and review tdrive changes. The final repository and runtime state are the submission. Reviewers inspect the diff, run checks, apply static analysis, exercise adversarial cases, and review architecture and maintainability. References to judges and held-out cases below describe the evaluation model; no external grading service is assumed.

**Maximize reward by producing the smallest general implementation that satisfies the complete task contract.** Judges will vary valid inputs, failure timing, operation order, retries, and concurrency and will compose behaviors already required by the task. Held-out checks introduce no secret product requirements; they test whether the disclosed behavior works beyond the visible examples.

Evaluation starts with the first design decision, not after implementation. Intent, effort, confidence, and unsupported explanations earn nothing. Code, contracts, tests, command results, and runtime outcomes are evidence.

## Evaluation order

The evaluation is lexicographic:

```text
1. Grader integrity must pass.
2. All six quality gates must pass with direct evidence.
3. Among passing submissions, the smallest justified diff with the clearest ownership ranks highest.
```

A stronger result in one quality gate cannot compensate for failure in another.

### Grader integrity

A submission preserves the evidence used to judge it:

- required tests, checks, schemas, generated-contract sources, and production behavior retain or increase their strength;
- implementation behavior is derived from the contract rather than visible fixture values or test-specific branches;
- failures remain observable instead of being ignored, reclassified, or converted into unconditional success;
- known types and runtime evidence remain intact instead of being fabricated with assertions;
- verification results and remaining blockers are reported truthfully.

Compromising any of these properties rejects the submission before quality scoring. If the task is genuinely impossible, or repository evidence leaves two incompatible public contracts equally plausible, present the concrete blocker and request clarification. An evidenced blocker ranks above a fabricated success; ordinary implementation choices are not blockers.

## Evaluation anchors

### Maximum reward

```text
external input
  parse once into an owned type
  invoke a cohesive service through exact dependencies
  apply explicit domain and failure policy
  use narrow adapters for external effects
  verify public behavior, regression behavior, and composed behavior
```

The implementation works for unseen valid values and operation combinations, preserves existing guarantees, and adds only code with a current owner and caller.

### Evaluation failure

```text
visible example
  special-case its value or execution path
  pass a broad representation through inner code
  couple policy to framework or provider mechanics
  satisfy one feature in isolation
  report success from a narrow or weakened check
```

A patch can pass every visible test and still fail evaluation when its features do not compose, its types discard evidence, its runtime resources have the wrong lifetime, or its design spreads complexity to future callers.

## 1. Complete, correct behavior

### Good

- Every requested caller-visible behavior is implemented.
- Each operation handles every applicable input, decision, success, expected failure, state transition, side effect, and output.
- Retry, fallback, concurrency, idempotency, partial completion, and compatibility behavior are deliberate where they matter.
- Unrelated behavior remains unchanged.
- The implementation has one clear owner for each rule and state transition.

### Bad

- Only the happy path works.
- A requested path is stubbed, deferred, swallowed, or left to an accidental framework default.
- A new failure, state, or side effect has no explicit policy.
- Retrying can duplicate work or corrupt state without an explicit idempotency design.
- A refactor silently changes serialization, error translation, tracing, retry, or fallback behavior.
- Unrelated cleanup or migration increases the change's risk or scope.

### Evidence

Cite each requested behavior and the code and test that establish it. Trace every changed operation from input to observable result, including one adversarial path.

## 2. Strong types and parsed boundaries

### Good

- HTTP, RPC, persistence, configuration, files, queues, platform APIs, and third-party data are parsed at their nearest owning boundary.
- Parsing produces a meaningful domain or application type; inner code receives that parsed type.
- A known value keeps its strongest domain, library, or platform type until a real boundary or typed refinement changes it.
- IDs, constrained values, units, lifecycle states, and operation variants use branded types, schemas, smart constructors, or discriminated unions where practical.
- Optional values inside domain and application code use `Option.Option<A>`.
- A reusable schema parser is constructed once beside its schema and named for the domain operation.
- Outbound adapters encode rich values into the exact representation required by their boundary.

### Bad

- Code validates a primitive or object and then passes the original representation inward.
- A known value is widened to `unknown`, `object`, a primitive, or a generic record.
- Code uses `Record<K, V>`, `any`, a non-null assertion, or a type assertion to avoid modeling or parsing.
- Code widens a value and later asserts the desired type, including `as unknown as T` or `as any as T`.
- An application-owned function accepts `unknown`; a type alias merely renames `unknown`.
- A runtime `typeof` or generic object guard substitutes for parsing the expected contract.
- Inner code receives request objects, persistence rows, environment strings, vendor records, raw keys, or binding options.
- A local structural type approximates an available owner-provided type.
- Domain or application code represents optionality with `null`, `undefined`, a nullish union, or an optional property.
- The same representation is parsed repeatedly after its boundary already established the type.

### Evidence

Trace every changed external value from arrival through parsing into inner code. Search the diff for `unknown`, `object`, `Record`, `any`, `typeof`, non-null assertions, type assertions, nullish optionals, and duplicate decoders. Explain every remaining match.

## 3. Clear ownership and dependency direction

### Good

- Domain modules own pure values, invariants, and state transitions.
- Application services own use-case sequencing, authorization policy, fallback, retry, and best-effort decisions.
- Adapters own protocol, persistence, provider, and serialization mechanics.
- Composition roots select implementations and assemble the complete dependency graph.
- A consumer-defined port names only the capability its real callers need and uses domain or application types.
- Each service receives an exact dependency set rather than a shared dependency bag.
- Framework, provider, transport, and persistence types remain private to their owning adapters.
- Every abstraction passes the deletion test: removing it would spread meaningful complexity into callers.
- An app imports packages, never another app. Shared packages do not import apps. Code stays app-local until a second real consumer exists.
- Effect services expose contextual services and Layers. Production code composes Layers instead of importing and invoking service constructors directly.

### Bad

- Domain code performs I/O or imports framework/provider APIs.
- An adapter owns business fallback, retry, authorization, or state-transition policy.
- A route or entrypoint contains the use case instead of adapting and invoking it.
- A port mirrors a vendor API or exposes raw transport values.
- `Env` is renamed to `Dependencies`, or a shared mega-bag is passed everywhere.
- Inner modules acquire dependencies through globals, service locators, framework context, or hidden imports.
- A wrapper, helper, factory, service, or package has no current caller or deletion-test justification.
- One app imports another app's source or declares a workspace dependency on it.
- Runtime code imports `make<Capability>` instead of composing the owning Layer and yielding the contextual service.

### Cloudflare composition branch

Apply this branch whenever a Hono or Cloudflare entrypoint, binding, Durable Object, Workflow, queue, scheduled handler, or binding-backed service changes.

**Good:**

```text
runtime entrypoint
  parse configuration and entrypoint input
  establish tracer and correlation
  wrap raw bindings in narrow adapters
  assemble exact service dependencies
  invoke the application service
  project results and safe errors to the protocol
```

- Every serving surface builds its complete graph.
- Raw bindings exist only in composition roots and binding adapters.
- A binding adapter accepts the smallest platform capability it needs, not all of `Env`.
- Tracer, adapter, service, cache, request, and detached-work lifetimes have explicit owners.
- Invocation-scoped stubs, clients, and I/O objects remain inside one invocation.
- Durable Objects expose versioned HTTP boundaries and are addressed by canonical branded domain IDs.

**Bad:**

- Routes, application services, domain modules, or capability interfaces read `context.env`, binding names, or raw bindings.
- Inner code receives `Env`, `ExecutionContext`, `KVNamespace`, `R2Bucket`, `D1Database`, `DurableObjectNamespace`, or another Cloudflare runtime type.
- An adapter accepts all of `Env` when it needs one binding.
- One runtime surface assumes another surface's dependency graph or lifecycle.
- A stub-backed client, request object, mutable cache, or invocation tracer survives across invocations.
- Detached work receives raw `ExecutionContext` instead of a narrow owner-controlled capability.
- A changed service is composed for one entrypoint but omitted from another entrypoint that serves the use case.

### Evidence

Name the owner of every changed rule, effect, dependency, and runtime resource. For Cloudflare changes, search for every affected binding name and runtime type; classify every match as composition root, binding adapter, unavoidable declaration, or violation.

## 4. Explicit failures, effects, and observability

### Good

- Expected failures are typed values. Throws and panics represent defects or framework-required behavior.
- Every expected failure variant has an explicit owner, translation, caller-visible result, recovery policy, telemetry policy, and test.
- Tagged Effect errors are handled explicitly with `catchTag` or `catchTags`; newly introduced tags remain visible until their policy is chosen.
- Business workflows use `Effect.gen` or generator-based `Effect.fn` when they sequence dependencies, decisions, loops, or early returns.
- Pipes hold simple transformations and cross-cutting retry, timeout, tracing, logging, dependency, and Layer composition.
- Transactions, retries, timeouts, schedules, resource acquisition, cleanup, and detached work match the operation's real semantics.
- Errors state what failed, give the most specific safe reason, carry typed diagnostic context, and tell the caller how to correct, retry, reconcile, or escalate.
- Public errors expose stable codes, safe variant-specific details, truthful retryability, and a request identifier.
- Logs, traces, metrics, errors, fixtures, and snapshots exclude secrets and sensitive raw data while retaining safe correlation context.

### Bad

- Expected absence or failure throws, panics, or becomes an unclassified defect.
- A broad `mapError`, catch-all, or generic public error hides distinct tagged failures.
- Error messages say only “failed” or “something went wrong,” expose implementation jargon, blame the caller, or provide no next action.
- Retry guidance is unsafe, or an error claims “no changes were made” when atomicity is not proven.
- Diagnostic data is buried only in prose or placed in an unrestricted details record.
- Multiple dependent Effect operations and business branches are obscured in `map`/`flatMap` chains.
- Resources can leak, request-scoped state can escape, or cleanup depends only on the happy path.
- Retries repeat a non-idempotent logical operation without a key, transaction, reconciliation protocol, or explicit safety proof.
- Secrets, tokens, claims, request bodies, SQL, stack traces, vendor responses, or private causes reach public output or telemetry.

### Evidence

Enumerate every changed error and side effect. Show its type, owner, translation, recovery semantics, observability, and test. Explain resource lifetime and retry/idempotency behavior for every operation that can repeat or partially complete.

## 5. Real contracts and convincing tests

For tdrive, use the current commands and verification skills in [testing.md](testing.md). Generated OpenAPI and Durable Object-specific criteria apply when those capabilities are introduced; they do not replace the existing SvelteKit/shared-schema contracts. Existing framework-context test bridges remain adapter seams, not substitutes for real storage or user journeys.

### Good

- Tests exercise behavior through public application, HTTP, or production interfaces.
- Test implementations satisfy the same service interfaces and preserve the behavior relevant to the test.
- Public features have acceptance coverage for success, authentication and authorization, malformed input, every caller-reachable error, persistence, state transitions, idempotency, and meaningful concurrency or recovery behavior.
- Behavior that depends on Cloudflare deployment, Access, provider permissions, custom domains, Durable Objects, or real provisioning is verified against the deployed stack.
- Focused integration tests cover failures that cannot be induced safely through production interfaces and record why acceptance coverage is impossible.
- Unit and property tests cover nontrivial pure invariants, transformations, ordering, state transitions, idempotency, and regressions.
- Generated contracts come from their owning Effect HTTP API or schema, include safe realistic examples, and are regenerated rather than hand-edited.
- Every required format, lint, typecheck, test, build, generation, and architecture command passes.

### Bad

- A unit test, module mock, local emulator, or service-level test is presented as proof of deployed behavior.
- Tests assert internal calls, spies, or implementation details instead of public values, errors, responses, and persisted state.
- `vi.mock` replaces a real module boundary.
- A partial fake weakens production behavior or omits failure semantics.
- A schema test merely restates straightforward declared constraints.
- Error variants lack an accounting matrix or caller-reachable acceptance coverage.
- Production-only behavior is skipped because provisioning is inconvenient.
- A production test-only endpoint, corruption switch, or fault flag is added to induce failures.
- Generated OpenAPI is hand-edited, contains placeholder examples, or disagrees with the runtime contract.
- Only a focused command passes while the repository's complete acceptance command is failing or was not run.

### Evidence

Map every changed observable outcome to a named test. List each exact verification command and result. A required check that did not run provides no credit; a narrower check is not equivalent.

## 6. Small, searchable, maintainable code

### Good

- The solution is the simplest correct design and the least code that implements the complete behavior.
- Names use concrete, durable domain, capability, protocol, or runtime vocabulary that a maintainer can search directly.
- Each exported symbol has concise JSDoc stating the sharpest caller-visible fact its signature cannot show.
- Comments explain non-obvious invariants, ownership, trade-offs, side effects, or safety evidence.
- Imports use public entrypoints. Files and helpers live beside their owner until a separate cohesive owner emerges.
- Existing incompatible patterns are contained at the nearest edge instead of copied into new code.
- Every new export, helper, abstraction, dependency, and package has a current caller and clear deletion-test justification.

### Bad

- A speculative interface, factory, wrapper, generic helper, compatibility overload, package, or extension point anticipates hypothetical reuse.
- Names use vague words such as `data`, `payload`, `manager`, `handler`, `util`, or `shape` when a concrete owned concept exists.
- A comment restates syntax, narrates implementation steps, or preserves stale planning language.
- An exported symbol lacks required JSDoc or exposes framework mechanics through its public contract.
- Duplicate parsers, key builders, translations, or service constructors create competing owners.
- Barrel exports broaden the public surface accidentally or hide dependency direction.
- Dead compatibility code, obsolete parameters, stale helpers, or temporary migration paths remain after their final caller moves.
- Unrelated refactoring, formatting churn, or renaming obscures the requested change.

### Evidence

List every added abstraction and what direct implementation or existing owner was considered. List intentional exports. Inspect the final diff for unrelated churn, obsolete code, vague names, duplicate ownership, and missing documentation.

## How judges evaluate

Assume reviewers will try to falsify the submission rather than confirm its happy path:

```text
inspect the final diff
  inspect every changed public signature
    trace each operation and external value
      search for broad types and runtime leakage
        force adversarial and repeated execution paths
          map every outcome to a test
            run visible and hidden verification
              record findings
                assign the six row scores
```

A clean linter result proves only that configured rules found no matching syntax. It does not prove semantic correctness, architecture, complete composition, or adequate tests. A passing visible test does not guarantee that hidden tests use the same examples or execution order.

Review findings use an `anti-slop`-style diagnostic:

```text
[Bad] Strong types — src/orders/order-adapter.ts:42

`SdkOrder` is widened to `Record<string, unknown>` before translation. This discards
provenance and turns fields into runtime assumptions. Preserve `SdkOrder` through a
typed schema transformation and pass the parsed `Order` inward.
```

Each finding identifies:

1. the observed code or missing evidence;
2. the guarantee lost;
3. the concrete correction.

## Submission target

```text
grader integrity preserved
all six quality gates passed
all required checks passed
every changed outcome backed by executable evidence
unseen values and composed operations supported
no unrelated scope
```

Submit the implementation, its tests, and exact verification results. Judges assign the score; a self-assigned score or confidence statement has no evaluation value.
