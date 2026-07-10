# Design — service-transfer

Anclas de código verificadas (exploración 2026-07-10). Direcciones de dependencia hexagonales
estrictas: use cases dependen SOLO de ports.

## 1. Eventos de transferencia (transversal)

Reusa `ContractServiceEvent` (schema.prisma:2685-2715; port
`src/domain/ports/ContractServiceEventRepository.ts`) — SIN migración: `changeKind` ya es
String libre (port :25), `eventType:'modified'` ya existe en la union.

- Contrato ORIGEN: `record({ eventType:'modified', changeKind:'transfer-out', oldValue:<nombre
  cliente origen>, newValue:<nombre cliente destino>, reason?<motivo>, notes:<modo/detalle>,
  actorId, actorName, serviceCatalogId, contractId: origen })`
- Contrato DESTINO: idem con `changeKind:'transfer-in'`, `contractId: destino`.
- Patrón de grabado best-effort (try/catch, nunca aborta la op ya hecha):
  `UpdatePppoeService.ts:172-219`. Catálogo por nombre: `catalogRepo.getByName('INTERNET')`
  (:179) / `'TV'` para el slot TV (mismo helper que usa reconcileTvContractService).
- `ListContractServiceHistory` ya expone `notes`/`reason` en `ServiceEventDto` → el FE etiqueta
  por `changeKind` (patrón `InternetActivationHistoryModal.PlanChangeInfo` del pppoe-change-audit).
- PPPoE `as-is` además marca `notes:'tal cual (sin recrear) — pendiente de regularizar'` →
  la lista de regularización sale filtrando ese changeKind+notes.

## 2. TransferTvToCustomer (application/use-cases/gigared/)

Deps (clonar wiring `app.ts:2115-2169`): `GigaredPort`, `CustomerLookup`, `ContractLookup`
(ownership-aware, lookups.ts:29-37), `ContractServiceRepository`, `ServiceCatalogRepository`,
`ClientTvCancellationRepository`, `ContractServiceEventRepository` (nuevo en este flujo).

`execute(sourceCustomerId, { targetCustomerId, targetContractId, sourceContractId?, actor })`

Orden de guardas (pinned, estilo LinkCustomerToCic/CancelTv):
1. source customer existe → `ClientNotFoundError`
2. target customer existe → `ClientNotFoundError`
3. targetContract existe Y pertenece a target → `ContractNotFoundError` (ANTES de tocar Gigared)
4. source NO cancelado localmente (`isCancelled(source)` → `TvNotLinkedError`) y su cuenta
   resuelve por `currentTvInternalId(source, seq)` (`getAccountByInternalId`; 404 upstream →
   `TvNotLinkedError`). Capturar `cic` y credenciales de la cuenta.
5. target NO tiene TV vigente: `getAccountByInternalId(targetInternalId)` debe dar 404
   (si resuelve → `CicAlreadyLinkedError`-style 409 nuevo: `TvAlreadyLinkedError`).

Pasos (partner primero, local después; la op partner NUNCA se revierte — espejo D7):
1. `setInternalId(cic, targetInternalId)` — crea el ALIAS (F0: el CUA no pisa, aliasa).
2. **VERIFY del alias** (el CUA devuelve 200 sin efecto visible): `getAccountByInternalId
   (targetInternalId)` → `account.cic === cic`, si no → `GigaredRejectedError` (nada local se tocó).
3. `markCancelled(source)` — severing (ESENCIAL para matar el doble-vínculo; fallo → `severed:false`, 207).
4. `clearCancelled(target)` — best-effort.
5. Slot TV local origen: inactivación DIRECTA + limpiar credenciales (csRepo; NO reconcile
   account-driven — el internal_id origen sigue resolviendo por el alias). Fallo → `localSource:'failed'`.
6. Slot TV local destino: `reconcileTvContractService({contractId: targetContractId,
   internalId: targetInternalId, ...})` (crea/activa con CIC+credenciales). Fallo → `localTarget:'failed'`.
7. Eventos transfer-out (sourceContractId — param opcional; si falta, resolver el contrato del
   slot TV activo del origen; si no hay, se omite con warn) y transfer-in (targetContractId).
   Best-effort.

Resultado `{ cic, aliased:true, severed, localSource, localTarget }` → router 200 si todo ok,
**207 si severed=false o algún local='failed'** (partner ya transferido, retry direccionado).

## 3. TransferPppoe (application/use-cases/)

`execute(pppoeId, { targetContractId, mode:'as-is'|'recreate', reason?, newPppoe?, actor })`

Guardas comunes: pppoe existe (404); targetContract existe+ownership (`ContractLookup`) (404);
target ≠ contrato actual (409 no-op); contrato destino SIN otro PPPoE `enabled`
(guard espejo `AssociatePppoeToContract.ts:44` → `PppoeContractAlreadyHasServiceError`).

**Modo `as-is`** (fallback): `reason` OBLIGATORIO (400 `VALIDATION_ERROR` si falta).
1. capturar contrato/cliente origen
2. `repo.setContractId(pppoeId, targetContractId)` (port :159 — no toca secret/RADIUS)
3. `ensureInternet(origen,false)` + `ensureInternet(destino,true)` best-effort (espejo associate)
4. eventos transfer-out/in con `reason` + notes 'tal cual (sin recrear) — pendiente de regularizar'

**Modo `recreate`**: compone use cases inyectados, crear PRIMERO:
1. `createPppoe.execute({...newPppoe, contractId: targetContractId})` — si FALLA → abort total
   (el viejo queda intacto), error propagado.
2. `terminatePppoe.execute(pppoeId)` — baja HARD del viejo (orchestrator.deleteUser / router
   removeSecret según nas.type, TerminatePppoeService.ts:41-74). Si FALLA → **207 parcial**:
   nuevo vivo, viejo pendiente (retry por el DELETE existente); el resultado lo dice explícito.
3. eventos transfer-out (notes 'recreado: <oldUsername> → <newUsername>') / transfer-in.

## 4. TransferContractEquipment (application/use-cases/)

`execute(sourceContractId, { targetContractId, itemIds[], actor })`

Guardas: ambos contratos existen (ownership lookup); `itemIds` no vacío; cada ítem pertenece al
contrato origen y está `active` (404/409 por ítem inválido — falla ANTES de mover nada).

1. Legacy: mover cada `ContractInstalledItem` al contrato destino. El port
   (`ContractInventoryRepository`) NO tiene transfer → **agregar método
   `transferToContract(itemId, targetContractId)`** (port + Prisma + InMemory).
2. Unificado: si `item.assetId != null` → `InventoryMovement` `type:'TRANSFER'` de la
   CLIENTE-location origen → destino, con `ResolveClientLocation` (find-or-create, :22-40) en
   `uow.runInTransaction` (patrón `IssueStockToTechnician.ts:62-80`).
3. Eventos transfer-out/in (catálogo 'INTERNET'... NO: usar el catálogo del servicio del
   contrato si aplica; para equipos usar notes con la lista de ítems `type serial/mac`).

## 5. RBAC + rutas

- `rbac.ts`: agregar `'transfer'` a `KNOWN_ACTIONS` de los módulos `tv`, `pppoe`, `inventory`
  (:19-79). El FE recibe las claves dotted (`tv.transfer`, ...) por el /me existente.
- Rutas (TODOS los handlers async con `next` + `next(err)` — lección 504):
  - `POST /api/gigared/customers/:id/transfer-tv` — guard `requirePerm('tv','transfer')`,
    body `{targetCustomerId, targetContractId, sourceContractId?}`. Router gigared
    (`GigaredRouterDeps` + `gigared.routes.ts`), mapping de errores por instancia (patrón local).
  - `POST /api/pppoe/:id/transfer` — guard `requirePerm('pppoe','transfer')`, body
    `{targetContractId, mode, reason?, newPppoe?}`. `pppoe.routes.ts` (errores al errorHandler
    global vía next — statusMap ya existente).
  - `POST /api/contracts/:contractId/inventory/transfer` — guard
    `requirePerm('inventory','transfer')`. `contractInventory.routes.ts`.
- Wiring en `app.ts` (bloque gigared :2115-2169 y análogos) — **flag known_debt god-object-app**.
  Pin con assertions en el composition-root test existente (`gigared-composition.test.ts`).

## 6. Testing (Strict TDD)

- Use cases: unit con fakes/in-memory (patrón `GigaredAccount.usecases.test.ts`,
  `CancelTv.usecase.test.ts`); NUNCA mockear Prisma.
- Rutas: supertest + router real + in-memory (patrón `gigared.routes.test.ts:1-90`) — incluye
  test "no cuelga" (error tipado → status inmediato) por ruta nueva.
- Seam completo: transferencia vía ruta con use case REAL + repos in-memory (lección #28).
- In-memory nuevos/extendidos: `InMemoryContractInventoryRepository.transferToContract`,
  fakes de create/terminate para el recreate.
