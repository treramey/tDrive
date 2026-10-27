# Recover retained production resources

## tdrive recovery

Use this guide's inventory, provenance, non-destructive preview, partial-recovery, and stable
ownership principles. For tdrive, inspect the configured account, Worker deployments, D1 IDs,
R2 bucket, KV namespace, and Vectorize index before changing bindings or creating replacements.
Missing deployment state does not prove bytes or canonical metadata were deleted.

Current recovery procedures are in [backup-restore.md](backup-restore.md) and
[release.md](release.md). Preserve original resources, validate a scratch restore, and finish
with [verify-deployment](../.agents/skills/verify-deployment/SKILL.md).
tdrive does not have Alchemy Stack state or an adoption command.

## Upstream recovery runbook

The full worked example below is retained for its recovery decisions and completion criteria.
Its commands operate on the original project's infrastructure; do not execute them against tdrive.

Use this playbook when `OverseerSharedInfrastructure/production` state is absent or incomplete while its retained production resources may still exist. This is an exceptional recovery path, not the normal deployment lifecycle.

Alchemy retention skips the provider delete but removes the resource's state row. The R2 bucket, Queue backlog, R2 Data Catalog, and production Axiom traces can therefore remain live without an Alchemy owner after Stack destruction.

Run every Alchemy command below from the shared-infrastructure workspace so `pnpm exec` selects the repository-pinned CLI:

```sh
cd packages/shared-infrastructure
```

## 1. Stop and inventory state

Keep API deployment and event-producing Workers stopped while ownership is uncertain. Inspect the production stage without changing it:

```sh
pnpm exec alchemy state stages --stack OverseerSharedInfrastructure
pnpm exec alchemy state resources \
  --stack OverseerSharedInfrastructure \
  --stage production
```

An absent `production` stage or missing resource rows does not prove that the physical resources were deleted. Record which expected rows are present before continuing.

**Complete when:** the production stage is classified as absent, complete, or partial, and every existing state row has been recorded.

## 2. Inventory physical resources

Using the configured Cloudflare and Axiom accounts, inspect the provider control planes for:

| Retained resource | Physical identity                                         | Pinned-provider recovery behavior                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 bucket         | `overseer-event-data-lake`                                | Reads by exact bucket name and silently imports the result. R2 has no Alchemy ownership marker.                                                                                                                                                           |
| Queue             | `overseer-event-queue`                                    | Scans Queues for the exact name and silently imports the result. Queue has no Alchemy ownership marker.                                                                                                                                                   |
| R2 Data Catalog   | The active catalog attached to `overseer-event-data-lake` | Reads by bucket name and reports an active catalog without state as unowned; recovery requires `--adopt`.                                                                                                                                                 |
| Axiom dataset     | `overseer-production-traces`                              | Reads by dataset name. The expected description suffix is `[alchemy:stack=OverseerSharedInfrastructure;stage=production;id=OverseerProductionTracesDataset]`; a matching marker imports silently, while a missing or different marker requires `--adopt`. |

For the bucket and Queue, establish provenance from the account, name, prior deployment records, and operator knowledge before proceeding: their providers cannot distinguish an Overseer resource from an unrelated same-name resource. For the Data Catalog, verify that it is attached to the expected bucket. For Axiom, preserve the current description and marker in the inventory.

Do not copy account identifiers, API tokens, Queue messages, bucket objects, or trace payloads into the recovery record.

**Complete when:** each retained identity is classified as present and verified, absent, or conflicting; every present resource has evidence that it belongs to Overseer.

## 3. Preview recovery

If state is complete, first run an ordinary plan:

```sh
pnpm exec alchemy plan --stage production
```

For absent or partial state, preview the adoption-enabled deploy without applying it:

```sh
pnpm exec alchemy deploy --stage production --adopt --dry-run
```

The adoption flag is Stack-wide. Use it only after completing the physical inventory. In a lost-state recovery, expected evidence is:

- a present bucket and Queue are reconciled as cold-adoption updates, not creates or replacements;
- a present Data Catalog passes the otherwise expected `OwnedBySomeoneElse` gate and is reconciled as an adoption update;
- a present Axiom dataset is reconciled as an adoption update; its trace data is not replaced;
- any absent retained resource is planned as a create;
- deleted, recreatable credentials, Pipelines, tokens, and Access resources may be planned as creates.

Stop if a retained resource is planned for replacement or deletion, if an unexpected physical identity appears, or if the plan changes resources outside `OverseerSharedInfrastructure/production`.

**Complete when:** all four retained resources are accounted for by non-destructive adoption/update or intentional create actions, with no retained-resource replacement or deletion.

## 4. Resolve conflicts and partial recovery

Choose the branch matching the inventory or preview:

- **Verified retained resource is present:** keep its fixed physical identity and continue with adoption.
- **Retained resource is absent:** allow the plan to create it. For a missing bucket, confirm the retained Data Catalog is also absent or points to no live bucket before creation.
- **State row exists but the physical resource is absent:** allow ordinary reconciliation to recreate it; do not clear the remaining production state.
- **Physical resource exists but provenance is uncertain:** stop. Establish ownership or move the foreign resource outside this recovery procedure. `--adopt` authorizes takeover and is not evidence of ownership.
- **Axiom marker is missing or different:** verify the dataset's provenance and contents before adoption. A successful adoption rewrites its marker and desired mutable settings.
- **Recovery was interrupted:** rerun the inventory and dry run. Provider reconciliation is designed to converge, but the new state may now be partial.

**Complete when:** every conflict is either resolved with ownership evidence or the recovery is halted without applying changes.

## 5. Adopt and reconcile shared infrastructure

Apply the reviewed recovery plan:

```sh
pnpm exec alchemy deploy --stage production --adopt --yes
```

Then inspect the recovered rows:

```sh
pnpm exec alchemy state resources \
  --stack OverseerSharedInfrastructure \
  --stage production
```

Confirm that the bucket, Queue, Data Catalog, and production Axiom dataset all have state rows. Confirm in the provider control planes that their physical identities are unchanged. The Data Catalog maintenance credential may be refreshed from a newly created token; the production Axiom ingest and query tokens are recreated rather than retained.

**Complete when:** all retained resources are managed by production state under their original physical identities, and all recreatable shared dependencies have reconciled successfully.

## 6. Recover the API after shared infrastructure

Only after Step 5 succeeds, deploy the API Stack with the same stage using its workspace-pinned CLI:

```sh
cd ../../apps/api
pnpm exec alchemy deploy --stage production --yes
cd ../../packages/shared-infrastructure
```

The API must follow shared recovery so its bindings resolve to the recovered Queue and shared outputs.

**Complete when:** `Overseer/production` deploys successfully and the API references the recovered shared resources.

## 7. Prove stable ownership

Run an ordinary plan without `--adopt`:

```sh
pnpm exec alchemy plan --stage production
```

A stable recovery has no adoption error and no create, replacement, or deletion for the retained bucket, Queue, Data Catalog, or production Axiom dataset. Investigate any remaining retained-resource action before resuming normal production changes.

**Complete when:** the ordinary plan proves stable ownership and contains no replacement or deletion of any retained production resource.
