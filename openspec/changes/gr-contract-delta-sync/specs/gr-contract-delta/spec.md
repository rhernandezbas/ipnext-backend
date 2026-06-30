# Spec — gr-contract-delta (delta propio de contratos por fecha de modificación)

**Capability**: `gr-contract-delta`
**Type**: New
**Change**: `gr-contract-delta-sync`
**Layer**: Application use case (ports only) + adapter parser + scheduler/composition wiring (infrastructure)
**New SyncState entity**: `gr-contracts-delta` (reusa la tabla `SyncState` — sin cambio de schema)
**Feature flag**: `gestion-real-sync` (reusa el master switch del sync GR)
**Test runner**: `npx jest` · Strict TDD (RED → GREEN → REFACTOR)

---

## Purpose

Espejar en Prominense los cambios de **contrato** de Gestión Real **aunque el cliente dueño no haya cambiado**, consumiendo el **feed global de contratos por fecha de modificación** de GR (`action: "contratos"`, `fecha_tipo: "m"`), independiente del delta de clientes. Cierra el bug de titularidad (cliente nuevo espejado sin contrato; `gr-ingest` salteando `contract-unmirrored`).

El cursor es la **fecha** (DD-MM-AAAA) del último run exitoso, guardada en el `cursor` del SyncState `gr-contracts-delta`. La primera corrida (sin cursor) **bootstrapea a hoy** (el histórico es responsabilidad de `gr-contracts-backfill`).

---

## 1. El adapter expone un delta global de contratos por fecha de modificación

### REQ-DELTA-1: El port trae contratos modificados en una ventana, paginados, con `cliente_id` por item

`GestionRealPort.fetchContractsModifiedSince({ fechaDesde, fechaHasta, cantidad, offset })` MUST consultar GR con `action: "contratos"` + `fecha_tipo: "m"` (SIN `cliente_id`) y devolver `{ total, contracts }`, donde `total` = el campo `resultados` de GR y `contracts` = los items de la página normalizados a `GrContract`. Cada `GrContract.grClienteId` MUST tomarse del campo `cliente_id` de **ese item** (NO de un parámetro global).

#### Scenario: El parser estampa el cliente dueño por cada item

- GIVEN un payload GR `{ error:0, resultados:"2", contratos:[ { id:"900", cliente_id:"111", nombre:"IP-Air-30", estado:"Vigente", modificado:"20-06-2026 10:00:00" }, { id:"901", cliente_id:"222", nombre:"IP-Air-50", estado:"Vigente", modificado:"20-06-2026 11:00:00" } ] }`
- WHEN se parsea la respuesta del delta
- THEN el contrato `900` tiene `grClienteId === "111"` y el `901` tiene `grClienteId === "222"`
- AND `total === 2`
- AND cada `GrContract` mapea `id→grContratoId`, `nombre→plan`, `estado→status`, `modificado→modificado`

### REQ-DELTA-2: La paginación recorre toda la ventana

`SyncGestionRealContractsDelta` MUST paginar por `cantidad`/`offset` desde 0, usando `total` como cota superior, hasta cubrir todos los contratos de la ventana (corta cuando la página viene vacía o `offset >= total`).

#### Scenario: Una ventana con 3 contratos y pageSize 2 se recorre en 2 páginas

- GIVEN el feed global tiene 3 contratos modificados en la ventana y `pageSize = 2`
- WHEN `execute()` corre
- THEN hace 2 llamadas a `fetchContractsModifiedSince` (offset 0 y 2)
- AND procesa los 3 contratos exactamente una vez

---

## 2. El delta espeja contratos sin depender del delta de clientes

### REQ-DELTA-3: Un contrato modificado sin cambio de su cliente se espeja

Cuando un contrato cambia en GR pero su cliente dueño NO entró al delta de clientes, `SyncGestionRealContractsDelta` MUST detectarlo por su `modificado` y espejarlo vía `upsertContract` (create si es nuevo, update si ya existe, keyed por `grContratoId`).

#### Scenario: Contrato modificado, cliente sin cambios → se espeja igual

- GIVEN el cliente `111` ya está espejado y su `ultima_modificacion` NO cambió
- AND el contrato `900` de `111` fue modificado dentro de la ventana del delta
- WHEN `execute()` corre
- THEN `upsertContract` se llama con el contrato `900`
- AND el contrato `900` queda espejado contra el cliente `111`

### REQ-DELTA-4: Un contrato reasignado a un cliente nuevo (titularidad) espeja contra el cliente nuevo

Cuando GR crea un cliente nuevo + un contrato nuevo (grContratoId NUEVO con `cliente_id` = el cliente nuevo) — el patrón del cambio de titularidad — el delta MUST espejar ese contrato colgado del cliente nuevo, una vez que el cliente nuevo existe en el mirror.

#### Scenario: Titularidad — contrato nuevo cuelga del cliente nuevo

- GIVEN el client-sync de este tick ya espejó el cliente nuevo `222`
- AND el feed de contratos trae el contrato nuevo `901` con `cliente_id:"222"`
- WHEN `execute()` corre
- THEN `upsertContract` crea el contrato `901` con dueño `222`
- AND `222` queda con su contrato espejado (ya NO "cliente sin contrato")

### REQ-DELTA-5: Un contrato cuyo cliente aún no se espejó se saltea sin crash y se recupera

Si `upsertContract` no encuentra el cliente dueño (`!parent`), MUST saltear ese contrato (no crashear, no crear contrato huérfano) y seguir con el resto de la página. El contrato se recupera en una corrida posterior, dentro del overlap del cursor, una vez que el cliente exista.

#### Scenario: Cliente dueño todavía no espejado → skip, sin crash

- GIVEN el feed trae el contrato `950` con `cliente_id:"999"`
- AND el cliente `999` NO existe aún en el mirror
- WHEN `execute()` corre
- THEN el contrato `950` NO se espeja (no se crea huérfano)
- AND el use case NO crashea y procesa el resto de los contratos de la página
- WHEN en una corrida posterior el cliente `999` ya existe y el contrato `950` sigue dentro de la ventana
- THEN el contrato `950` se espeja contra `999`

---

## 3. Cursor: bootstrap a hoy, avance e idempotencia

### REQ-DELTA-6: La primera corrida bootstrapea el cursor a hoy (sin escanear el histórico)

Si el SyncState `gr-contracts-delta` NO tiene cursor, `execute()` MUST usar `fechaDesde = hoy` (no escanear años de historia) y, al terminar OK, persistir `cursor = hoy`. El universo histórico es responsabilidad de `gr-contracts-backfill`, no de este delta.

#### Scenario: Primer run sin cursor → ventana = hoy, persiste hoy

- GIVEN no existe SyncState `gr-contracts-delta` (o su cursor es null)
- AND la fecha de hoy es `30-06-2026`
- WHEN `execute()` corre
- THEN consulta el feed con `fechaDesde = "30-06-2026"` y `fechaHasta = "30-06-2026"`
- AND NO consulta fechas anteriores
- AND al terminar el cursor persistido es `"30-06-2026"`

### REQ-DELTA-7: Las corridas siguientes hacen delta con overlap día-granular y avanzan el cursor

Con cursor previo, `execute()` MUST usar `fechaDesde = cursor previo` y `fechaHasta = hoy` (overlap de ≥1 día para no perder cambios del mismo día), y al terminar OK persistir `cursor = hoy`.

#### Scenario: Run siguiente re-escanea desde el último cursor y avanza

- GIVEN el cursor `gr-contracts-delta` es `"28-06-2026"` y hoy es `"30-06-2026"`
- WHEN `execute()` corre OK
- THEN consulta el feed con `fechaDesde = "28-06-2026"`, `fechaHasta = "30-06-2026"`
- AND al terminar el cursor persistido es `"30-06-2026"`

### REQ-DELTA-8: El delta es idempotente

Correr `execute()` dos veces sobre la misma ventana MUST NO duplicar contratos (los upserts están keyed por `grContratoId`). Un contrato re-procesado resulta en un update, no en un segundo row.

#### Scenario: Re-correr el mismo día no duplica

- GIVEN un contrato `900` ya espejado por una corrida previa hoy
- WHEN `execute()` corre otra vez hoy y el feed vuelve a traer `900`
- THEN `900` se actualiza (no se crea un segundo contrato)
- AND el resultado cuenta el `900` como `updated`, no como `created`

---

## 4. Gate por feature flag (sin redeploy)

### REQ-DELTA-9: Flag `gestion-real-sync` OFF → no-op

`execute()` MUST chequear el feature flag `gestion-real-sync` por corrida. Si está OFF/ausente, MUST ser un no-op: NO llamar a GR, NO tocar el SyncState `gr-contracts-delta`. (Espejo del gate de `SyncGestionRealClients`.)

#### Scenario: Flag apagado → no toca nada

- GIVEN el feature flag `gestion-real-sync` está OFF (o no existe)
- WHEN `execute()` corre
- THEN NO se llama a `fetchContractsModifiedSince`
- AND el SyncState `gr-contracts-delta` queda sin cambios
- AND el resultado indica que se salteó por flag

---

## 5. Integración con el scheduler (después del client-sync)

### REQ-DELTA-10: El scheduler corre el delta global después del client-sync, cada tick

`GestionRealSyncScheduler.runOnce()` MUST correr `SyncGestionRealContractsDelta.execute()` **después** del client-sync (para que los clientes nuevos ya estén espejados) y del contract-sync por-cliente (que se MANTIENE). El error del delta MUST ser swallowed como el resto del ciclo (un mal delta no tumba el timer) y el lock `gr-sync` MUST liberarse en `finally`.

#### Scenario: El delta corre cada tick, tras el client-sync

- GIVEN el scheduler tiene cableado el delta de contratos
- WHEN `runOnce()` corre
- THEN corre el client-sync, luego el contract-sync por-cliente, luego el delta global de contratos
- AND si el delta tira error, `runOnce()` igual completa y libera el lock

### REQ-DELTA-11: El contract-sync por-cliente se MANTIENE en paralelo al delta

El delta global NO reemplaza al contract-sync por-cliente (touched/created ids del client-sync). Ambos conviven; al ser idempotentes (keyed por `grContratoId`), una doble pasada del mismo contrato es inofensiva.

#### Scenario: Conviven sin duplicar

- GIVEN un contrato `900` que entra TANTO por el por-cliente (su cliente cambió) COMO por el delta global (su `modificado` está en ventana)
- WHEN `runOnce()` corre
- THEN `900` se espeja una sola vez (el segundo upsert es un update idempotente)

---

## 6. Robustez del mirror write (bug secundario)

### REQ-DELTA-12: `upsertContract.update` reasigna el `clientId`

`ClientMirrorRepository.upsertContract` MUST setear `clientId = parent.id` también en el branch de **update** (no solo en el create), para que un contrato existente cuyo dueño cambió quede reasignado al cliente correcto.

#### Scenario: Update reasigna el dueño

- GIVEN existe un contrato `900` espejado con dueño = cliente `A`
- AND llega un `upsertContract` para `900` con `grClienteId` = cliente `B` (ya espejado)
- WHEN se ejecuta el upsert
- THEN el contrato `900` queda con `clientId` = el id de `B`
- AND NO se crea un contrato nuevo (sigue siendo el mismo `grContratoId`)

---

## Appendix: Contratos

| Elemento | Valor |
|----------|-------|
| GR action | `contratos` (PLURAL) — `contrato` (singular) con fecha global da `error 3` |
| Eje de fecha | `fecha_tipo: "m"` (modificación) |
| Filtro de cliente | NINGUNO (feed global); `cliente_id` se lee POR ITEM |
| Paginación | `cantidad` (≤100) / `offset`; `total` = campo `resultados` |
| SyncState entity | `gr-contracts-delta` (≠ `gr-contracts-backfill`) |
| Cursor | fecha DD-MM-AAAA del último run; bootstrap = hoy |
| Overlap | día-granular (`fechaDesde = cursor previo`) |
| Feature flag | `gestion-real-sync` (reuso) |
| Upsert | `upsertContract` (resuelve parent por `grClienteId`, create/update por `grContratoId`) |
| Schema | sin migración (reusa `SyncState`) |
