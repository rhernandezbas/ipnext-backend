# Proposal: "Quitar con destino" — trazabilidad de retiro de equipos (Cambio B)

## Intent

Cuando un operador **quita** un equipo de un contrato, pedir en un **modal obligatorio el DESTINO** del equipo (Depósito / Con técnico [cuál] / Se lo queda el cliente / Dañado-baja) y **rutear el `InventoryAsset`** a la `StockLocation` + estado correctos, registrando el **movimiento en el ledger**. Hoy "Quitar" solo hace soft-delete (`status='removed'`) y deja el activo **huérfano** (`installed` en el cliente, sin movimiento, sin rastro de a dónde fue). Cero trazabilidad.

## Why

- `RemoveInstalledItem` (`src/application/use-cases/RemoveInstalledItem.ts:1-21`) solo pone `status='removed'` en el `ContractInstalledItem` — **no toca el activo, no registra movimiento, no captura destino**. El activo queda `installed` en la `CLIENTE` location aunque el equipo ya no esté ahí.
- La Inventory Foundation (W1) **ya modela** dónde vive cada activo (`StockLocation`: DEPOSITO/CLIENTE/TECNICO/CAMIONETA) y el **ledger** (`InventoryMovement`) con su historial. El "Quitar" simplemente no lo usa.
- Decisión del usuario: el destino es **OBLIGATORIO** (sin destino no hay trazabilidad) y **todo equipo es nuestro** → todo retiro mueve un activo real.
- Es el complemento natural del Cambio A: A cableó el **alta** al W1; B cablea el **retiro**.

## Scope

### In Scope

**Backend:**
- **Use case `RetireInstalledItem`** (contract-scoped) que, atómicamente (`UnitOfWork`):
  1. Valida el item (pertenece al contrato, está `active`).
  2. Pone el CII `status='removed'`.
  3. Si tiene `assetId`, rutea el activo por **disposition** (todas las transiciones salen de `installed`, todas legales):

  | disposition | activo → estado | ubicación destino | movimiento | extra |
  |-------------|-----------------|-------------------|------------|-------|
  | `DEPOSITO`  | `available` | DEPOSITO (ResolveDepotLocation) | `RETURN` | — |
  | `TECNICO`   | `available` | TECNICO(technicianId) (ResolveTechnicianLocation) | `TRANSFER` (CLIENTE→TECNICO) | `technicianId` requerido |
  | `CLIENTE`   | `retired`   | CLIENTE (queda donde está) | `ADJUST` (status=retired) | sale de nuestro inventario (lo posee el cliente) |
  | `DAMAGED`   | `damaged`   | DEPOSITO | `ADJUST` (status=damaged) | vuelve roto al depósito (recuperable a baja después) |
  | `RETIRED`   | `retired`   | DEPOSITO | `ADJUST` (status=retired) | baja definitiva (fuera de servicio) |

  4. El **`note`** opcional (texto libre) viaja en el movimiento (`InventoryMovement.note` ya existe — **sin migración**).
  5. Si el item NO tiene `assetId` (legacy sin activo) → solo soft-delete del CII (no hay activo que rutear).
- **Endpoint** `POST /contracts/:contractId/inventory/:itemId/retire` (perm `inventory.write`), body `{ disposition, technicianId?, note? }` (zod; `technicianId` requerido sii `disposition='TECNICO'`). Devuelve el item retirado.
- **Path nuevo CLIENTE→TECNICO**: hoy `IssueStockToTechnician` solo hace DEPOSITO→TECNICO. El retiro a técnico mueve directo CLIENTE→TECNICO (no pasa por depósito). Se reusa `ResolveTechnicianLocation` + el patrón de movimiento.

**Frontend (`ipnext-frontend`):**
- El botón **"Quitar"** (`ServiceInventorySection.tsx`) pasa del `confirm` simple a un **modal de destino** (obligatorio): 4 opciones + **picker de técnico** (cuando "Con técnico", vía `GET /inventory/technicians` que ya existe → `[{id,name,assetCount}]`) + **nota opcional**. Llama al endpoint nuevo. Skill `ui-ux-pro-max`.

### Out of Scope
- **NO migración** (se reusa `InventoryMovement.note`; no se agrega columna).
- El `RetireContractEquipment` task-scoped existente (con su flag de proyecto + sourceRef) queda como está — B es contract-scoped y reusa el PATRÓN, no ese use case.
- Backfill de activos para items legacy sin `assetId` (los que A no tocó) — fuera de alcance.
- Vehículo (CAMIONETA) como destino — no pedido; se puede sumar después (el patrón queda listo).

## Capabilities
### New: ninguna net-new (reusa `inventory-asset`). 
### Modified: `contract-inventory` (camino de **retiro**).

## Approach
1. **Servicio compartido de routing de activo** (`RouteAssetToDisposition` o método en un servicio) que, dado `(assetId, disposition, contractId, technicianId?, note?)`, hace la transición + ubicación + movimiento dentro del bag tx-scoped. Reusa `ResolveDepotLocation`/`ResolveTechnicianLocation`/`ResolveClientLocation` + `nextStatus`.
2. **`RetireInstalledItem`** (TDD): orquesta validación + soft-delete + routing, todo en `runUnit`.
3. **Wiring**: nuevo endpoint POST retire; el FE migra "Quitar" a él. El DELETE viejo (`RemoveInstalledItem`) queda (sin uso desde el FE) o se deprecia.
4. **FE** (TDD Vitest): modal de destino + picker + nota.

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/application/use-cases/RetireInstalledItem.ts` | New |
| `src/application/services/RouteAssetToDisposition.ts` | New (routing del activo por disposition) |
| `src/domain/errors/inventory.ts` | + `InvalidDispositionError` / `TechnicianRequiredError` |
| `src/infrastructure/http/routes/contractInventory.routes.ts` | + `POST /:itemId/retire` (zod) |
| `src/infrastructure/http/app.ts` | wiring del use case (deps W1) |
| `src/__tests__/...` | TDD: 4 dispositions + técnico-requerido + legacy-sin-asset + atomicidad + composition-root |
| `ipnext-frontend` (ServiceInventorySection + modal + api) | modal de destino + picker técnicos + nota |

## Risks

| Riesgo | Mitigación |
|--------|-----------|
| CLIENTE→TECNICO es un path nuevo (no había mov. desde CLIENTE a TECNICO) | Test explícito; reusa `ResolveTechnicianLocation`; transición installed→available legal |
| Olvidar la atomicidad (CII removed sin mover el activo, o al revés) | Todo en `runUnit`/UoW; test de rollback |
| `technicianId` inválido / técnico sin location | `ResolveTechnicianLocation` hace find-or-create; validar que el técnico exista (RbacUser activo) |
| Item legacy sin `assetId` | Branch explícito: solo soft-delete, sin routing (test) |
| Contrato BE↔FE del nuevo endpoint | Contrato explícito campo por campo en ambos prompts + test del seam |

## Rollback
Aditivo (nuevo use case + endpoint; sin cambio de schema). Rollback = `git revert`. El FE puede volver al DELETE viejo. Sin migración → sin drift.

## Dependencies
- Inventory Foundation (W1): `InventoryAsset`, `StockLocation`, `InventoryMovement`, `Resolve{Depot,Technician,Client}Location`, `ListTechniciansWithStock`, `UnitOfWork`. ✅ todo existe.
- Cambio A en prod (los activos del contrato ya existen / se crean en el alta). ✅

## Success Criteria
- [ ] "Quitar" con destino **Depósito** → CII `removed` + activo `available`@DEPOSITO + movimiento `RETURN`.
- [ ] **Con técnico** (elegido) → activo `available`@TECNICO(téc) + movimiento `TRANSFER` con `technicianId`.
- [ ] **Se lo queda el cliente** → activo `retired`@CLIENTE + movimiento `ADJUST`.
- [ ] **Dañado** → activo `damaged`@DEPOSITO + movimiento `ADJUST`.
- [ ] **Baja definitiva** → activo `retired`@DEPOSITO + movimiento `ADJUST`.
- [ ] Destino **obligatorio** (sin disposition → 400); `technicianId` requerido sii TECNICO.
- [ ] `note` opcional persistido en el movimiento.
- [ ] Item legacy sin `assetId` → solo soft-delete (no rompe).
- [ ] Atómico (rollback si falla cualquier paso).
- [ ] `tsc` 0 + `npm test` verde (BE) · `typecheck` + `vitest` verde (FE).
- [ ] Review adversarial CLEAN. DIP preservado. Composition-root test del wiring.
