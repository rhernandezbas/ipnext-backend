# Exploration: inventory-foundation (EPIC #38, Wave 1)

> Architectural foundation. The centerpiece is a **unification decision** between two
> parallel inventory worlds that exist in the codebase today. This document maps both
> worlds with file:line evidence and lays out 3 unification strategies with crisp
> tradeoffs. **It does NOT decide** — it gives the human what they need to choose.

---

## 1. The two worlds — full model map

### World A — Generic warehouse CRUD (`empresa` module)
Backed by `EmpresaRepository` (NOT the closure/scheduling pipeline). Routes under `/api/inventory/*`.
FE: 6 pages `/inventory/*` + `src/api/inventory.api.ts` + `useInventory.ts`.

**`InventoryItem`** — `prisma/schema.prisma:1175`
| field | type | notes |
|---|---|---|
| id | String @id uuid | |
| name, category | String | |
| sku, supplier, location | String? | `location` is a **free-text string**, not a FK |
| quantity, minStock | Int @default(0) | bulk count, no per-unit identity |
| unitPrice | Float | |
| status | String @default("in_stock") | |

→ This is a **consumable/bulk** row. No serial, no FK anywhere.

**`InventoryProduct`** (catalog) — `schema.prisma:1188`
| field | type | notes |
|---|---|---|
| id, name, category, sku, description, supplier | | |
| unitPrice | Float | |
| totalStock, minStock | Int | |
| status | String | |
| units | InventoryUnit[] | back-relation |

**`InventoryUnit`** (serialized physical unit) — `schema.prisma:1202`
| field | type | notes |
|---|---|---|
| id | String @id uuid | |
| productId → InventoryProduct | FK | the only FK World A has |
| serialNumber, barcode | String? | |
| status | String @default("available") | available \| assigned \| damaged \| retired (string, not enum) |
| location | String? | **free-text string** — the location gap the epic wants to fix |
| purchaseDate, purchasePrice | | |
| **assignedToClientId** | String? | **NOT a real FK** — plain string, and **never written by any real flow** (see §2) |
| assignedAt, notes | | |

### World B — Task/contract-specific (the LIVE closure pipeline)
Routes: `/api/contracts/:id/inventory` + `/api/scheduling/:taskId/inventory/suggestions`.
FE: `serviceInventory.api.ts` + `useServiceInventory.ts` + task-detail `TaskInventorySuggestions.tsx` + customer-tab `ServiceInventorySection.tsx` + `ContractInventoryReadonly.tsx`.

**`ContractInstalledItem`** (per-contract device roster) — `schema.prisma:805`
| field | type | notes |
|---|---|---|
| id | String @id uuid | |
| **contractId → Contract** | FK, onDelete Cascade | the anchor — inventory hangs off the **contract**, not a client |
| type | String | ONU \| ROUTER \| ANTENA \| REPETIDOR \| OTROS (validated vs `DeviceTypeCatalog`) |
| serialNumber, mac, model | String? | **SINGULAR by design** — 1 row = 1 physical device |
| source | String | OCR \| MANUAL \| ICLASS |
| sourceTaskId | String? | soft link to the task that produced it (NOT a FK constraint) |
| addedByUserId | String? | soft link to actor (NOT a FK) |
| confirmedAt | DateTime? | |
| status | String @default("active") | active \| removed \| replaced |
| replacesItemId → ContractInstalledItem | self-FK, SetNull | replacement chain (`replaces`/`replacedBy`) |
| notes, createdAt, updatedAt | | |
| @@index | contractId, serialNumber, replacesItemId | |

**`MaterialCatalog`** (consumable catalog) — `schema.prisma:540`
| id, name (UPPERCASE @unique), label, unit ("m"\|"unidad"\|"rollo"), active, sortOrder | + `consumptions` back-rel |

**`TaskMaterialConsumption`** (consumption ledger per task) — `schema.prisma:555`
| field | type | notes |
|---|---|---|
| **taskId → ScheduledTask** | FK, Cascade | |
| **materialCatalogId → MaterialCatalog** | FK, Restrict | |
| materialName | String | snapshot at consumption time |
| quantity | Float | |
| unit | String? | |
| recordedByUserId → RbacUser | FK, SetNull | |
| notes, createdAt, updatedAt | | |

→ This is **already a per-task material ledger** — but it **only records consumption, it does NOT decrement any stock** (there is no stock to decrement; World B has no warehouse). EPIC Wave 6 closes exactly this gap.

**`TaskInventorySuggestion`** (staging) — `schema.prisma:782`
| taskId → ScheduledTask (FK, Cascade) · kind (DEVICE\|MATERIAL) · deviceType · qwenDeviceType · serialNumber · mac · materialDesc · quantity · unit · source (OCR\|ICLASS_MATERIAL\|MANUAL) · photoUrl · status (pending\|confirmed\|discarded) · confirmedItemId |

**`DeviceTypeCatalog`** — `schema.prisma:528` — UPPERCASE @unique name + label + active + sortOrder. **This is the model catalog for World B** (validates `ContractInstalledItem.type` and suggestion deviceType). It is the World-B analogue of `InventoryProduct.category` — but the two never reference each other.

### Relationship between the two worlds today: **NONE.**
- No use case touches both. World A use cases (`CreateInventoryUnit`, `ListInventoryUnits`, …, all 12) are backed by `empresaRepo` (`app.ts:772-783`). World B use cases (`ConfirmInventorySuggestion`, `AddInstalledItemManually`, `ListContractInstalledItems`, …) use `ContractInventoryRepository` / `InventorySuggestionRepository`.
- `ConfirmInventorySuggestion` (`ConfirmInventorySuggestion.ts:38-43`) promotes a suggestion → `ContractInstalledItem` (DEVICE) **or** `TaskMaterialConsumption` (MATERIAL). **It never writes an `InventoryUnit`.**
- They never cross-reference. A device installed at a client lives **only** in `ContractInstalledItem`. It does **NOT** appear in `InventoryUnit`.

---

## 2. Who writes/reads each — which world is ALIVE vs STATIC

| | World A (`InventoryUnit/Product/Item`) | World B (`ContractInstalledItem` + consumption) |
|---|---|---|
| **Backing repo** | `EmpresaRepository` | `ContractInventoryRepository`, `InventorySuggestionRepository`, `TaskMaterialConsumptionRepository` |
| **Use cases** | 12 pure CRUD (`*InventoryItem/Unit/Product`) | `BuildInventorySuggestions`, `ConfirmInventorySuggestion`, `AddInstalledItemManually`, `RemoveInstalledItem`, `UpdateInstalledItem`, `CorrectConfirmedDeviceType`, `CreateManualSuggestion`, `List*` |
| **Routes** | `/api/inventory`, `/api/inventory/items`, `/api/inventory/products`, `/api/inventory/supply-orders` | `/api/contracts/:id/inventory`, `/api/scheduling/:taskId/inventory/suggestions*` |
| **FE** | 6 pages `/inventory/*` (Dashboard, Products, Items, Supply, Legacy, Settings) | task-detail suggestions panel, customer "Inventario del cliente" tab, `ContractInventoryReadonly` |
| **Fed by the closure flow?** | **NO** | **YES** — OCR/IClass/scrape → `TaskInventorySuggestion` → confirm → `ContractInstalledItem` |
| **`assignedToClientId` written by any real flow?** | **NO** — only mapped in `PrismaEmpresaRepository`/`InMemoryEmpresaRepository` passthrough; no use case sets it from an install | — |
| **Verdict** | **STATIC CRUD** — seed/manual warehouse data, decoupled from operations. `location` and `assignedToClientId` are free-text/unused. | **ALIVE** — battle-tested through #8/#18/#19; the real operational source of truth for "what's installed at a client". |

**Implication for the epic:** the "live" world (B) is the one the closure/task flow already trusts. World A is essentially a parallel, mostly-dormant warehouse module. The epic's missing piece (StockLocation + InventoryMovement ledger + MaterialStock) is the **warehouse/movement layer that World A gestures at but never implemented**, and that World B has no concept of at all.

---

## 3. Overlap & conflict — the SAME physical device in two tables

- **`InventoryUnit.serialNumber` vs `ContractInstalledItem.serialNumber`**: both model a serialized device by SN. If World A were actually used for "our stock", the same physical router would be `InventoryUnit` (status=available, in warehouse) → installed → `ContractInstalledItem` (status=active, on contract). **Today it would be TWO unlinked rows in two tables with no FK between them.** That is the core duplication risk.
- **`InventoryUnit.assignedToClientId` vs `ContractInstalledItem.contractId`**: both try to express "this device is at customer X" — World A by client, World B by contract. World B (contract-anchored) is the correct granularity (a client can have multiple contracts/services). World A's client-level field is the wrong axis AND unused.
- **Status enums diverge**: World A `available|assigned|damaged|retired`; World B `active|removed|replaced`. They describe **different lifecycles** (warehouse state vs installed state) — which is actually a hint that they're complementary, not competing: a unit has a *warehouse* status and, when installed, an *installation* status.

---

## 4. DeviceTypeCatalog vs InventoryProduct

- **World B**: device "type" = a row in **`DeviceTypeCatalog`** (ONU/ROUTER/…), coarse — a *category*, not a model/SKU. Validates `ContractInstalledItem.type` and the suggestion deviceType.
- **World A**: device "model" = **`InventoryProduct`** (name + SKU + supplier + unitPrice), finer — an actual product/SKU with stock counts.
- **No relationship today.** They are at different altitudes: `DeviceTypeCatalog` ≈ *kind of device*, `InventoryProduct` ≈ *specific model with price/stock*. A unified model would likely keep BOTH and relate them (`InventoryProduct.deviceTypeId → DeviceTypeCatalog`), OR collapse `DeviceTypeCatalog` into a product taxonomy. This is a secondary decision that falls out of the main unification choice.

---

## 5. Core FK targets for the new ledger (exact PKs/types)

All PKs are `String @id @default(uuid())`. The new `StockLocation` + `InventoryMovement` would FK into:

| Target | PK | Evidence | Notes |
|---|---|---|---|
| `ScheduledTask` | String uuid | `schema.prisma:877` | the work-order anchor for movements (`taskId?`) |
| `RbacUser` (= técnico) | String uuid | `schema.prisma:1688` | technician = `ScheduledTask.assigneeId → RbacUser` (`:909`). `recordedByUserId` already FKs RbacUser in `TaskMaterialConsumption`. |
| `Client` | String uuid | `schema.prisma:171` | |
| `Contract` | String uuid | `schema.prisma:208` | **World B anchors on Contract, not Client** — the CLIENTE location should likely FK Contract for parity with `ContractInstalledItem` |
| `NetworkSite` | String uuid | `schema.prisma:1260` | nodes/sites; has `iclassNodeCode`, self-hierarchy. Could be a location type (NODO). |
| **Vehicle / truck / team** | — | — | **DOES NOT EXIST.** No `Vehicle`/`Camioneta`/`Truck`/`Team`/`Cuadrilla` model anywhere (grep: no matches). IClass has teams/vehicles but they are **NOT mirrored** in this DB. → Wave 1 can defer CAMIONETA (use TECNICO-as-location) per the backlog note, or introduce a thin `Vehicle` model. |
| `StockLocation`, `InventoryMovement`, `MaterialStock` | — | — | **None exist yet** (grep confirms). All three are net-new. |

---

## 6. IClass equipment events — fetched-but-unused (the Wave 4 fuel)

**Entity shape** — `IClassSoEquipmentEvent` (`schema.prisma:748`):
`serviceOrderId → IClassServiceOrder (FK Cascade)` · `occurredAt: DateTime?` · `type: String?` (**install | remove | move**) · `serialNumber: String?` · `mac: String?` · `patrimonialNo: String?` · `modelDescription: String?`.

**Domain port**: `IClassPort.getServiceOrderEquipmentEvents(iclassId): Promise<SoEquipmentEvent[]>` (`IClassPort.ts:100`); adapter `IClassClient.ts:221`; in-memory `InMemoryIClassClient.ts:98`.

**Where fetched**: `IngestClosedServiceOrders.ts:202` — `const equipmentEvents = await this.iclass.getServiceOrderEquipmentEvents(s.iclassId);` → stored on the `ClosedServiceOrder` (`:229`) → persisted by `PrismaClosedServiceOrderRepository.ts:149-151`.

**The gap**: today these events feed **ONLY the AI auditor context** (`buildAuditContext.ts:60`, capped at `EQUIPMENT_EVENTS_MAX`) — they are captured & mirrored but **never drive inventory**. This is the exact hook Wave 4 plugs into:
- `type='install'` → unit moves to client → `InventoryMovement(INSTALL)` + a `ContractInstalledItem` (already happens via OCR/confirm; install events would be a 2nd source) + `InventoryUnit.currentLocationId = CLIENTE`.
- `type='remove'` → **unit returns to warehouse** → `InventoryMovement(RETURN)`, unit back to `available`, +1 in our stock (the user's headline ask).
- `type='move'` → `InventoryMovement(TRANSFER)`.

A movement built from an equipment event would carry `taskId` (the closed SO's task), `serialNumber`/`mac` (to resolve the unit), and `occurredAt`.

---

## 7. Migration surface

- **World A tables** (`InventoryItem`/`Product`/`Unit`): probably **sparse** — they are static CRUD with no live writer; likely seed/demo data only. ⚠️ **Cannot query prod from here — the orchestrator MUST check prod row counts** for `InventoryItem`, `InventoryProduct`, `InventoryUnit` before choosing a strategy. If near-empty, deprecating/replacing World A is cheap.
- **World B tables** (`ContractInstalledItem`, `TaskMaterialConsumption`, `TaskInventorySuggestion`): **alive, with real prod data** from #8/#19 operations. **Must not break.** Any strategy must preserve `ContractInstalledItem` as-is or migrate it losslessly.
- **What breaks if we pick a source of truth**:
  - Make World A the truth → must backfill `InventoryUnit` from every `ContractInstalledItem` AND rewire the closure confirm flow to write units. High blast radius on the live path.
  - Make World B the truth → World A's 6 FE pages need a backing model; `InventoryProduct`/`Unit` either get deprecated or re-pointed. Lower blast radius on the live path (B stays).
  - Net-new core → both migrate in; biggest one-time migration but cleanest end state.

---

## Unification Strategies (tradeoffs — the human chooses)

### Strategy 1 — Unit-centric (`InventoryUnit` becomes the single source of truth for serialized equipment)
`InventoryUnit` is THE serialized-equipment table. `ContractInstalledItem` becomes a **derived projection** (a view, or a movement-derived read model) of "units currently at location=CLIENTE". `StockLocation` + `InventoryMovement` + `InventoryUnit.currentLocationId` layer on top of `InventoryUnit`. World B materials (`MaterialCatalog` + `TaskMaterialConsumption`) stay; `MaterialStock` attaches to `MaterialCatalog`.
- **Source of truth**: `InventoryUnit`.
- **Migrates**: every `ContractInstalledItem` → an `InventoryUnit` (create unit if SN not present, set `currentLocationId` = that contract's CLIENTE location). Rewire `ConfirmInventorySuggestion` to upsert a unit + emit an INSTALL movement instead of writing `ContractInstalledItem` directly.
- **FE impact**: the 6 `/inventory/*` pages **become primary** and gain real data. World B's customer "Inventario del cliente" tab re-points to the unit projection. Highest FE churn on the live task panels.
- **Ledger attach**: clean — `InventoryUnit.currentLocationId → StockLocation`; movements reference `unitId`.
- **Migration risk**: **HIGH** — rewrites the battle-tested closure confirm path (#18/#19) and migrates live prod data; `ContractInstalledItem`'s replacement-chain + source/sourceTaskId semantics must be reconstructed as movements.
- **Effort**: **High.**

### Strategy 2 — Bridge / coexist (keep both, add a linking FK)
Keep `ContractInstalledItem` as the per-client roster (unchanged, low risk). Add `ContractInstalledItem.inventoryUnitId → InventoryUnit?` (nullable FK). Layer `StockLocation` + `InventoryMovement` + `currentLocationId` over `InventoryUnit`. When a unit is installed, link the two rows; the roster stays the operational read model, the unit carries warehouse/ledger state.
- **Source of truth**: split — `ContractInstalledItem` for "installed at client", `InventoryUnit` for "our stock + location history". Linked by FK.
- **Migrates**: minimal — add nullable FK, backfill best-effort by SN match (`ContractInstalledItem.serialNumber ↔ InventoryUnit.serialNumber`); unmatched rows just have `inventoryUnitId = null`.
- **FE impact**: **lowest** — both UIs keep working. The 6 pages and the task panels are untouched for v1; the ledger/locations are additive.
- **Ledger attach**: over `InventoryUnit`; `ContractInstalledItem` reads through the link when it needs location.
- **Migration risk**: **LOW** — purely additive; nothing on the live path is rewritten. Downside: **two source-of-truth tables persist** → drift risk (the very problem the epic flags), the SN-match backfill is fuzzy, and "one device, two rows" is enshrined rather than resolved.
- **Effort**: **Low–Medium.**

### Strategy 3 — Fresh unified core (new `InventoryAsset` + `MaterialStock` + `StockLocation` + `InventoryMovement`)
Introduce a clean serialized model **`InventoryAsset`** (SN/MAC/model/deviceTypeId/currentLocationId/status) as the single source of truth for serialized equipment, plus `MaterialStock` for consumables, `StockLocation`, and the `InventoryMovement` ledger. **Both** old worlds migrate in: `InventoryUnit` rows → assets; `ContractInstalledItem` rows → assets at CLIENTE locations (+ an INSTALL movement). `ContractInstalledItem` is deprecated (or kept briefly as a compat read view); World A's `InventoryUnit`/`Product`/`Item` are deprecated. `DeviceTypeCatalog` stays as the asset taxonomy.
- **Source of truth**: new `InventoryAsset` (serialized) + `MaterialStock` (consumable).
- **Migrates**: BOTH worlds — biggest one-time migration; needs a dedup pass where `InventoryUnit.serialNumber == ContractInstalledItem.serialNumber` (collapse to one asset).
- **FE impact**: **highest eventually** — the 6 pages AND the task panels re-point to the new model. Can be staged (compat views first), but the end state rewrites both.
- **Ledger attach**: cleanest — the ledger is native; current stock derives from movements or materializes in `MaterialStock`/`InventoryAsset.currentLocationId`.
- **Migration risk**: **Medium–High** — large migration but a single coherent target; no enshrined duplication. Risk is concentrated in one well-scoped migration rather than smeared across the live path.
- **Effort**: **High** (but pays down all future waves; Waves 2–7 build on one model).

### Recommendation (default — human decides)
**Strategy 2 (Bridge) for Wave 1 as the low-risk foundation, with an explicit intent to converge toward Strategy 3.** Rationale: Wave 1's mandate is to introduce `StockLocation` + `InventoryMovement` + `MaterialStock` + `currentLocationId` **without breaking the live closure flow**. Bridge lets the ledger + locations land additively over `InventoryUnit` while `ContractInstalledItem` keeps powering the operational UI — zero rewrite of the #18/#19 path. The `inventoryUnitId` FK is the seam that later lets Strategy 3 collapse the duplication once prod row counts and behavior are understood.

**BUT** this hinges on prod data: **if World A's `InventoryUnit`/`Product`/`Item` are near-empty (likely)**, Strategy 3 becomes far more attractive — there's almost nothing to migrate from World A, so building one clean `InventoryAsset` core and migrating only `ContractInstalledItem` into it avoids enshrining the two-table duplication that Strategy 2 accepts. **The choice between 2 and 3 should be made AFTER the orchestrator checks prod row counts** (§7). Strategy 1 is the least attractive: highest live-path risk for no structural advantage over 3.

### Key open questions for the human
1. **Prod row counts** for `InventoryUnit` / `InventoryProduct` / `InventoryItem` (World A) and `ContractInstalledItem` (World B)? This flips the 2-vs-3 recommendation. (Orchestrator must query prod.)
2. **Anchor for CLIENTE location: `Contract` or `Client`?** World B uses Contract; World A's unused field uses Client. Contract is recommended (parity), confirm.
3. **CAMIONETA in Wave 1 or deferred?** Backlog allows TECNICO-as-location for v1, `Vehicle` later. Confirm the v1 cut.
4. **Are the 6 `/inventory/*` FE pages keepers or replaceable?** If they're demo scaffolding (World A static), Strategy 3 can rebuild them cleanly; if they're relied upon, Strategy 2's "don't touch them" wins.
5. **IClass direction in this epic: read-only (consume events) or bidirectional (push moves)?** Wave 1 is read-model only, but the `StockLocation`/movement shape should anticipate the answer.

---

## Affected Areas (Wave 1)
- `prisma/schema.prisma` — new `StockLocation`, `InventoryMovement`, `MaterialStock` models; `InventoryUnit.currentLocationId` (and, if Strategy 2, `ContractInstalledItem.inventoryUnitId`). New migration with FKs.
- `src/domain/entities/` + `src/domain/ports/` — new entities + repository ports for location/movement/stock.
- `src/application/use-cases/` — movement-recording use case + stock-derivation/query use cases.
- `src/infrastructure/adapters/prisma/` + `in-memory/` — new repos (Prisma + in-memory per TDD convention).
- `src/application/use-cases/IngestClosedServiceOrders.ts` (~202) — *Wave 4*, not Wave 1: where equipment events would start feeding the ledger.
- FE: none new in Wave 1 (or minimal) per the backlog ("Sin UI nueva todavía").

## Risks
- Rewriting the battle-tested #18/#19 closure confirm path (Strategy 1, and partially 3) on live prod data.
- "One device, two rows" drift if Strategy 2 is chosen and never converged (the exact problem the epic flags).
- Fuzzy SN-based backfill matching `InventoryUnit ↔ ContractInstalledItem` (Strategies 2 & 3).
- No `Vehicle` model → CAMIONETA stock needs a decision before Wave 5; Wave 1 should leave room.
- Stock derivation strategy (derive-from-ledger vs materialized `MaterialStock`/`currentLocationId`) must be fixed in design — mixing them causes drift.

## Ready for Proposal
**Yes — with one gate.** The model map is complete and the strategies are crisp, BUT the 2-vs-3 recommendation is contingent on prod row counts (open question #1). The orchestrator should surface row counts to the human, let them pick the strategy + answer questions 2–5, then proceed to `propose`.
