# Design: PPPoE ↔ Contract Integrity

## Context

3 bugs sobre el invariante "0 o 1 PPPoE activo por contrato". Causas raíz confirmadas en el código (explore). Este design fija las decisiones.

## Decisión 1 — Guard de unicidad (#4)

`AssociatePppoeToContract` y `CreatePppoeService` solo chequean "¿este PPPoE está tomado?", no "¿el contrato ya tiene uno?". El método `PppoeServiceRepository.findByContract(contractId)` YA existe.

**Nuevo error** en `domain/errors/pppoe.ts`:
```ts
export class PppoeContractAlreadyHasServiceError extends DomainError {
  constructor(public readonly contractId: string, public readonly existingPppoeId: string) {
    super(`El contrato ${contractId} ya tiene un PPPoE activo (${existingPppoeId}). Desasociá el existente antes de asociar otro.`,
      'PPPOE_CONTRACT_ALREADY_HAS_SERVICE');
    this.name = 'PppoeContractAlreadyHasServiceError';
  }
}
```

**`AssociatePppoeToContract.execute`** (orden de guardas pinned):
1. `findById` → 404 si no existe.
2. Si `pppoe.contractId === contractId` → idempotente, return (ANTES del guard — re-asociar el mismo no es error).
3. Si `pppoe.contractId !== null` (otro) → `PppoeAlreadyAssociatedError` (existente).
4. **NUEVO**: `findByContract(contractId)` → si hay uno con `status==='enabled'` → `PppoeContractAlreadyHasServiceError`.
5. `setContractId` + `ensureInternet(true)`.

**`CreatePppoeService.execute`**: cuando `input.contractId != null`, tras el `findByUsername`, hacer el mismo guard (`findByContract` → enabled → error) ANTES de tocar la DB.

**Por qué `status==='enabled'`**: solo el PPPoE activo ocupa el slot. Uno `disabled` (baja) o `pending` (alta a medias) no debe bloquear.

HTTP: 409 en `pppoe.routes.ts`, junto al handler de `PppoeAlreadyAssociatedError`.

## Decisión 2 — Desasociar (#2)

**Port**: `clearContractId(id: string): Promise<PppoeService | null>` (set `contractId=null`). Impl Prisma (`update {contractId:null}`) + in-memory.

**Use case** `DeassociatePppoeFromContract.execute(pppoeId, contractId)`:
1. `findById` → 404 si no existe.
2. **Ownership**: si `pppoe.contractId !== contractId` → error (no desvincular el PPPoE de otro contrato). Reusar/crear error apropiado (404 o un mismatch 409).
3. `clearContractId(pppoeId)` — **NO toca `status` ni el secret RADIUS** (queda `enabled`, huérfano, re-asociable).
4. `ensureInternet(contractId, false)` — la línea INTERNET del contrato queda inactive.

**Ruta**: `DELETE /api/contracts/:contractId/pppoe/:pppoeId`, guard `pppoe.manage`. 200 con el DTO huérfano, 404 si no existe/no pertenece.

**Por qué NO `DeactivatePppoeService`**: esa es la BAJA (disable del secret + status='disabled'). Desasociar es distinto: el PPPoE sigue vivo en RADIUS, solo se suelta del contrato.

## Decisión 3 — Reconcile de la línea INTERNET (#1)

Al asociar/crear un PPPoE el contrato no obtiene una línea `ContractService` INTERNET → SERVICIOS queda vacío. El FE YA espera el modelo "INTERNET activa con el PPPoE / inactive en baja" (comentario en `ContractCard.tsx:154`). Falta crear/reconciliar la fila.

**Helper** `EnsureInternetContractService.execute(contractId, active: boolean)` (espeja `reconcileTvContractService`):
```
catalog = catalogRepo.getByName('INTERNET')
if (!catalog || !catalog.active) { warn; return }      // best-effort
existing = csRepo.getByPair(contractId, catalog.id)
if (active) {
  if (!existing) csRepo.add({ contractId, serviceCatalogId: catalog.id, notes: null })
  else if (existing.status !== 'active') csRepo.update(existing.id, { status: 'active' })
} else {
  if (existing && existing.status === 'active') csRepo.update(existing.id, { status: 'inactive' })
}
```

**Best-effort**: todo el helper va en try/catch en los call-sites (patrón `AddContractService` eventRepo) — si el catálogo INTERNET falta o el csRepo falla, se loguea warn y la operación PPPoE NO se rompe. El invariante crítico es el PPPoE; la línea INTERNET es reflejo.

**Wiring** (4 call-sites):
- `AssociatePppoeToContract` (tras setContractId) → `ensure(contractId, true)`
- `CreatePppoeService` (cuando `contractId!=null`, tras `status='enabled'`) → `ensure(contractId, true)`
- `DeassociatePppoeFromContract` → `ensure(contractId, false)`
- `DeactivatePppoeService` (baja) → `ensure(contractId, false)` (si tiene contractId)

**Inyección**: estos use cases reciben ahora `ContractServiceRepository` + `ServiceCatalogRepository` (o el helper `EnsureInternetContractService` ya compuesto). Preferir inyectar el helper compuesto para no inflar las firmas. DI en `app.ts`.

## Test Strategy (TDD estricto)

- **#4**: associate a contrato con PPPoE enabled existente → `PppoeContractAlreadyHasServiceError`; mismo PPPoE→mismo contrato sigue idempotente; un `disabled` no bloquea. create con contractId ocupado → error.
- **#2**: `clearContractId` (in-memory) deja contractId=null, status intacto; `DeassociatePppoeFromContract` valida ownership (PPPoE de otro contrato → error); seam test `DELETE` ruta.
- **#1**: `EnsureInternetContractService` — crea si no existe, reactiva si inactive, inactiva en active=false, no-op/​warn si no hay catálogo; best-effort (csRepo throw no rompe el caller — test que associate sigue OK).

## Risks recap

Bajo-medio. El cuidado real: el reconcile INTERNET es best-effort (nunca rompe la asociación) y el guard #4 filtra por `status='enabled'` para no bloquear con filas muertas.
