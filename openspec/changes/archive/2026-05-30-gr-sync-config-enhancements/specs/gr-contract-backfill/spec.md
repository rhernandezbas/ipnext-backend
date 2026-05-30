# Spec — gr-contract-backfill (resumable, batched contract backfill)

**Capability**: `gr-contract-backfill`
**Type**: New
**Change**: `gr-resync-all` (folder `gr-sync-config-enhancements`)
**Layer**: Application use cases (ports only) + scheduler integration (infrastructure)
**New SyncState entity**: `gr-contracts-backfill` (reuses the existing `SyncState` table — no schema change)
**Test runner**: `npx jest` · Strict TDD (RED → GREEN → REFACTOR)

---

## Purpose

Make the contract backfill cover the contracts of **ALL local GR clients** (not only the ones touched in a
given tick) and make it **resumable and bounded**: a watermark drives a fixed-size batch per scheduler tick,
so a full re-sync of contracts proceeds incrementally without holding the `gr-sync` lock for hours and
survives container restarts.

The watermark is an **offset** into the deterministically-sorted list of local `grClienteId`s returned by
`ClientMirrorReadRepository.listGrClienteIds()`. It is stored as the `cursor` of the `gr-contracts-backfill`
SyncState row. "Armed" = cursor encodes an offset `>= 0` and `< total`; "done/disarmed" = a terminal
sentinel (e.g. `null` or `"done"`) so no further batches run.

---

## 1. Watermark advances one bounded batch at a time

### REQ-BACKFILL-1: A batch processes at most `batchSize` clients and advances the watermark

`BackfillGrContractsBatch.execute()` MUST, when the backfill is armed:
1. Read the sorted local id list via `listGrClienteIds()` (sorted ascending, deterministic).
2. Read the current offset from the `gr-contracts-backfill` watermark (0 when newly armed).
3. Take the slice `[offset, offset + batchSize)`.
4. For each id in the slice, fetch its contracts via `GestionRealPort.fetchContractsByClient` and upsert them
   via `ClientMirrorRepository.upsertContract` (the existing `SyncGestionRealContracts` collaborator MAY be
   reused).
5. Advance the watermark offset by the number of ids processed and persist it.

It MUST process **no more than `batchSize`** clients in a single call (bounded). It MUST return a summary of
the batch: `{ processed, fetched, created, updated, nextOffset, done }`.

#### Scenario: A single batch is bounded and advances the watermark

- GIVEN a local universe of 5 sorted ids `[c1,c2,c3,c4,c5]` and `batchSize = 2`
- AND the `gr-contracts-backfill` watermark is armed at offset 0
- WHEN `BackfillGrContractsBatch.execute()` runs once
- THEN it fetches contracts for exactly `[c1, c2]` (2 GR calls, not 5)
- AND it upserts those contracts into the mirror
- AND the persisted watermark offset is now 2
- AND the result reports `processed: 2, done: false`

---

## 2. Backfill drains across successive batches and self-disarms

### REQ-BACKFILL-2: Successive batches cover the whole universe, then disarm

Running `BackfillGrContractsBatch.execute()` repeatedly MUST eventually process every local client exactly
once and then **disarm** (mark the watermark done so further calls are no-ops). The final partial batch MUST
process only the remaining ids (it MUST NOT read past the end of the list).

#### Scenario: Three-client universe drains in two batches then disarms

- GIVEN a local universe `[c1,c2,c3]` (sorted) and `batchSize = 2`, armed at offset 0
- WHEN `execute()` runs a first time
- THEN it processes `[c1, c2]`, watermark offset → 2, `done: false`
- WHEN `execute()` runs a second time
- THEN it processes only `[c3]`, watermark reaches the end, `done: true` (disarmed)
- WHEN `execute()` runs a third time
- THEN it is a no-op: `processed: 0, done: true`, no GR calls, watermark unchanged

#### Scenario: Not-armed backfill is a no-op

- GIVEN the `gr-contracts-backfill` watermark is disarmed (done / no row)
- WHEN `execute()` runs
- THEN it makes no GR calls and returns `processed: 0, done: true`

---

## 3. Resumability across restarts

### REQ-BACKFILL-3: A batch resumes from the persisted watermark after a restart

The backfill MUST be resumable: state lives ONLY in the persisted `gr-contracts-backfill` SyncState, never in
process memory. A fresh `BackfillGrContractsBatch` instance reading the same `SyncStateRepository` MUST
continue from the persisted offset — no client skipped or double-counted across the restart boundary.

#### Scenario: New instance resumes mid-backfill from the watermark

- GIVEN a local universe `[c1,c2,c3,c4]` (sorted), `batchSize = 2`, armed at offset 0
- WHEN a first `BackfillGrContractsBatch` instance runs once (processes `[c1,c2]`, watermark → 2)
- AND a NEW `BackfillGrContractsBatch` instance is constructed over the SAME `SyncStateRepository` (simulating
  a container restart)
- AND that new instance runs `execute()`
- THEN it processes exactly `[c3, c4]` (resumes from offset 2), not `[c1,c2]` again
- AND the watermark reaches the end (`done: true`)

---

## 4. Arming the backfill

### REQ-BACKFILL-ARM-1: Arming sets the watermark to the start

`ArmGrContractsBackfill.execute()` MUST write the `gr-contracts-backfill` SyncState so its offset is 0 and it
is armed (not done), regardless of prior state. It MUST be idempotent (arming twice leaves it armed at 0).

#### Scenario: Arm sets offset 0 / armed

- GIVEN any prior `gr-contracts-backfill` state (done, or mid-offset, or none)
- WHEN `ArmGrContractsBackfill.execute()` runs
- THEN the persisted watermark is armed at offset 0
- AND a subsequent `BackfillGrContractsBatch.execute()` starts from `c1`

---

## 5. Scheduler integration (bounded, after client sync)

### REQ-BACKFILL-SCHED-1: The scheduler runs at most one bounded batch per tick

`GestionRealSyncScheduler.runOnce()` MUST, after the existing client sync and the existing touched-contracts
sync, run **at most one** `BackfillGrContractsBatch` batch when the backfill is armed, and **no** batch when
it is disarmed. It MUST NOT loop the backfill to completion within a single tick (the lock is held seconds,
not hours). The batch error MUST be swallowed like the rest of the cycle so the interval keeps ticking, and
the `gr-sync` lock MUST still be released in `finally`.

#### Scenario: One armed batch runs per tick

- GIVEN the backfill is armed over a universe larger than `batchSize`
- WHEN `runOnce()` executes
- THEN the client sync runs, THEN exactly one bounded backfill batch runs (≤ `batchSize` GR contract calls)
- AND `runOnce()` returns, releasing the lock (it does NOT keep batching until done)

#### Scenario: No batch runs when disarmed

- GIVEN the backfill is disarmed (done / no row)
- WHEN `runOnce()` executes
- THEN no backfill batch GR contract calls are made beyond the normal touched-contracts sync
- AND the run completes and releases the lock as before
