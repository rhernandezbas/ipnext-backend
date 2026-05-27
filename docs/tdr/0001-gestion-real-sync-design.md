# TDR 0001 — Diseño del sync de Gestión Real

Decisiones de alto nivel: [ADR 0004](../adr/0004-gestion-real-readonly-mirror.md)
(mirror read-only) y [ADR 0005](../adr/0005-in-process-scheduler-behind-flag.md)
(scheduler). Este documento describe el **algoritmo** del sync.

## Piezas

| Pieza | Archivo | Rol |
|-------|---------|-----|
| `GestionRealPort` | `domain/ports/GestionRealPort.ts` | Contrato upstream. |
| `GestionRealClient` | `infrastructure/adapters/gestion-real/GestionRealClient.ts` | Adapter HTTP: auth, transporte, parseo. |
| `SyncGestionRealClients` | `application/use-cases/SyncGestionRealClients.ts` | Sync de clientes (backfill/delta). |
| `SyncGestionRealContracts` | `application/use-cases/SyncGestionRealContracts.ts` | Sync de contratos por cliente. |
| `ClientMirrorRepository` | `domain/ports/ClientMirrorRepository.ts` | Write side (upsert local). |
| `SyncStateRepository` | `domain/ports/SyncStateRepository.ts` | Persistencia del watermark. |
| `GestionRealSyncScheduler` | `infrastructure/scheduling/GestionRealSyncScheduler.ts` | Orquesta el ciclo periódico. |

## Auth: password que rota a diario

GR usa Basic Auth con `username = CUIT` y un password que cambia cada día:

```
password = MD5(CUIT + SECRET + "YYYY-MM-DD")
```

Calculado en `GestionRealClient.auth()` en cada request. El reloj es inyectable
(`opts.now`) para tests deterministas. Todos los métodos son `POST` a la raíz con
un campo `action` (`clientes_consulta`, `contrato`).

## Normalización del payload (rarezas de GR)

- **Clientes** vienen como un **objeto keyed by id**, no array:
  `{ error:0, resultados:"5090", clientes: { "100011": {...} } }`. `resultados` es
  el total (drive de paginación). `parseClientsResponse` lo aplana a `GrClient[]`.
- **Contratos** vienen como **array**: `{ error:"0", contratos: [ ... ] }`.
  `parseContractsResponse` los mapea a `GrContract[]` e inyecta el `grClienteId`
  del padre (GR no lo repite en cada contrato).
- El payload crudo de cada cliente se guarda en `GrClient.raw` y termina en
  `Client.customAttributes`.

## Modo backfill vs delta

El modo se decide por el **watermark** persistido en `SyncState` (entity
`"gr-clients"`):

```
prior.cursor == null  →  backfill   (primer run: scan completo, sin filtro de fecha)
prior.cursor != null  →  delta      (fecha_tipo=m desde el cursor anterior)
```

### Backfill

Scan completo paginado, sin filtro de fecha. Por cada segmento de `estado`
(default `1,2`) pagina desde offset 0 hasta `offset >= total`. `cantidad` topea en
100 (límite de GR).

### Delta (incremental)

Filtra por **fecha de modificación**: `fecha_tipo=m`, `fecha_desde = cursor`
anterior, `fecha_hasta = hoy`. Formato GR de las fechas: `DD-MM-AAAA`.

**Re-scan del último día (intencional):** el delta de GR es de granularidad
**diaria**. Arrancar el `fecha_desde` en el día del último run produce un solapamiento
de un día. Como los upserts son idempotentes, ese overlap garantiza no perder un
cambio del mismo día sin duplicar datos.

## Paginación

Cada segmento de `estado` se pagina **independientemente** desde offset 0. El
`total` se lee de cada respuesta (`resultados`) y es el tope superior:

```
offset += pageSize;
if (clients.length === 0 || offset >= total) break;
```

## Contratos siguen a su dueño (no hay delta global de contratos)

GR no tiene feed de delta para contratos. Solución: el scheduler le pasa a
`SyncGestionRealContracts` el conjunto de `grClienteId` tocados por el sync de
clientes, y los contratos se refrescan **por cliente** (`fetchContractsByClient`).

Optimización en `runOnce` del scheduler:

- **Backfill** → solo se traen contratos de los clientes **recién creados**
  (`createdClientIds`). Traerlos para todos serían miles de llamadas (una por
  cliente).
- **Delta** → el set tocado (`touchedClientIds`) ya es chico (solo los modificados).

## Idempotencia

- `upsertClient` busca por `grClienteId` (`@unique`): existe → update, no existe →
  create. Devuelve `{ created }`.
- `upsertContract` resuelve el padre por `grClienteId`; si el padre no existe,
  no-op (`created:false`) — el client sync siempre corre antes que contratos.
- Correr el mismo run dos veces no duplica filas: la business key externa es la
  llave del upsert.

## Persistencia del watermark y manejo de error

`SyncGestionRealClients.execute()`:

1. Lee `prior = state.get("gr-clients")`.
2. Corre el scan; si **falla a mitad**, guarda el `SyncState` con el cursor
   **anterior** (no avanza el watermark) y `lastResult = "error: ..."`, luego
   re-lanza. Así el próximo run reintenta desde donde estaba.
3. Si termina OK, guarda `cursor = runDate` (hoy) y `lastResult = "ok"`.

## Observabilidad

El use-case `GetGestionRealSyncStatus` (port `MirrorCountsRepository` +
`SyncStateRepository`) expone el estado vía `GET /api/gestion-real/sync/status`
(autenticado): watermark, último resultado, items sincronizados y conteos del
mirror.

## Flujo de un ciclo (scheduler.runOnce)

```
1. syncClients.execute()            → { mode, created, updated, touched/createdClientIds, cursor }
2. contractIds = backfill ? createdClientIds : touchedClientIds
3. syncContracts.execute(contractIds)
4. log resumen; errores se tragan (no matan el timer)
```
