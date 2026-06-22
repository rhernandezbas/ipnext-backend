# Design: "Quitar con destino" (Cambio B)

## Contexto

Hoy "Quitar" = `RemoveInstalledItem` (`src/application/use-cases/RemoveInstalledItem.ts:1-21`): solo `inventory.remove(itemId)` → `status='removed'` en el CII. **No toca el `InventoryAsset`** (queda `installed`@CLIENTE, huérfano), **no registra movimiento**, **no captura destino**. El único caller es el `DELETE /contracts/:contractId/inventory/:itemId` (`contractInventory.routes.ts:309`). FE: `confirm` simple → `deleteInstalledItem`.

La W1 ya tiene todo el andamiaje (verificado file:line):
- `StockLocation` (DEPOSITO/CLIENTE/TECNICO/CAMIONETA) + `Resolve{Depot,Technician,Client}Location` (find-or-create).
- `InventoryMovement` con tipos `INSTALL|RETURN|TRANSFER|CONSUME|ADJUST|ISSUE` + campos `note` (texto), `status` (AssetStatus para ADJUST), `technicianId`, from/to location, `source`, `sourceRef`.
- `nextStatus` valida transiciones; desde `installed` son legales: `available|removed|damaged|retired`.
- `ListTechniciansWithStock` → `GET /inventory/technicians` (perm `inventory.read`) → `[{id,name,assetCount,materialQty}]` (el picker del FE).
- `UnitOfWork`/`runInTransaction` + bag tx-scoped (igual que A).

## Decisión 1 — `RetireInstalledItem` (contract-scoped) + endpoint nuevo

No se extiende el DELETE (mandar body en DELETE es frágil en proxies); se agrega un action POST explícito.

- **Endpoint**: `POST /contracts/:contractId/inventory/:itemId/retire` (perm `inventory.write`), body zod `{ disposition: 'DEPOSITO'|'TECNICO'|'CLIENTE'|'DAMAGED'|'RETIRED', technicianId?: string, note?: string }`. `technicianId` **requerido sii** `disposition==='TECNICO'` (refine zod) → si falta, 400. Devuelve el item retirado (DTO).
- **`RemoveInstalledItem`/DELETE viejo**: queda (sin uso desde el FE) — no se borra para no romper nada; el FE migra al POST. (El destino es obligatorio en la UI nueva.)

## Decisión 2 — `RouteAssetToDisposition` (servicio compartido, tx-scoped)

Servicio de `application/services/` que, dado el bag tx-scoped + `(assetId, disposition, contractId, technicianId?, note?)`, hace **transición + ubicación + movimiento**. Tabla canónica (el activo entra `installed`@CLIENTE):

| disposition | `nextStatus(installed → X)` | location destino | movimiento `type` | `status` en mov. |
|-------------|------------------------------|------------------|-------------------|------------------|
| `DEPOSITO`  | `available` | `ResolveDepotLocation('DEPOSITO')` | `RETURN`   | — |
| `TECNICO`   | `available` | `ResolveTechnicianLocation(technicianId)` | `TRANSFER` | — |
| `CLIENTE`   | `retired`   | `ResolveClientLocation(contractId)` (queda) | `ADJUST` | `retired` |
| `DAMAGED`   | `damaged`   | `ResolveDepotLocation('DEPOSITO')` | `ADJUST` | `damaged` |
| `RETIRED`   | `retired`   | `ResolveDepotLocation('DEPOSITO')` | `ADJUST` | `retired` |

Pasos por disposition (todos dentro de `runUnit`):
1. `from = asset.currentLocationId`.
2. `assets.updateStatus(assetId, nextStatus(asset.status, targetStatus))`.
3. si `to !== from`: `assets.updateLocation(assetId, to)`.
4. `movements.record({ type, assetId, fromLocationId: from, toLocationId: to, technicianId?, source: 'OPERATOR_RETIRE', note: note ?? null, status: <para ADJUST> })`.

> **CLIENTE→TECNICO es el único path nuevo** (hoy `IssueStockToTechnician` solo hace DEPOSITO→TECNICO con asset `available`). Acá el origen es CLIENTE/`installed`. Se reusa `ResolveTechnicianLocation` (find-or-create) + el `record` directo; no se pasa por depósito.

## Decisión 3 — `RetireInstalledItem.execute(input)`

```
runUnit(async (b) => {
  const item = await b.inventory.getById(itemId)
  if (!item) throw InstalledItemNotFoundError
  if (item.contractId !== contractId) throw InstalledItemNotFoundError   // scoping
  if (item.status !== 'active') return item                              // idempotente
  if (disposition === 'TECNICO' && !technicianId) throw TechnicianRequiredError
  await b.inventory.remove(item.id)                                      // status='removed'
  if (item.assetId) await route.execute(b, { assetId: item.assetId, disposition, contractId, technicianId, note })
  return b.inventory.getById(item.id)
})
```
- **Legacy sin `assetId`** → se saltea el routing (solo soft-delete). Test explícito.
- **Atómico**: CII removed + transición + movimiento en UNA tx; si algo falla, rollback total.
- Validar técnico existe (RbacUser activo) — `ResolveTechnicianLocation` crea la location, pero conviene validar el id contra `users` para no crear una TECNICO de un id basura. (A confirmar en apply: si `ListTechniciansWithStock`/users tiene un `findById`.)

## Decisión 4 — Reason/nota: SIN migración

El `note` opcional va en `InventoryMovement.note` (ya existe, `@db.Text`). El **destino** (disposition) es la traza primaria; el `note` es color libre. No se agrega columna ni evento nuevo. (Si más adelante se quiere un historial de retiros con motivo estructurado tipo #127, es un follow-up.)

## Decisión 5 — FE

- `ServiceInventorySection.tsx`: el botón "Quitar" abre un **modal de destino** (reemplaza el `confirm`): radios con las 5 opciones; si "Con técnico" → dropdown poblado por `GET /inventory/technicians`; textarea **nota opcional**. Submit → `POST /contracts/:id/inventory/:itemId/retire`. Invalida la query del inventario. `ui-ux-pro-max`, CSS Modules + tokens.
- Contrato FE→BE explícito: `{ disposition, technicianId?, note? }`. El FE deshabilita submit si `disposition==='TECNICO'` y no eligió técnico (espeja el refine del BE).

## Affected Areas / Risks / Success
Ver `proposal.md`. Lo único net-new es el path CLIENTE→TECNICO y el modal. Sin migración.

## Open questions (apply)
1. ¿Hay `users.findById` para validar el `technicianId`? Si no, confiar en `ResolveTechnicianLocation` (crea la location) + validar contra `ListTechniciansWithStock`.
2. ¿El DTO del item retirado necesita exponer el destino/movimiento? Por ahora devuelve el CII removed; el historial del activo vive en el ledger (no se pide UI de eso en B).
