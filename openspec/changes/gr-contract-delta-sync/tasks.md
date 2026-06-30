# Tasks: Delta PROPIO de contratos de Gestión Real

> TDD ESTRICTO (Jest + ts-jest): RED → GREEN → REFACTOR. Test PRIMERO por cada pieza.
> Use cases con adapters in-memory (`InMemory*`) — NUNCA mockeando Prisma. Parser puro con payload JSON.
> Sin migración (reusa `SyncState`, entity `gr-contracts-delta`). Aditivo. DIP estricta (use case solo depende de ports).
> Referencia a replicar: `SyncGestionRealClients.ts` (cursor, paginación, `formatGrDate`, gate por flag).

## 0. Domain — port + tipos (contrato primero)
- [ ] Extender `src/domain/ports/GestionRealPort.ts`: agregar `FetchContractsDeltaParams { fechaDesde, fechaHasta, cantidad, offset }`, `FetchContractsDeltaResult { total, contracts: GrContract[] }` y el método `fetchContractsModifiedSince(params): Promise<FetchContractsDeltaResult>`.
- [ ] Confirmar que `GrContract` (entity) ya cubre todos los campos (no requiere cambios).

## 1. Adapter — parser por-item (RED → GREEN)
- [ ] **RED**: test del parser `parseContractsDeltaResponse` (nuevo, exportado) en `src/__tests__/infrastructure/gestionReal.contractsDelta.parser.test.ts` (o el archivo de parser GR existente): con un payload `{ error:0, resultados:"2", contratos:[{id,cliente_id,nombre,estado,inicio,domicilio,lat,lng,vendedor,modificado}, ...] }` → mapea `id→grContratoId`, `cliente_id→grClienteId` POR ITEM, `nombre→plan`, `estado→status`, `modificado→modificado`, `total=resultados`; `pppoeUsername=null`.
- [ ] **GREEN**: implementar `parseContractsDeltaResponse(data)` en `GestionRealClient.ts` reusando `str`/`numOrNull`; e implementar el método `fetchContractsModifiedSince` (POST `action:contratos`, `fecha_tipo:m`, `fecha_desde/hasta/cantidad/offset`, `auth: this.auth()`).

## 2. In-memory port (RED → GREEN)
- [ ] **RED**: test de `InMemoryGestionRealPort.fetchContractsModifiedSince` — filtra `contractsModified` por `modificado >= fechaDesde`, pagina por `cantidad/offset`, devuelve `{ total, contracts }`, registra la call en `contractsDeltaCalls`.
- [ ] **GREEN**: extender `InMemoryGestionRealPort` con `contractsModified: GrContract[]`, `contractsDeltaCalls: FetchContractsDeltaParams[]` y el método (reusa `parseGrDate`/`parseGrDateTime` del doble).

## 3. Use case `SyncGestionRealContractsDelta` (RED → GREEN)
- [ ] **RED**: crear `src/__tests__/application/SyncGestionRealContractsDelta.test.ts` con `InMemoryGestionRealPort` + `InMemoryClientMirrorRepository` + `InMemorySyncStateRepository` + `InMemoryFeatureFlagRepository`. Casos:
  - [ ] **T1**: contrato modificado, cliente sin cambios → `upsertContract` llamado, contrato espejado (REQ-DELTA-3).
  - [ ] **T2**: titularidad — cliente nuevo ya espejado + contrato nuevo con su `cliente_id` → contrato creado contra el cliente nuevo (REQ-DELTA-4).
  - [ ] **T3**: cliente dueño inexistente → skip sin crash, procesa el resto; recupera cuando el cliente existe (REQ-DELTA-5).
  - [ ] **T4**: paginación 3 contratos / pageSize 2 → 2 llamadas, 3 procesados una vez (REQ-DELTA-2).
  - [ ] **T5**: primer run sin cursor → ventana `[hoy, hoy]`, persiste cursor = hoy, NO escanea anterior (REQ-DELTA-6).
  - [ ] **T6**: run siguiente con cursor → `fechaDesde = cursor previo`, `fechaHasta = hoy`, avanza cursor a hoy (REQ-DELTA-7).
  - [ ] **T7**: idempotencia — re-correr mismo día → update, no segundo row (REQ-DELTA-8).
  - [ ] **T8**: flag `gestion-real-sync` OFF → no-op (sin call GR, sin tocar SyncState) (REQ-DELTA-9).
  - [ ] **T9**: error en GR → persiste lastResult error con cursor previo, re-lanza (espejo del clients sync).
- [ ] **GREEN**: implementar `src/application/use-cases/SyncGestionRealContractsDelta.ts` (entity `gr-contracts-delta`, flag `gestion-real-sync`, bootstrap `fechaDesde = prior?.cursor ?? hoy`, paginación, `upsertContract` por contrato, save de cursor/lastResult, inyección de `now`/`pageSize`). Helper `formatGrDate` (reusar/duplicar mínimamente como en clients).

## 4. Fix bug secundario — `clientId` en `upsertContract.update` (RED → GREEN)
- [ ] **RED**: test contra `InMemoryClientMirrorRepository` (alinearlo si su doble no refleja el comportamiento real): un contrato existente con dueño `A` recibe un `upsertContract` con `grClienteId = B` (espejado) → tras el upsert el contrato apunta a `B`, sigue siendo el mismo `grContratoId` (REQ-DELTA-12).
- [ ] **GREEN**: en `PrismaClientMirrorRepository.upsertContract` agregar `clientId: parent.id` al objeto `data` compartido (lo hereda el update); quitar/dejar el `clientId` redundante del `create`. Alinear el doble in-memory si hace falta para que el test sea fiel.

## 5. Scheduler — wire del delta tras el client-sync (RED → GREEN)
- [ ] **RED**: test de `GestionRealSyncScheduler.runOnce()` — con el delta cableado, corre client-sync → contract-sync por-cliente → delta global; si el delta tira error, `runOnce()` completa y libera el lock (REQ-DELTA-10). El por-cliente se MANTIENE (REQ-DELTA-11).
- [ ] **GREEN**: inyectar `SyncGestionRealContractsDelta` en `GestionRealSyncScheduler` (dependencia opcional, igual que `backfill`), llamarlo en `runOnce()` después del `syncContracts.execute(...)`, sumarlo al `RunSummary` y al log. Mantener el swallow del error y el `release` en `finally`.

## 6. Composition root — wiring DI (RED → GREEN)
- [ ] **RED**: test del composition root (espejar el test existente de `bootstrapGestionRealSync`, si hay) — verifica que el scheduler queda construido con el delta cableado.
- [ ] **GREEN**: en `bootstrapGestionRealSync.ts` instanciar `new SyncGestionRealContractsDelta(client, mirror, state, featureFlags)` y pasarlo al `new GestionRealSyncScheduler(...)`.

## 7. Integración (opcional pero recomendado)
- [ ] Test de integración del flujo: client-sync espeja cliente nuevo → delta global espeja su contrato nuevo → el contrato queda colgado del cliente nuevo (reproduce el escenario de titularidad end-to-end con in-memory).

## 8. Verificación final
- [ ] `npx jest` verde (nuevos + suite GR sin regresiones: clients, contracts, scheduler, backfill, balances).
- [ ] DIP: el use case NO importa nada de `infrastructure/`/Prisma/axios (solo ports).
- [ ] Sin cambio de schema (no nueva migración).
- [ ] Commit conventional: `fix(gr-sync): delta propio de contratos por fecha de modificación (cierra titularidad sin espejar)`.

## 9. Pendiente fuera de scope (CARD APARTE)
- [ ] Limpieza del contrato fantasma legacy (grContratoId viejo colgado del titular anterior tras titularidades ya ocurridas). NO es parte de este change.

## Salida
- [ ] Un cambio de contrato en GR (incluida la titularidad) espeja el contrato en Prominense sin depender de que el cliente haya cambiado; `gr-ingest` deja de saltear por `contract-unmirrored` en casos nuevos.
