# Exploration: inventory-iclass-events (EPIC #38, Wave 4)

> **HIGH-RISK** — stock mutation from external/closure signals. Idempotency is make-or-break.
> **HEADLINE FINDING: the premise is false.** IClass exposes NO equipment events for IPNEXT.
> W4 must be re-scoped around a *closure-detected RETIRO* + the existing OCR device identity,
> NOT around consuming `IClassSoEquipmentEvent` rows.

---

## 1. THE INVESTIGATION: why is `IClassSoEquipmentEvent` empty in prod? (RESOLVED — live-probed)

**Answer: NOT a bug. IClass itself returns zero equipment data for IPNEXT.** The persistence path
works correctly; there is simply nothing to persist.

### Data path (traced end-to-end, all correct)
1. `IngestClosedServiceOrders.processSummary` (`:202`) calls `iclass.getServiceOrderEquipmentEvents(s.iclassId)`.
2. `IClassClient.getServiceOrderEquipmentEvents` (`:221`) → `GET /serviceorders/{id}/equipments/history` via `fetchAllPages`, maps with `parseEquipmentEvent` (`:571`).
3. The result is assembled into `order.equipmentEvents` (`:230`) and passed to `closed.upsert(order, task.id)` (`:232`).
4. `PrismaClosedServiceOrderRepository.upsert` **does** persist them: `tx.iClassSoEquipmentEvent.createMany(...)` when `order.equipmentEvents.length` (`:149-160`). Read-back includes them (`:172`, `:253`).
5. They are read by **exactly one consumer**: the AI auditor — `buildAuditContext.ts:60` slices them into the audit prompt. **`BuildInventorySuggestions` does NOT consume them at all** (only `extractions` (OCR) + `materials`).

So today equipment events are **fetch → persist → audit-only**. They never touch inventory. They are empty because the upstream returns nothing.

### Live probe (api-v2.iclass.com.br, cluster `IPNEXT INTERNET`, thirdParty `6808841`, 2026-06-09)
Tested 12 recently-closed (status `7`) SOs + the global catalog:

| Endpoint | Result |
|----------|--------|
| `/serviceorders/{id}/equipments/history` | **HTTP 204** (empty) for all 12 SOs |
| `/serviceorders/{id}/equipments` | **204** |
| `/serviceorders/{id}/materials` | **204** (materials ALSO empty!) |
| `/serviceorders/{id}/adresses/equipments` | **204** |
| `/equipments` (global catalog, no filter / clusterName / thirdPartyCode) | **204 — the entire Equipments module is empty** |

Embedded SO-summary fields `equipamento` / `tipoEquipamento` are `{}`; `ativos` / `historicoAtivos` / `materiais` are just URL pointers to those same 204 endpoints.

**Conclusion**: IPNEXT field technicians do **not** use IClass's Equipments or Materials modules. There is **no structured equipment-event source in IClass**, and no evidence one will ever appear. `fetchAllPages` correctly treats 204 as `[]` (`:287`), which flows through as an empty list — no bug.

---

## 2. THE SIGNAL THAT *DOES* EXIST (the pivot)

The removal intent is **not** lost — it lives on the SO summary itself, which we already mirror:

- **SO type** `RETIROS DE EQUIPOS` (`tipoOs.descricao`) — 5 of 60 SOs in a 25-day window were removals.
- **Result code** (`motivoFechamento.descricao`) e.g. `Retiro completo Servicio Wireless`, `Cambio de Antena`, `Cambio de Cableado` — confirms a *completed* removal/replacement.
- **Device identity** comes from the **closure checklist photos**, already OCR'd by #19 (`ExtractDeviceInfoFromPhoto` → serialNumber/mac) for installs. A RETIROS SO's photos are the same channel.

So the W4 trigger is a **closure-detected RETIRO** (by SO-type / result-code), and the device to return is matched by **serialNumber/mac** against an existing `InventoryAsset` (the W1 ledger already stores 56 migrated installed assets, `findBySerialNumber` exists).

### Event shape (`SoEquipmentEvent`) — reliability
`type` (install|remove|move) maps from `raw.tipo`. **Unverifiable** — we have zero live samples (the endpoint is always 204). Treat the *table* as unusable. The reliable discriminator is the **SO type / result-code name** on the mirror, not the event `type`. Matching key: **serialNumber** primary, **mac** fallback (both already on the asset; checklist OCR yields both).

---

## 3. W1 FOUNDATION FIT (the good news)

The user's KEY requirement — *a RETIRO returns the asset to OUR depot as available stock* — maps **exactly** onto primitives already shipped in W1:

- `RecordInventoryMovement.execute({ type: 'RETURN', assetId, fromLocationId: clienteLoc, toLocationId: depot })`
- `computeAssetEffect` for `RETURN` → `{ currentLocationId: depot, status: 'available' }` (`inventory-asset-effect.ts:31`).
- `installed → available` is a **legal** transition (`inventory-asset.ts:19`).
- `ResolveDepotLocation` resolves/creates the `DEPOSITO` singleton (idempotent, P2002-safe).
- `GetDepotStock` (W3) already surfaces `status==='available'` assets at the depot — the returned device shows up in depot stock automatically. **No new read model needed.**
- `UnitOfWork` makes the multi-write (asset status + movement + balance) atomic.

`RecordInventoryMovement` + `ResolveDepotLocation` were explicitly shipped in W1 as *unwired primitives waiting for exactly this wave*. W4 is their first real caller.

---

## 4. INSTALL DOUBLE-COUNTING — reconciled (no overlap)

There is **no double-counting risk for installs**, because the only install source is #19's
`ConfirmInventorySuggestion` (OCR → operator confirm → `INSTALL` movement). IClass equipment
events that would have been a *second* install source **do not exist**. Therefore:

- **W4 should NOT create INSTALL movements at all.** Installs stay owned by #19.
- W4 is **removal-only** (`RETURN` to depot) + optionally `move`/replace (`TRANSFER`/retire-then-install, but `move` events are also absent → out of scope).

This eliminates the trickiest design question in the original brief: install reconciliation is moot.

---

## 5. IDEMPOTENCY (the make-or-break) — options

A re-closure (the closure loop re-fires side-effects on re-mirror) must NOT return the same asset
twice. The existing closure pipeline already solves this for its other side-effects with **per-SO
boolean flags** on the mirror (`commentPosted`, `inventoryBuilt`, `auditDone` in `getSideEffectState`/`markSideEffect`).

| Option | How | Pros | Cons |
|--------|-----|------|------|
| **A. Per-SO flag `inventoryReturnsProcessed`** (mirrors `inventoryBuilt`) | New boolean column on `IClassServiceOrder`; the return side-effect runs only when false, set true on success | Matches the established pattern exactly; cheapest; reviewer-familiar | Coarse — if a 2nd device is added to the same SO later it won't re-process (acceptable: closures are terminal) |
| **B. Natural unique key on the movement** | Add `sourceRef` (e.g. `iclass:{soId}:{serial}:RETURN`) + `@@unique` on `InventoryMovement`; the RETURN insert is a no-op on conflict | Truly idempotent at the ledger grain; survives partial re-processing | Schema change to the hot ledger table; needs a deliberate "ignore duplicate" path (the ledger is currently append-only with no upsert); more code |
| **C. State-guard (no marker)** | Before RETURN, check `asset.status==='installed' && currentLocationId===clienteLoc`; skip if already `available`@depot | Zero new schema | Not idempotent across *different* assets on the SO; race-prone; conflates "already returned" with "manually returned elsewhere" |

**Recommendation: A as the primary gate, B as defense-in-depth for the semi-auto path.**
A alone matches the pipeline and ships fastest. If we also persist a pending "return suggestion"
(semi-auto), give *that* row the natural key so an operator can't confirm the same return twice.
Pure-A is sufficient for auto-mode MVP; add B only if reviewers demand ledger-grain idempotency
(this is the HIGH-RISK knob — flag for the human).

---

## 6. ASSET-NOT-FOUND (a remove whose serial matches no asset)

Common: the device was installed before our system, or by a flow that never confirmed an asset.
Options:

| Option | Behavior | Tradeoff |
|--------|----------|----------|
| **Skip + log** | No movement; count `skippedNoAsset` | Safe, zero stock corruption; but the depot never gains the returned unit |
| **Create-at-depot** | Synthesize `InventoryAsset(status='available', location=DEPOSITO, source='ICLASS_RETIRO')` then it's already "returned" | Depot count is correct; but invents an asset from a name we can't fully trust (serial may be an OCR misread) |
| **Stage for review** | Persist a pending "return suggestion" the operator confirms (reuse the `TaskInventorySuggestion` confirm pattern) | Safest for HIGH-RISK; operator decides create-vs-link; more build (FE) |

**Recommendation: Skip+log in AUTO mode; Stage-for-review in SEMI-AUTO mode.** Never silently
create an asset from an unverified external removal in auto mode (that's how phantom stock appears).

---

## 7. AUTO vs SEMI-AUTO (the user wants both, configurable like the closure flags)

- **AUTO**: during `runClosureSideEffects`, when the SO is a RETIRO and a device matches by serial → `RecordInventoryMovement(RETURN→depot)` immediately, gated by the per-SO flag (Option A). Asset-not-found → skip+log.
- **SEMI-AUTO**: stage a **pending return** (new lightweight suggestion, `kind='RETURN'` or a sibling `TaskReturnSuggestion`) the operator confirms on the existing per-task closure review surface. Confirmation fires the same `RETURN` movement. Reuses #19's confirm UX and the `closureHasDeviceInventory`-style task flag.

Toggle via a `FeatureFlag` row (the project already gates iclass side-effects with flags like `iclass-audit`) or an `IngestClosedOptions` opt-in dep (like `buildSuggestions`/`auditInstallation`). **Recommend a feature flag** (`iclass-inventory-returns` = off | auto | semi) so ops can flip modes without redeploy, consistent with the existing closure-effect gating.

---

## 8. PERSISTING `IClassSoEquipmentEvent`? — NO

Since the source is permanently empty, **do NOT invest in persisting equipment events.** The W4
trigger is the **SO type + result code** (already mirrored on `IClassServiceOrder`) and the
**OCR'd checklist device** (already staged by #19). Consume those inline during closure. Leave the
`IClassSoEquipmentEvent` table as-is (harmless; the auditor still reads it if it ever populates).

---

## Affected Areas

- `src/application/use-cases/IngestClosedServiceOrders.ts` — add a `processInventoryReturns` side-effect inside `runClosureSideEffects`, gated by a new flag; new optional dep + per-SO marker.
- `src/application/use-cases/` — NEW `ReturnAssetToDepot.ts` (wraps `ResolveDepotLocation` + `findBySerialNumber` + `RecordInventoryMovement(RETURN)` in a `UnitOfWork`). Optional NEW `ConfirmAssetReturn.ts` for semi-auto.
- `src/domain/ports/ClosedServiceOrderRepository.ts` + `PrismaClosedServiceOrderRepository` + in-memory — add `inventoryReturnsProcessed` flag (Option A).
- `prisma/schema.prisma` + migration — new boolean column on `IClassServiceOrder` (Option A); optionally `sourceRef` + `@@unique` on `InventoryMovement` (Option B). **Migration required.**
- `src/infrastructure/http/routes/iclass-closure.routes.ts` / `serviceInventory.routes.ts` — semi-auto: list + confirm pending returns (small FE).
- Result-code / SO-type detection: reuse `resolveResultCode` + the mirrored `soTypeId`/`resultCodeName`; needs a config of which types/codes mean "removal" (operator-mappable, like the stage mapping).
- FE (`ipnext-frontend`) — semi-auto only: a per-task/closure "returns to confirm" panel (reuse the inventory-suggestion card pattern).

---

## Approaches (overall scope)

1. **Auto-only RETURN, flag-gated, per-SO marker (Option A idempotency)** — closure detects RETIRO by type/code, matches device by serial, fires `RETURN→depot`. Asset-not-found → skip+log.
   - Pros: smallest; reuses ALL W1 primitives; no FE; idempotency by the established flag pattern; install double-count is a non-issue.
   - Cons: silent on unmatched serials; auto stock mutation from a name we don't 100% trust (mitigated: only `installed` assets matched by serial are touched).
   - Effort: **Medium** (BE-only + 1 migration).

2. **Auto + Semi-auto, flag selects mode** — adds a pending-return staging + operator confirm (reuse #19 confirm UX) + ledger-grain idempotency (Option B) for the staged row.
   - Pros: operator control on the HIGH-RISK mutation; handles asset-not-found gracefully (review); both modes the user asked for.
   - Cons: more build (new suggestion entity/route + small FE); two code paths.
   - Effort: **High** (BE + FE + migration).

3. **Detect-only / report (no mutation yet)** — flag a task/SO as "is a retiro, device X" but require fully-manual depot return via the existing W2/W3 inventory UI.
   - Pros: zero auto stock risk; ships as a stepping stone.
   - Cons: doesn't satisfy the user's "should mark it back in inventory" automatically; punts the actual movement.
   - Effort: **Low**.

---

## Recommendation

**Ship Approach 1 (auto-only, flag-gated) as the W4 MVP, architected so Approach 2 (semi-auto) is an additive second step.**

- The trigger is **operator-configurable removal SO-types/result-codes** (a small mapping table, like the existing result-code→stage mapping), NOT the dead equipment-event `type`.
- RETURN movement reuses W1 verbatim; the returned asset appears in `GetDepotStock` for free.
- **No INSTALL in W4** — installs stay owned by #19, so there is zero double-counting.
- **Idempotency: Option A** (per-SO `inventoryReturnsProcessed` flag) primary; design the schema so Option B (`sourceRef` unique on movement) can be added if reviewers require ledger-grain safety. **This is the single make-or-break decision — escalate to the human.**
- **Asset-not-found: skip+log in auto.** Do not auto-invent assets from external removals.
- Default the feature flag **OFF** in prod; enable per-tenant after a dry-run, mirroring how W1 was shipped (rolled-back prod dry-run before deploy).

---

## Risks

- **HIGH — auto stock mutation from a fuzzy trigger.** A RETIRO SO whose result code is `Cliente Ausente.` (no actual removal happened) must NOT return the asset. The removal must be gated on a **completed-removal result code**, not merely the SO type. Mapping table must distinguish "retiro completo" from "retiro fallido / cliente ausente".
- **HIGH — idempotency.** Re-closure re-fires side-effects; without Option A's flag (and ideally Option B's key) a re-mirror double-returns. The W1 ledger has NO natural key today — confirmed gap. This is the make-or-break.
- **MEDIUM — serial match quality.** Device identity comes from OCR; a misread serial returns the *wrong* asset (relocating someone else's device to depot). Mitigate: match only `status==='installed'` assets, and (semi-auto) require operator confirm.
- **MEDIUM — the source is empty TODAY but the brief assumed events.** Stakeholders must accept the pivot: W4 is "closure-detected returns", not "consume IClass events". If they instead want IClass's equipment module *populated upstream*, that is an IClass-config/process change outside this codebase.
- **LOW — `IClassSoEquipmentEvent` table stays unused.** Harmless; leave it.

---

## Ready for Proposal

**Yes — with one blocking human decision.** The investigation conclusively reframes the wave
(no IClass events exist). Before proposing, the human must confirm:
1. Accept the pivot to **closure-detected RETIRO** (SO-type + completed-removal result code) as the trigger.
2. Pick the MVP scope: **Approach 1 (auto-only)** vs **Approach 2 (auto + semi-auto)**.
3. Approve **idempotency = Option A** (per-SO flag), with Option B (ledger natural key) as optional hardening.
4. Confirm **asset-not-found = skip+log** (auto) is acceptable for MVP.
