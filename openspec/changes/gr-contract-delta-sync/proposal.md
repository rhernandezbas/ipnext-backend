# Proposal: Delta PROPIO de contratos de Gestión Real (cierra el bug de titularidad)

## Intent

Darle al sync de **contratos** de Gestión Real (GR) un **delta propio por fecha de modificación**, análogo al de **clientes** (`SyncGestionRealClients`), para que los cambios de contrato espejen en Prominense **aunque el cliente dueño no haya cambiado**. Hoy el contract-sync es **esclavo** del delta de clientes y se pierde todo cambio de contrato asíncrono respecto a la última modificación del cliente — el caso típico del **cambio de titularidad**.

## Why — Problema (causa raíz, ya diagnosticada y verificada en vivo)

**Síntoma**: un cambio de titularidad en GR espeja el cliente nuevo **sin contrato**. `gr-ingest` ya saltea órdenes con `reason: "contract-unmirrored"` → el problema es **sistémico**, no anecdótico.

**Causa raíz (bug de DISEÑO)**: `SyncGestionRealContracts` NO tiene delta propio. Recibe del scheduler (`GestionRealSyncScheduler` líneas 84-89) los `touchedClientIds`/`createdClientIds` que produjo el **client-sync**, y solo entonces hace `fetchContractsByClient(cli)` por cada uno. Es decir: **un contrato solo se re-espeja si su cliente entró al delta de clientes**.

GR crea/modifica/asigna contratos de forma **asíncrona** respecto a la `ultima_modificacion` del CLIENTE. En el cambio de titularidad GR crea un **cliente nuevo + un contrato nuevo (grContratoId NUEVO)** y da de baja el viejo. El contrato nuevo se crea/asigna **después** de la última mod del cliente nuevo → el cliente nuevo no re-entra al delta → `fetchContractsByClient` no se vuelve a llamar → **el contrato jamás se espeja**.

**Hallazgo que habilita el fix (confirmado EN VIVO contra la API de GR)**: GR **sí** expone un delta de contratos **GLOBAL** por fecha de modificación, sin `cliente_id`:

```
POST  { "action": "contratos", "fecha_tipo": "m",
        "fecha_desde": "DD-MM-AAAA", "fecha_hasta": "DD-MM-AAAA",
        "cantidad": 100, "offset": 0 }
→     { "error": 0, "contratos": [ {...} ], "resultados": N, "cantidad": N, "offset": 0 }
```

Probado: 324 contratos modificados en 12 días, paginación por `cantidad`/`offset` OK. Cada item trae `id` (=grContratoId), `cliente_id` (=grClienteId del dueño, **por item**), `estado`, `nombre` (=plan), `inicio`, `domicilio`, `lat`, `lng`, `vendedor`, `modificado`. OJO: `action: "contrato"` (SINGULAR) con filtro de fecha global da `error 3 "No se indico contrato"` → NO sirve; es `contratos` (PLURAL).

**Bug secundario (se cierra de paso, por robustez)**: `PrismaClientMirrorRepository.upsertContract` arma un `data` que en el branch `update` (línea 121) **NO incluye `clientId`** — el dueño solo se setea en el `create` (línea 126). Si un contrato cambiara de dueño manteniendo su `grContratoId`, el update no lo reasignaría. GR no hace eso (cambia el id), pero el fix debe incluir `clientId: parent.id` en el update por robustez, con su test.

## Scope

### In Scope (BE puro, ADITIVO, sin migración)

- **Domain**: extender `GestionRealPort` con un método de delta de contratos global (paginado), con sus tipos de params/result. Sin cambios en la entity `GrContract` (ya tiene todos los campos).
- **Adapter HTTP** (`GestionRealClient`): nuevo método `fetchContractsModifiedSince` (`action: contratos`, `fecha_tipo: m`) + **parser nuevo** que toma `cliente_id` de **cada item** (NO del parámetro) y lee `resultados` para paginar.
- **In-memory port** (`InMemoryGestionRealPort`): doble del nuevo método con filtro por `modificado` + paginación + registro de calls.
- **Use case nuevo** `SyncGestionRealContractsDelta`: cursor PROPIO en `SyncState` (entity **`gr-contracts-delta`** — NO reusa `gr-contracts-backfill`), feature flag `gestion-real-sync`, paginación, re-scan del último día (overlap idempotente), bootstrap del cursor a "hoy". Por cada contrato → `mirror.upsertContract(contract)`.
- **Scheduler** (`GestionRealSyncScheduler`): correr el delta DESPUÉS del client-sync (clientes nuevos ya existen). Errores swallowed como el resto del ciclo.
- **Composition root** (`bootstrapGestionRealSync`): wiring DI del nuevo use case.
- **Fix del bug secundario**: `clientId: parent.id` en el `update` de `upsertContract`, con test.

### Out of Scope

- **Limpieza del contrato fantasma viejo** (el contrato con `grContratoId` viejo que queda colgado del titular anterior tras una titularidad ya ocurrida). Este fix **previene** casos futuros; el fantasma es **dato legacy** → **CARD APARTE** (recomendado). NO entra en este scope.
- **Sin migración de schema**: reusa la tabla `SyncState` (nuevo `entity`, no nueva columna) y `Contract`/`Client` existentes.
- **Sin tocar** `BackfillGrContractsBatch`/`ArmGrContractsBackfill` (su cursor `gr-contracts-backfill` es independiente).
- **Sin tocar FE.**

## Capabilities

### New Capability
- **`gr-contract-delta`**: el sync de contratos detecta cambios de contrato por su propia fecha de modificación (feed global de GR), independiente del delta de clientes.

### Modified (de paso)
- **GR mirror write** (`upsertContract`): el `update` reasigna `clientId` (robustez ante cambio de dueño manteniendo id).

## Approach

Delta de contratos PROPIO, espejando `SyncGestionRealClients`:

1. **(test primero)** Tests in-memory del nuevo use case + parser + in-memory port + el fix del `clientId`.
2. Extender el port con `fetchContractsModifiedSince(params)` paginado.
3. Parser nuevo que mapea **por item** `cliente_id → grClienteId`, reusando la entity `GrContract`.
4. Use case `SyncGestionRealContractsDelta` con cursor `gr-contracts-delta`; bootstrap = "hoy" (el histórico ya lo cubrió `gr-contracts-backfill`); por contrato → `upsertContract` (resuelve parent por `grClienteId`, create/update por `grContratoId`; el guard `if(!parent) return` saltea contratos cuyo cliente aún no se espejó, se recuperan en el overlap del próximo tick).
5. Wire en el scheduler DESPUÉS del client-sync; wire DI en el bootstrap.
6. Cerrar el bug del `clientId` en el `update` de `upsertContract`.

## Decisiones a confirmar (con recomendación)

| # | Decisión | Recomendación |
|---|----------|---------------|
| D1 | ¿Mantener el contract-sync por-cliente (touched/created) EN PARALELO al delta global, o reemplazarlo? | **MANTENER ambos.** El por-cliente cubre contratos modificados en el mismo tick que su cliente (refresh inmediato); el delta global cierra el gap async. Ambos pasan por `upsertContract` (idempotente, keyed por `grContratoId`) → la doble pasada es inofensiva. Costo del delta acotado (paginado). Optimización futura: drop del por-cliente cuando el delta pruebe ser confiable. |
| D2 | Nombre del entity del cursor + bootstrap inicial | Entity **`gr-contracts-delta`**. Bootstrap: primera corrida (sin cursor) → `fecha_desde = hoy`, persistir cursor = hoy (escanea solo hoy). **NO** hay modo "backfill histórico** acá: el universo histórico es responsabilidad de `gr-contracts-backfill`. |
| D3 | Feature flag | **Reusar `gestion-real-sync`** (el master switch único del sync GR). Un flag nuevo agrega complejidad operativa sin beneficio. |
| D4 | Orden en el scheduler | Delta DESPUÉS del client-sync (clientes nuevos ya existen). Junto/después del por-cliente actual. |
| D5 | Contrato fantasma viejo | **Card aparte** (dato legacy). Fuera de este scope. |

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/domain/ports/GestionRealPort.ts` | Modified — nuevo método + tipos de params/result |
| `src/infrastructure/adapters/gestion-real/GestionRealClient.ts` | Modified — `fetchContractsModifiedSince` + parser nuevo por-item |
| `src/infrastructure/adapters/in-memory/InMemoryGestionRealPort.ts` | Modified — doble del nuevo método |
| `src/application/use-cases/SyncGestionRealContractsDelta.ts` | New — use case del delta con cursor propio |
| `src/infrastructure/scheduling/GestionRealSyncScheduler.ts` | Modified — wire del delta tras el client-sync |
| `src/infrastructure/scheduling/bootstrapGestionRealSync.ts` | Modified — wiring DI |
| `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` | Modified — `clientId` en `upsertContract.update` |
| `src/__tests__/...` | New — tests in-memory de las piezas |

Sin tocar: `GrContract` entity, schema Prisma, `BackfillGrContractsBatch`, FE.

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Colisión de cursor con `gr-contracts-backfill` | Baja | Entity DISTINTO (`gr-contracts-delta`); el backfill usa offset numérico, el delta usa fecha DD-MM-AAAA. |
| Contrato cuyo cliente aún no se espejó se saltea (guard `!parent`) | Media | El client-sync corre ANTES en el mismo tick (clientes modificados/creados ya entran); el overlap día-granular del cursor recupera el resto en el siguiente tick. Documentado en spec/design. |
| Doble fetch de un contrato (por-cliente + delta) | Baja | `upsertContract` es idempotente (keyed por `grContratoId`); sin efecto. |
| Bootstrap escanea el histórico completo por error | Baja | Bootstrap explícito a "hoy"; el histórico es de `gr-contracts-backfill`. Test de bootstrap. |
| `pppoeUsername` ausente en el feed global | Baja | `upsertContract` NO persiste `pppoeUsername` (no está en `data`); el por-cliente lo cubre. Sin impacto. |

## Rollback

Aditivo y acotado. Rollback = `git revert` del commit BE + (si hace falta) apagar el flag `gestion-real-sync`. Sin migración → sin rollback de schema. El nuevo entity `gr-contracts-delta` en `SyncState` queda inerte si el use case no corre.

## Dependencies

- `SyncState` table + `SyncStateRepository` (ya existen) — reuso de tabla, entity nuevo.
- Feature flag `gestion-real-sync` (ya existe).
- `upsertContract` (ya resuelve parent por `grClienteId` + create/update por `grContratoId`).
- Patrón de referencia: `SyncGestionRealClients` (cursor, paginación, `formatGrDate`, overlap día-granular).

## Success Criteria

- [ ] El delta global detecta un contrato modificado SIN que su cliente haya cambiado, y lo espeja.
- [ ] Un contrato reasignado a un cliente nuevo (titularidad) espeja contra el cliente nuevo.
- [ ] Un contrato cuyo cliente aún no se espejó se saltea sin crash y se recupera en el overlap.
- [ ] Paginación correcta (cantidad/offset, total = `resultados`).
- [ ] El cursor `gr-contracts-delta` avanza y bootstrapea a "hoy" en la primera corrida.
- [ ] Idempotencia: re-correr el mismo día no duplica.
- [ ] `upsertContract.update` reasigna `clientId`.
- [ ] Flag `gestion-real-sync` OFF → no-op (sin call GR, sin tocar SyncState).
- [ ] Suite verde; sin tocar schema; DIP respetada (use case solo depende del port).
