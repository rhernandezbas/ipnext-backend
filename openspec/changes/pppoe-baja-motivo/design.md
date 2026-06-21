# Design: PPPoE baja/desasociar con motivo

## Context

El motivo de baja/desasociar de PPPoE no se guarda. La race: `EnsureInternetContractService` inactiva la línea INTERNET síncrono dentro del use case, ANTES del PATCH del FE → `UpdateContractService` no ve transición → no registra evento. Solución: registrar el evento DENTRO del use case, vía `ensureInternet`.

## Decisión 1 — `EnsureInternetContractService` registra el evento

Es el punto único que ya resuelve el catálogo INTERNET + la línea (`getByPair`). Le inyectamos `ContractServiceEventRepository` y registra el evento al flipear:

```ts
async execute(contractId, active, opts?: { reason?: string|null; actorId?: string|null; actorName?: string }) {
  const catalog = await catalogRepo.getByName('INTERNET');
  if (!catalog || !catalog.active) { warn; return; }
  const existing = await csRepo.getByPair(contractId, catalog.id);
  if (active) {
    if (!existing) { await csRepo.add({contractId, serviceCatalogId: catalog.id, notes:null}); await record('activated', opts); }
    else if (existing.status !== 'active') { await csRepo.update(existing.id, {status:'active'}); await record('activated', opts); }
  } else {
    if (existing && existing.status === 'active') { await csRepo.update(existing.id, {status:'inactive'}); await record('deactivated', opts); }
  }
}
// record = best-effort try/catch sobre eventRepo.record({contractId, serviceCatalogId, eventType, reason, actorId, actorName})
```
- `eventRepo` opcional (back-compat con tests que no lo inyectan).
- Solo registra cuando HUBO transición (crea/reactiva/inactiva) — no en los no-op.

## Decisión 2 — threading reason + actor

- `DeactivatePppoeService.execute(id, opts?)` y `DeassociatePppoeFromContract.execute(pppoeId, contractId, opts?)` reciben `opts = { reason?, actorId?, actorName? }` y lo pasan a `ensureInternet(contractId, false, opts)`.
- `AssociatePppoeToContract.execute(pppoeId, contractId, actor?)` y `CreatePppoeService` pasan `{ actorId, actorName }` a `ensureInternet(..., true, {actor})` (reason null en el alta).
- Rutas: `DELETE /pppoe/:id` y `DELETE /contracts/:cid/pppoe/:pppoeId` parsean `reason` del body (zod `{ reason?: string }`) + actor de `req.user` (patrón `actorOf(req)` de contractServices.routes). Sin reason → opts sin reason (no rompe).

## Decisión 3 — FE: motivo en ambas, sin PATCH redundante

- **Baja** (`handleBaja(reason)`): hoy hace deactivate + PATCH (el PATCH es no-op por la race). Cambiar a: `deactivate.mutateAsync({ id, reason })` → el hook manda `reason` en el body del DELETE. **Sacar el PATCH.**
- **Desasociar**: reemplazar el `<div role="dialog">` plano por `ServiceRemovalReasonModal` (ya importado). `handleDeassociate(reason)` → `deassociate.mutateAsync({ pppoeId, reason })`.
- `pppoe.api.ts`: `deactivate(id, reason?)` y `deassociate(contractId, pppoeId, reason?)` mandan `{ reason }` en el body del DELETE (axios.delete con `{ data: { reason } }`).
- Historial: SIN cambio — `ServiceHistoryModal` ya muestra "ver" para eventos INTERNET.

## Test Strategy (TDD)

- **BE**: `EnsureInternetContractService` con eventRepo → al inactivar registra `deactivated` con reason+actor; al activar registra `activated`; no registra en no-op; best-effort (eventRepo throw → no rompe). `DeactivatePppoeService`/`DeassociatePppoeFromContract` con reason → el evento queda con el motivo. Seam de las 2 rutas DELETE con `{reason}` en el body.
- **FE**: baja abre `ServiceRemovalReasonModal` → confirma → deactivate llamado con reason; desasociar abre el modal (no el confirm plano) → deassociate con reason. (Adaptar los tests de `InternetPanel.deassociate`.)

## Riesgo principal

Doble evento si el FE deja el PATCH. Mitigación: el FE saca el PATCH; el evento lo registra SOLO el use case (vía ensureInternet).
