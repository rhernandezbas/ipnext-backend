# Tasks: Finance Growth Dashboard

> Strict TDD (RED→GREEN→REFACTOR). Cada item de use case/route es "test que falla → implementación".
> Adapters fake = `InMemory{Entity}Repository` (NUNCA mockear Prisma). Orden = dependencia de datos
> (Fase 1/2 en paralelo posible, 3 depende de 1+2, 4 depende de 3, 5 depende de 4).

## Fase 1 — Ingest global de cobranza (recibos GR) — REESCRITA tras verificación en vivo (2026-07-26)

> El spike de verificación original (1.0 en la versión previa) quedó RESUELTO por una llamada real a GR: NO
> hace falta ejecutarlo. `cuentas.invoices[]` es SOLO deuda abierta (6/6 clientes activos → 0 facturas) — el
> sync per-client NUNCA iba a servir de fundación de datos. Ver `design.md` Decision 0 para el detalle
> completo. La fundación de datos pasa a ser el ingest global de `recibos` (backfill + delta), y el sync
> per-client `RefreshDebtorBalances` sobrevive con una extensión mínima (estado `4`).
>
> **REESCRITURA 2 (2026-07-26, mismo día) — pacing, decisión LOCK del usuario**: el modelo de "1 mes
> backfilleado por corrida nocturna" quedó DESCARTADO (163 meses de historia ⇒ ~5,4 meses de calendario para
> cobertura completa — inaceptable). Se reemplaza por un goteo continuo con presupuesto de requests
> COMPARTIDO entre dos carriles priorizados (delta con prioridad absoluta, backfill cediendo el turno), UNA
> página GR por turno. Ver `design.md` Decision 4b. Esto agrega una pieza nueva
> (`FinanceReceiptIngestScheduler`) y cambia el contrato de `execute()` de los dos use cases de ingest (antes
> paginaban la unidad completa por corrida; ahora, una sola página). Conteo de Fase 1: 49 → **58 items**.

### Domain — puerto GR extendido + entidades nuevas
- [x] 1.1 `src/domain/entities/gestionReal.ts`: `GrReceipt` (`grReceiptId`, `clienteGrId`, `recaudador`,
  `fechaRecibo`, `fechaConfirmacion`, `fechaAnulacion`, `observaciones`, `applications: GrReceiptApplication[]`)
  y `GrReceiptApplication` (`grApplicationId`, `tipo`, `sucursal`, `numero`, `importe`, `fecha`).
- [x] 1.2 `src/domain/ports/GestionRealPort.ts`: agregar `fetchReceipts(params: FetchReceiptsParams):
  Promise<FetchReceiptsResult>`. `FetchReceiptsParams = {fechaDesde, fechaHasta, cantidad, offset}` (fechas
  SIEMPRE `DD-MM-AAAA`, documentado en el JSDoc del tipo — GR responde HTTP 500 con ISO, verificado en vivo).
- [x] 1.3 `src/domain/ports/FinanceInvoiceTypeClassificationRepository.ts`: interfaz `get`/`upsertIfAbsent`/
  `list`/`updateBucket`.
- [x] 1.4 `src/domain/ports/FinanceReceiptSyncConfigRepository.ts`: interfaz `get`/`update` (molde
  `GestionRealIngestConfigRepository`).
- [x] 1.5 `src/domain/ports/FinancePaymentReceiptRepository.ts`: `upsertBatch(receipts)`, `exists(grReceiptId)`.
- [x] 1.6 `src/domain/ports/FinanceReceiptApplicationRepository.ts`: `upsertBatch(applications)`,
  `listByMonth(yearMonth)`, `listByClientAndMonth(clientGrId, yearMonth)`.

### Test doubles
- [x] 1.7 `src/infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository.ts`.
- [x] 1.8 `src/infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository.ts`.
- [x] 1.9 `src/infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository.ts`,
  `InMemoryFinanceReceiptApplicationRepository.ts`.

### `GestionRealClient.fetchReceipts` — parsing (el seam más delicado del ingest)
- [x] 1.10 RED: la request usa `fecha_desde`/`fecha_hasta` en formato `DD-MM-AAAA` SIEMPRE (test que
  inspecciona el body/query enviado, nunca ISO).
- [x] 1.11 RED: normaliza `aplicaciones` cuando viene como OBJETO keyed-by-id (`Object.entries`, mismo
  criterio ya usado en `parseServiceOrdersResponse`/`clientesObj` de `GestionRealClient.ts`) — 2 fixtures
  (dict y array) deben producir la misma lista normalizada.
- [x] 1.12 RED: normaliza el nodo raíz de la respuesta de `recibos` con el mismo criterio defensivo (dict O
  array) — se confirma cuál es el caso real en el primer sync (pregunta NO-bloqueante #3 del proposal), el
  parser no debe asumir uno solo.
- [x] 1.13 RED: un recibo con `fecha_anulacion` distinto del centinela `"00-00-0000 00:00:00"` se EXCLUYE
  del resultado parseado (ni el recibo ni sus aplicaciones aparecen).
- [x] 1.14 RED: un recibo con `fecha_anulacion` == centinela se incluye normalmente (`anulado: false`).
- [x] 1.15 RED: cada `aplicacion` mapea `grInvoiceId = "{tipo}-{sucursal}-{numero}"` reusando
  `grInvoiceId()`/`parseGrInvoiceDate()` de `mapGrInvoice.ts` (NO reimplementar el parseo de fecha AR).
- [x] 1.16 RED: un recibo con 2+ `aplicaciones` produce 2+ filas normalizadas, todas con el mismo
  `grReceiptId`/`recaudador` de cabecera (relación 1-N verificada en vivo).
- [x] 1.17 GREEN: `fetchReceipts` en `GestionRealClient.ts` (reusa el retry/backoff existente, no lo reimplementa).

### `SyncGrReceiptsBackfillBatch` — REDISEÑADO (2026-07-26, decisión LOCK del usuario, Decision 4b de `design.md`)

> **Cambio de contrato respecto de la versión anterior de este plan**: `execute()` YA NO pagina un mes
> COMPLETO por corrida (eso era el batch nocturno "1 mes/noche" descartado). Ahora procesa **UNA sola página
> GR (`cantidad=100`) por `execute()`** — es lo que permite compartir el presupuesto de requests con el
> carril delta a nivel de tick. Molde de referencia: `BackfillGrContractsBatch`/`ArmGrContractsBackfill`
> para la mecánica de cursor resumible, pero NO su loop `while(true)` interno.

- [x] 1.18 RED: primera corrida (sin cursor en `SyncStateRepository` para `'finance-receipts-backfill'`)
  arranca en el mes calendario actual, offset 0.
- [x] 1.19 RED: `execute()` pagina EXACTAMENTE una página (`cantidad=100`) — test explícito de que NO sigue
  paginando internamente el resto del mes (a diferencia del molde `BackfillGrContractsBatch`/
  `SyncGestionRealContractsDelta`, que sí agotan su unidad en un solo `execute()`).
- [x] 1.20 RED: una página que NO agota el mes (offset + tamaño de página < total reportado por GR) avanza
  el offset persistido pero mantiene `cursorYearMonth` SIN CAMBIOS (sigue en el mismo mes).
- [x] 1.21 RED: la página que SÍ agota el mes (menos de `cantidad` resultados, u offset+tamaño ≥ total)
  avanza el cursor al mes calendario ANTERIOR con offset reseteado a `0` (newest→oldest, nunca al revés).
- [x] 1.22 RED: resumibilidad — un `SyncStateRepository` con cursor `"{yearMonth}:{offset}"` a mitad de un
  mes retoma ESE MISMO mes en ESE MISMO offset tras un "reinicio" simulado, sin reprocesar páginas ya
  persistidas de ese mes.
- [x] 1.23 RED: al llegar a `FinanceReceiptSyncConfig.backfillFloorYearMonth` y completarlo, se marca `done`
  (cursor `null`, `lastResult: 'done'`) y la corrida siguiente es no-op.
- [x] 1.24 RED: por cada aplicación persistida, llama `FinanceInvoiceTypeClassificationRepository.upsertIfAbsent(grType)`
  — un `grType` ya clasificado NO se pisa; uno nuevo se crea con `bucket: 'unclassified'`.
- [x] 1.25 RED: un error de página (timeout tras reintentos agotados de `GestionRealClient`) se cuenta y
  logea; el cursor NO avanza más allá de la última página exitosa (ni offset ni mes).
- [x] 1.26 GREEN: `src/application/use-cases/finance/SyncGrReceiptsBackfillBatch.ts` — `execute()` devuelve
  `{pageProcessed, monthAdvanced, done}` (shape a definir en implementación) para que el scheduler pueda
  loguear/observar sin adivinar el resultado.
- [x] 1.27 REFACTOR.

### `SyncGrReceiptsDelta` — REDISEÑADO (2026-07-26, Decision 4b de `design.md`)

> Mismo cambio de contrato que el backfill: `execute()` procesa **UNA sola página** del rango "hasta hoy"
> pendiente, no el rango completo en un `while(true)` (a diferencia del molde exacto
> `SyncGestionRealContractsDelta`). Esto es lo que le permite al carril delta CEDER el resto de sus páginas
> pendientes tick a tick sin monopolizar el proceso, aunque en la práctica su volumen (~160 recibos/día ≈ 2
> páginas) rara vez necesita más de un par de ticks para ponerse al día.

- [x] 1.28 RED: primera corrida (sin cursor) sincroniza SOLO el día de hoy, offset 0 — NO hace backfill
  histórico (esa es responsabilidad exclusiva de `SyncGrReceiptsBackfillBatch`).
- [x] 1.29 RED: `execute()` pagina EXACTAMENTE una página del rango `fechaDesde..fechaHasta`; si quedan más
  páginas, persiste el cursor COMPUESTO `"{fechaDesde}:{fechaHasta}:{offset}"` (`hasPendingPages` se deriva
  de que el cursor tenga este formato).
- [x] 1.30 RED: al terminar de paginar TODO el rango, el cursor colapsa al formato PLANO `"{fechaHasta}"`
  (mismo formato que `SyncGestionRealContractsDelta`), que la corrida siguiente lee como `fechaDesde` (overlap
  ≥1 día).
- [x] 1.31 RED: upsert idempotente por `grReceiptId`/`grApplicationId` — correr el delta 2 veces seguidas
  (misma página o rango solapado) no duplica filas.
- [x] 1.32 GREEN: `src/application/use-cases/finance/SyncGrReceiptsDelta.ts`.

### `FinanceReceiptIngestScheduler` — árbitro del presupuesto compartido (NUEVO, Decision 4b de `design.md`)

> Infraestructura, no use case (molde `GestionRealSyncScheduler`) — decide a qué carril le toca el turno en
> cada tick y gestiona el backoff adaptativo. Se testea con un reloj/temporizador FALSO inyectable: CERO
> `setTimeout`/`setInterval` reales en estos tests.

- [x] 1.33 RED: si el carril delta tiene `hasPendingPages=true`, el scheduler le da el turno AUNQUE el
  backfill también tenga trabajo pendiente (prioridad absoluta, sin excepción).
- [x] 1.34 RED: si el carril delta NO tiene páginas pendientes y `deltaCheckIntervalMs` todavía NO venció, el
  turno va al carril backfill.
- [x] 1.35 RED: si el carril delta NO tiene páginas pendientes pero `deltaCheckIntervalMs` YA venció, el
  turno vuelve al carril delta (chequeo periódico — "tiempo real", minutos no horas).
- [x] 1.36 RED: un tick fallido (el use case invocado propaga un error, ya agotó los reintentos internos de
  `GestionRealClient`) duplica `effectiveIntervalMs` (acotado por `maxRequestIntervalMs`) e incrementa
  `consecutiveFailures`.
- [x] 1.37 RED: el primer tick exitoso tras una degradación resetea `effectiveIntervalMs = requestIntervalMs`
  y `consecutiveFailures = 0` de inmediato (no gradual).
- [x] 1.38 RED: el scheduler adquiere `DistributedLock` antes de cada tick; si el lock ya está tomado por
  otra réplica, el tick es no-op (no cuenta como fallo, no dispara backoff) — mismo criterio que
  `GestionRealSyncScheduler`.
- [x] 1.39 GREEN: `src/infrastructure/scheduling/FinanceReceiptIngestScheduler.ts`.
- [x] 1.40 REFACTOR.

### `RefreshDebtorBalances` — extensión mínima (estado Incobrable), sin reescritura de fondo
- [x] 1.41 RED: `DEBTOR_LIKE_STATUSES` incluye `'4'` (Incobrable) — un cliente en ese estado se enumera y su
  balance/facturas se persisten, igual que `2/3/6`.
- [x] 1.42 RED: estado `'1'` (Activo) SIGUE sin enumerarse — test explícito de que NO se agregó (verificado
  en vivo que siempre devuelve cero facturas; agregarlo sería puro desperdicio de llamadas GR).
- [x] 1.43 GREEN: editar la constante en `RefreshDebtorBalances.ts` — único cambio a un use case existente
  en toda la Fase 1.

### Config singleton + schema
- [x] 1.44 `prisma/schema.prisma`: `FinanceInvoiceTypeClassification`, `FinanceReceiptSyncConfig`
  (`requestIntervalMs`/`maxRequestIntervalMs`/`deltaCheckIntervalMs`/`backfillFloorYearMonth` — ver Decision
  4b, sin `backfillIntervalMs`/`deltaIntervalMs` de la versión previa), `FinancePaymentReceipt`,
  `FinanceReceiptApplication`.
- [x] 1.45 Migración aditiva `prisma/migrations/*_finance_receipts_foundation/`: crea las 4 tablas + seed
  `FinanceInvoiceTypeClassification{grType:'FB', bucket:'revenue', label:'Factura B'}` + seed
  `FinanceReceiptSyncConfig{id:'singleton', backfillFloorYearMonth:'2013-01'}` (defaults de pacing salen del
  `@default` del schema, no hace falta listarlos en el seed), ambos `ON CONFLICT DO NOTHING`.
  **Sin `BEGIN`/`COMMIT` manual** (Prisma ya envuelve en transacción).
- [x] 1.46 `src/infrastructure/adapters/prisma/PrismaFinanceInvoiceTypeClassificationRepository.ts`,
  `PrismaFinanceReceiptSyncConfigRepository.ts`.
- [x] 1.47 `src/infrastructure/adapters/prisma/PrismaFinancePaymentReceiptRepository.ts`,
  `PrismaFinanceReceiptApplicationRepository.ts` (upsert batch en transacción; usa los índices por
  `clientGrId`/`appliedDate`/`grInvoiceId` ya declarados en el schema).

### Rutas de config del sync + clasificación (lectura/reclasificación admin)
- [x] 1.48 RED (supertest): `GET /api/finance/growth/config/invoice-types` sin `finance:read` → `403`; con
  permiso → `200` con la lista completa incl. `unclassified`.
- [x] 1.49 RED (supertest): `PATCH /api/finance/growth/config/invoice-types/:grType` sin `finance:manage_costs`
  → `403`, sin cambio; con permiso y `bucket` válido → `200`, persiste; con `bucket: 'unclassified'`
  explícito → `400`.
- [x] 1.50 GREEN: rutas montadas en `financeGrowth.routes.ts` (creado en esta fase, se sigue ampliando en
  fases siguientes).
- [x] 1.51 RED (supertest): `POST /api/finance/growth/sync/run` sin `finance:sync` → `403`, nada disparado;
  con permiso → `202 {started:true}` (fuerza al carril delta a correr en el próximo tick disponible, ignorando
  `deltaCheckIntervalMs` — el delta YA tiene prioridad absoluta, así que esto solo salta la espera; el
  backfill NUNCA se acelera manualmente desde acá, corre en su propio ritmo automático dentro del scheduler).
- [x] 1.52 RED (supertest): `GET /api/finance/growth/sync/status` sin `finance:read` → `403`; con permiso →
  `200` con el shape `{pacing, delta, backfill, debtorBalances}` exacto de `design.md` (campo por campo,
  incluye `pacing.effectiveIntervalMs`/`pacing.degraded`/`pacing.activeLane`,
  `delta.pendingPages`/`delta.coveredThroughDate`, `backfill.cursorYearMonth`/`backfill.cursorPageOffset`/
  `backfill.done`).
- [x] 1.53 GREEN: rutas de sync montadas.

### RBAC (catálogo — necesario desde esta fase para poder testear los guards de arriba)
- [x] 1.54 `src/domain/entities/rbac.ts`: agregar `'finance'` a `RBAC_MODULES`; agregar `'manage_costs'`,
  `'manage_targets'`, `'manage_inflation'` a `KNOWN_ACTIONS` (`'sync'` ya existe, se reusa).
- [x] 1.55 RED: test de `rbac.test.ts` (o el archivo de tests de catálogo existente) — `finance` module +
  las 3 acciones nuevas aparecen en el catálogo expuesto por `ListAllPermissionsWithModule`.
- [x] 1.56 Seed/migración del catálogo RBAC (si el repo siembra permisos vía migración — verificar molde de
  `rbac-permission-catalog-extension` antes de escribir; si el catálogo se deriva en runtime de
  `RBAC_MODULES`/`KNOWN_ACTIONS` sin seed de filas, este item se reduce a confirmar que no hace falta).

### Wiring — UN solo bootstrap (reemplaza los 2 bootstraps independientes de la versión previa, Decision 4b)
- [x] 1.57 `src/infrastructure/scheduling/bootstrapFinanceReceiptsIngest.ts` (molde
  `bootstrapGestionRealSync.ts`): construye `FinanceReceiptIngestScheduler` con `SyncGrReceiptsDelta` +
  `SyncGrReceiptsBackfillBatch` + `PgAdvisoryLock` (lock key `finance-receipts-ingest`) y lo arranca
  (`setTimeout` recursivo con `effectiveIntervalMs`, NUNCA `setInterval` fijo). **Actualizado fix-wave-1
  F6**: el gate de `enabled=false` NO vive acá — el scheduler existe siempre que GR esté prendido y relee
  `FinanceReceiptSyncConfig.enabled` en VIVO en cada tick (kill-switch en runtime, sin redeploy).
- [x] 1.58 `app.ts`: wiring del bootstrap + router de Fase 1; RED+GREEN de composition-root test (molde
  `inventory-composition-root.test.ts`) — assert estático de que `app.ts` pasa las dependencias reales (no
  un fixture) a `FinanceReceiptIngestScheduler`.

### fix-wave-2 R1 (2026-07-26) — persistir `items`/`retenciones` por separado, decisión LOCK del usuario (Decision 0c)
- [x] 1.59 `GrReceiptItem`/`GrReceiptRetencion` en `gestionReal.ts`; `GrReceipt.items`/`.retenciones`
  (opcionales, backward-compat con fixtures pre-existentes).
- [x] 1.60 `GestionRealClient.ts`: `parseReceiptItems`/`parseReceiptRetenciones` (mismo idioma dict/array +
  synthetic id F11 que `parseReceiptApplications`); docblock de `fechaRecibo` corregido (date-only, no
  `HH:MM:SS`).
- [x] 1.61 `FinanceReceiptItemRepository`/`FinanceReceiptRetencionRepository` (domain/ports) +
  `InMemory`/`Prisma` adapters.
- [x] 1.62 `mapGrReceipt.ts`: mapea `items`/`retenciones`; `receiptIdentityHolds()` (guardrail
  `SUM(aplicaciones) == SUM(items) + SUM(retenciones)`, WARNING en mismatch, nunca aborta).
- [x] 1.63 `SyncGrReceiptsDelta`/`SyncGrReceiptsBackfillBatch`: persisten `items`/`retenciones` (repos
  opcionales trailing, backward-compat con ~35 call sites de tests pre-existentes) + corren el guardrail de
  identidad por recibo.
- [x] 1.64 Migración aditiva `20261023000200_finance_receipt_items_retenciones`: tablas
  `FinanceReceiptItem`/`FinanceReceiptRetencion`, FK a `FinancePaymentReceipt`, `Decimal(12,2)`.
- [x] 1.65 `bootstrapFinanceReceiptsIngest.ts`: wiring de los 2 repos Prisma nuevos en ambos carriles.
- [x] 1.66 Tests: fixture "payload real" corregido (`importe` string, `fecha_recibo` date-only) +
  seam test "retenciones sin items ⇒ cash 0" + test de identidad — ver fix-wave-2-hallazgos.md R1.
- [x] 1.67 `design.md` (Decision 0/0b/0c + Data Model + Ports) y `spec.md` (Requirement "metric basis")
  actualizados para reflejar el modelo de datos de 3 tablas y la métrica base = cash puro (`items`).

### fix-wave-2 (2026-07-26) — re-review de la ronda 1, R2-R6
- [x] 1.68 R2 — `ForceFinanceDeltaRun`: reemplaza el read-modify-write de la fila completa por
  `SyncStateRepository.clearLastRunAt` (update de UNA columna); presupuesto de lock re-medido (16×100ms).
- [x] 1.69 R3 — `isSchedulerRunning()`/`isEnabled()` consultan el `enabled` LIVE (última lectura de un
  tick) en vez de la mera existencia del objeto scheduler; `POST /sync/run` responde `503` cuando no hay
  tick que vaya a recogerlo.
- [x] 1.70 R4 — salud por-carril (`deltaConsecutiveFailures`/`backfillConsecutiveFailures` separados) para
  que un carril sano no enmascare la degradación sostenida del otro en `/sync/status` ni en el circuit
  breaker F4.
- [x] 1.71 R5 — `readConfigSafely()`: un fallo de lectura de `FinanceReceiptSyncConfig` cae a
  `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` (con backoff propio, `configConsecutiveFailures`) en vez de escapar
  `tick()` sin capturar.
- [x] 1.72 R6 — `RearmFinanceReceiptsBackfill`: update dirigido (`SyncStateRepository.rearmCursor`,
  columnas `cursor`/`lastResult`) + serializado contra el MISMO lock que `tick()`.

### fix-wave-3 (2026-07-26) — re-review de la ronda 2, R7-R10 + LOWs
- [x] 1.73 R7 — `readConfigSafely()`: fallback ASIMÉTRICO — el pacing cae a
  `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS`, pero `enabled` conserva `this.currentEnabled` (último valor REAL
  observado), nunca vuelve a `true` por un fallo de lectura. Cierra el bypass del kill-switch que R5 abrió
  sin querer.
- [x] 1.74 R8 — contador `grConsecutiveFailures` NUEVO, separado de `deltaConsecutiveFailures`/
  `backfillConsecutiveFailures` (R4, sin tocar): `effectiveIntervalMs` deriva SOLO de la salud de GR (fetch)
  + config/lock; el circuit-breaker F4 y `/sync/status` siguen derivando de la salud por-carril. Requiere
  `FinanceReceiptPersistenceError` (`financeIngestErrors.ts`) para que los use cases distingan fallo de
  fetch vs. fallo de persistencia. Decisión documentada en `design.md` Decision 4b.
- [x] 1.75 R9 — `itemRepo`/`retencionRepo` pasan de opcionales-trailing a MANDATORIOS en
  `SyncGrReceiptsDelta`/`SyncGrReceiptsBackfillBatch` (constructor lanza si faltan, mismo criterio F13);
  ~35 call sites de test actualizados; composition-root test nuevo pineando el wiring de
  `bootstrapFinanceReceiptsIngest.ts` (no sólo `app.ts`/`main.ts`).
- [x] 1.76 R10 — `ForceFinanceDeltaRun`: procede SIN lock si el presupuesto se agota (best-effort real, la
  escritura ya es segura por construcción desde R2). `RearmFinanceReceiptsBackfill`: presupuesto de lock
  re-medido (40×100ms, hold real ~2-3s) + `FinanceSyncLockBusyError` (`domain/errors/finance.ts`) mapeado a
  `503 Retry-After` en `errorHandler.ts` en vez de `500` genérico.
- [x] 1.77 LOWs: fixture con `items`/`retenciones` EXPLÍCITAMENTE `null` (no sólo ausentes) en
  `GestionRealClient.receipts.test.ts`; nota de código muerto confirmado en la rama array de
  `parseReceiptsResponse`; `FinanceReceiptItemRepository.listByMonth`/`listByClientAndMonth` +
  `@@index([fecha])` (migración `20261023000400`) para cerrar la asimetría de read-path con
  `FinanceReceiptApplicationRepository`; docs stale corregidos (`app.ts`, `SyncStateRepository.ts`
  `rearmCursor`, este archivo).

## Fase 2 — Configuración (settables)

### Domain
- [x] 2.1 `src/domain/ports/FinanceTechnologyCostRepository.ts`: `list`/`getByTechnology`/`upsert`.
- [x] 2.2 `src/domain/ports/FinancePlanPriceRepository.ts`: `list`/`getByPlanCode`/`upsert`.
- [x] 2.3 `src/domain/ports/FinanceTargetsConfigRepository.ts`: `get`/`update`.
- [x] 2.4 `src/domain/ports/FinanceInflationIndexRepository.ts`: `list(fromYearMonth?, toYearMonth?)`/`upsert`.

### Test doubles
- [x] 2.5 `InMemoryFinanceTechnologyCostRepository.ts`, `InMemoryFinancePlanPriceRepository.ts`,
  `InMemoryFinanceTargetsConfigRepository.ts`, `InMemoryFinanceInflationIndexRepository.ts`.

### `FinanceTechnologyCost` — CRUD
- [x] 2.6 RED: `GetFinanceTechnologyCosts` — LEFT JOIN contra `ContractTechnologyRepository.list()`, una
  tecnología sin fila configurada aparece con todos los costos en `0` (no se omite).
- [x] 2.7 GREEN: `src/application/use-cases/finance/GetFinanceTechnologyCosts.ts`.
- [x] 2.8 RED: `UpdateFinanceTechnologyCost` rechaza `costoInstalacionArs < 0` sin persistir ningún campo
  (ni los válidos del mismo payload).
- [x] 2.9 RED: `UpdateFinanceTechnologyCost` rechaza `comisionVentaPct > 100`.
- [x] 2.10 RED: payload completo y válido → upsert exitoso, `updatedByUserId` seteado desde el actor.
- [x] 2.11 GREEN: `src/application/use-cases/finance/UpdateFinanceTechnologyCost.ts`.
- [x] 2.12 RED (supertest): `GET /api/finance/growth/config/technology-costs` sin `finance:read` → `403`.
- [x] 2.13 RED (supertest): `PUT /api/finance/growth/config/technology-costs/:technologyName` sin
  `finance:manage_costs` → `403`, sin cambio; con permiso y payload inválido → `400` sin cambio; con
  payload válido → `200` y un `GET` posterior refleja el cambio.
- [x] 2.14 GREEN: rutas montadas.

### `FinancePlanPrice` — CRUD
- [x] 2.15 RED: `GetFinancePlanPrices` — LEFT JOIN contra `PlanRepository.list()`, plan sin precio
  configurado aparece con `estimatedMonthlyPrice: 0`.
- [x] 2.16 GREEN: `src/application/use-cases/finance/GetFinancePlanPrices.ts`.
- [x] 2.17 RED: `UpdateFinancePlanPrice` rechaza valor negativo sin persistir.
- [x] 2.18 GREEN: `src/application/use-cases/finance/UpdateFinancePlanPrice.ts`.
- [x] 2.19 RED (supertest): `GET`/`PUT /api/finance/growth/config/plan-prices[/:planCode]` — mismos 2
  caminos de permiso que 2.12/2.13, adaptados a `finance:manage_costs`.
- [x] 2.20 GREEN: rutas montadas.

### `FinanceTargetsConfig` — singleton
- [x] 2.21 RED: `GetFinanceTargets` devuelve los defaults seedeados si nunca se editó.
- [x] 2.22 GREEN: `src/application/use-cases/finance/GetFinanceTargets.ts`.
- [x] 2.23 RED: `UpdateFinanceTargets` rechaza `churnTargetPct` fuera de `0-100`, o `inflationBaseYearMonth`
  con formato inválido (ni `""` ni `YYYY-MM`), sin actualización parcial.
- [x] 2.24 RED: payload completo válido → persiste los 4 campos.
- [x] 2.25 GREEN: `src/application/use-cases/finance/UpdateFinanceTargets.ts`.
- [x] 2.26 RED (supertest): `GET`/`PUT /api/finance/growth/config/targets` con guard `finance:read`/
  `finance:manage_targets` respectivamente (caminos con/sin permiso, molde 2.13).
- [x] 2.27 GREEN: rutas montadas.

### `FinanceInflationIndex` — serie mensual
- [x] 2.28 RED: `ListFinanceInflationIndex` filtra por rango `from`/`to`, ordenado ascendente por `yearMonth`.
- [x] 2.29 GREEN: `src/application/use-cases/finance/ListFinanceInflationIndex.ts`.
- [x] 2.30 RED: `UpdateFinanceInflationIndex` rechaza `yearMonth` con formato inválido en el path, y
  `monthlyRatePct` no numérico, sin persistir.
- [x] 2.31 GREEN: `src/application/use-cases/finance/UpdateFinanceInflationIndex.ts`.
- [x] 2.32 RED (supertest): `GET`/`PUT /api/finance/growth/config/inflation[/:yearMonth]` con guard
  `finance:read`/`finance:manage_inflation` (acción separada de `manage_costs` — test explícito de que
  `manage_costs` SOLO no alcanza para editar inflación).
- [x] 2.33 GREEN: rutas montadas.

### Schema + migración
- [x] 2.34 `prisma/schema.prisma`: `FinanceTechnologyCost`, `FinancePlanPrice`, `FinanceTargetsConfig`,
  `FinanceInflationIndex`.
- [x] 2.35 Migración aditiva `prisma/migrations/*_finance_growth_config/`: crea las 4 tablas + seed
  `FinanceTargetsConfig{id:'singleton'}` (`ON CONFLICT DO NOTHING`). Sin `BEGIN`/`COMMIT` manual.
- [x] 2.36 `Prisma{FinanceTechnologyCost,FinancePlanPrice,FinanceTargetsConfig,FinanceInflationIndex}Repository.ts`.

### fix-wave-1 (2026-07-26) — 2 revisores adversariales (uno con mutation testing real), 4 🟡, 0 🔴
- [x] D — `UpdateFinanceTechnologyCost`/`UpdateFinancePlanPrice` ahora chequean existencia contra el catálogo
  (`ContractTechnologyRepository.getByName`/`PlanRepository.findByCode`) ANTES de upsertear → `404
  FINANCE_TECHNOLOGY_NOT_FOUND`/`FINANCE_PLAN_NOT_FOUND` si no existe, en vez de crear un huérfano invisible
  para el `GET` (LEFT JOIN driveado por el catálogo). Upsert usa el nombre/código CANÓNICO del catálogo.
  Huérfanos pre-existentes y la falta de propagación de un rename documentados como deuda (f)/(f bis) arriba.
- [x] C — `financeGrowth.routes.test.ts`: nuevas assertions sobre `updatedByUserId` vía el repo in-memory en
  los 2 endpoints con actor (cierra mutación M3, verificado reproduciendo la mutación y viéndola fallar).
- [x] B — `GET /config/inflation` valida `from`/`to` con `isValidYearMonth` (400 si inválidos) + test con
  query string real que verifica el filtro (cierra mutación M2, verificado igual que C).
- [x] A — cotas de precisión/escala derivadas del schema (`Decimal(12,2)`/`Decimal(6,3)`/`Decimal(5,2)`/`Int`
  32-bit) en los 4 `Update*`, vía `src/application/use-cases/finance/financeDecimal.ts`
  (`assertDecimalBounds`/`assertInt32Range`/`roundToScale`). El redondeo explícito a la escala de columna
  ANTES de persistir hace que el doble in-memory y Prisma/Postgres coincidan en el valor observable.
- [x] LOW E — `GetFinancePlanPrices` ordena por `planCode` (natural sort) — el port no garantiza orden.
- [x] LOW F — `PUT /config/plan-prices/:planCode` incluye `planName` en la respuesta (gratis: el use case ya
  lo resuelve para el guard D).
- [x] LOW G — test de payload parcial en `PUT /config/targets` (protege el invariante de reemplazo total).
- [ ] LOW H/I y el hueco estructural de cobertura de los 4 adapters Prisma: documentados como deuda, no
  cerrados esta ronda (ver "Deuda declarada, fix-wave-1 (Fase 2)" en design.md).

## Fase 3 — Motor de métricas (snapshots nocturnos)

> Depende de Fase 1 (ingest de recibos operando — el bridge se puede empezar a testear con fixtures desde el
> día 1, no hace falta esperar al backfill completo, ver `design.md` Decision 4) + Fase 2 (costos/precios/
> targets/IPC configurables).

### Domain
- [x] 3.1 `src/domain/ports/FinanceMonthlySnapshotRepository.ts`: `get`/`listRange`/`upsert`.
- [x] 3.2 `src/domain/ports/FinanceCohortSnapshotRepository.ts`: `listByCohort`/`upsert`.
- [x] 3.3 `InMemoryFinanceMonthlySnapshotRepository.ts`, `InMemoryFinanceCohortSnapshotRepository.ts`.

### Atribución cobranza→contrato (el seam más crítico del change — Decision 1 del design)
- [x] 3.4 RED: cliente con 1 contrato activo en el mes → `attributionConfidence: 'exact'`, monto = cobranza
  neteada completa del mes (`FinanceReceiptApplication` del cliente, netada por `FinanceInvoiceTypeClassification`).
- [x] 3.5 RED: cliente con 2 contratos, ambos planes con fila en `FinancePlanPrice` → reparto proporcional,
  `attributionConfidence: 'estimated'`, la suma de ambos reparto = cobranza neteada (sin perder centavos por
  redondeo — test explícito de esa invariante).
- [x] 3.6 RED: cliente con 2 contratos, NINGÚN plan con fila en `FinancePlanPrice` → reparto igual,
  `attributionConfidence: 'estimated-equal'`.
- [x] 3.7 RED: cliente con 2 contratos, SOLO UNO de los planes con fila en `FinancePlanPrice` → definir y
  testear el criterio exacto (recomendado: tratar el plan sin precio configurado como peso proporcional 0,
  documentado en el código — si ambos terminan en 0, cae a `estimated-equal`).
- [x] 3.8 GREEN: función pura `attributeCollectedAmountToContracts(applications, contracts, planPrices)` en
  `src/application/use-cases/finance/` (no un use case en sí, un helper reusado por 3.9 y por `ComputeCacAndPayback`).

### Neteo de tipos de comprobante
- [x] 3.9 RED: aplicación `revenue` suma, `contra` resta, `excluded` se ignora, `unclassified` se excluye de
  la cobranza pero suma a `unclassifiedAmountArs` — fixtures de `FinanceReceiptApplication`, no de `Invoice`.
- [x] 3.10 GREEN: función pura `netCollectedAmountForMonth(applications, classifications)`.
- [x] 3.11 RED: un cliente cuyo `clientGrId` no resuelve a ningún `Client` local (orphan — recibo llegó antes
  que el mirror del cliente) se cuenta y logea, NUNCA aborta el cómputo del mes (mismo criterio de
  resiliencia que el "orphan guard" de `SyncGestionRealContractsDelta`).

### `BuildFinanceMonthlySnapshot`
- [x] 3.12 RED: un mes con 1 activación, MRR atribuido conocido → `mrrNewArs` = ese MRR, resto del bridge en 0.
- [x] 3.13 RED: un mes con 1 upgrade (dirección derivada con el MISMO criterio que
  `ListInternetServiceHistory.deriveDirection` — reusar esa función, no reimplementarla) → delta de MRR en
  `mrrUpgradeArs`.
- [x] 3.14 RED: un mes con 1 downgrade → delta de MRR en `mrrDowngradeArs`.
- [x] 3.15 RED: un mes con 1 baja → MRR atribuido del contrato en `mrrChurnArs`.
- [x] 3.16 RED: invariante del bridge — `mrrInicialArs + mrrNewArs + mrrUpgradeArs - mrrDowngradeArs -
  mrrChurnArs == mrrFinalArs` (tolerancia de redondeo ≤1) para un mes con los 4 tipos de evento combinados.
- [x] 3.17 RED: `churnContractsPct`/`churnRevenuePct` calculados correctamente contra un fixture con pesos de
  MRR distintos por contrato dado de baja (test que prueba explícitamente que revenue-churn NO es un simple
  conteo — mismo escenario del spec).
- [x] 3.18 RED: `attributionPct` = MRR `exact` / MRR total, con fixture mixto `exact`+`estimated`.
- [x] 3.19 GREEN: `src/application/use-cases/finance/BuildFinanceMonthlySnapshot.ts`.
- [x] 3.20 REFACTOR.

### `BuildFinanceCohortSnapshot`
- [x] 3.21 RED: cohorte de N altas en un mes → `survivingCount` a 3 meses cuenta correctamente los
  contratos SIN evento `deactivated` antes de esa fecha de corte.
- [x] 3.22 RED: cohorte más joven que 12 meses → NO genera fila `monthsElapsed: 12` (no inventa el dato).
- [x] 3.23 GREEN: `src/application/use-cases/finance/BuildFinanceCohortSnapshot.ts`.

### Schema + migración
- [x] 3.24 `prisma/schema.prisma`: `FinanceMonthlySnapshot`, `FinanceCohortSnapshot`.
- [x] 3.25 Migración aditiva `prisma/migrations/*_finance_growth_snapshots/`.
- [x] 3.26 `PrismaFinanceMonthlySnapshotRepository.ts`, `PrismaFinanceCohortSnapshotRepository.ts`.

### Wiring nocturno
- [x] 3.27 `src/infrastructure/scheduling/bootstrapFinanceSnapshotJob.ts`: corre de madrugada (offset de
  horario documentado en `design.md`), leyendo lo que el carril delta (continuo, Decision 4b) ya haya
  cubierto a esa hora; `.unref()`. No depende del progreso del backfill.
- [x] 3.28 `app.ts`: wiring del job; actualizar el composition-root test de Fase 1 (1.58) para incluir este
  segundo job (el bootstrap de ingest de Fase 1 ya es uno solo, ver 1.57-1.58).

### fix-wave-2 (2026-07-27) — resolver el gap de plan-code que el rework MRR-contratado dejó abierto
El rework de `BuildFinanceMonthlySnapshot` (MRR contratado, ver design.md Decision 1) derivaba el plan
EXCLUSIVAMENTE de eventos `'modified'` de `ContractServiceEvent`, dejando `planCode: null` de por vida a todo
contrato que nunca cambió de plan — la mayoría de los contratos estables en producción. Se cerró usando
`PppoeService.profile` (fuente verificada: `ChangePppoePlanService` escribe el mismo valor ahí y en
`oldPlan`/`newPlan`) con rebobinado vía `'modified'` para fechas pasadas.
- [x] RED→GREEN: `contractLifecycle.resolvedPlanCodeAt` (rewind desde `PppoeService.profile`) —
  `src/__tests__/application/finance/contractLifecycle.test.ts`.
- [x] RED→GREEN: nuevo port `PppoeServiceRepository.findCurrentProfilesByContractIds` (batch, nunca N+1),
  tie-break compartido `pickCurrentPppoeService` (domain) usado IDÉNTICO por el adapter Prisma y el in-memory —
  `src/__tests__/infrastructure/PrismaPppoeServiceRepository.findCurrentProfilesByContractIds.test.ts`,
  `src/__tests__/infrastructure/InMemoryPppoeServiceRepository.test.ts`.
- [x] RED→GREEN: `BuildFinanceMonthlySnapshot` wireado con el nuevo repo; casos de enforcement (corte por mora
  NO zerea el MRR — `profile` nunca se pisa al cortar), multi-servicio/desasociado, y "sin PPPoE" (sigue
  `unpriced` visible) — `src/__tests__/application/finance/BuildFinanceMonthlySnapshot.test.ts`.
- [x] Bridge de 9 movimientos re-verificado: sigue cerrando EXACTO al centavo con la nueva resolución.
- [x] `design.md`/`spec.md` actualizados con la evidencia y las 3 decisiones (enforcement, multi-servicio,
  sin PPPoE).

### fix-wave-3 (2026-07-27) — re-review CON ARITMÉTICA VERIFICADA (escenarios ejecutados contra el código
real, no sólo leídos): 2 🔴 bloqueantes + 3 acotados
- [x] RED→GREEN 🔴1: el loop de PLATA (`mrrUpgradeArs`/`mrrDowngradeArs`) no excluía planes de enforcement
  (`IP-REDUCCION`/`IP-BAJA`) — el de conteos (`deriveDirection`) y `resolvedPlanCodeAt` sí. Guard
  `isEnforcementPlan` agregado, contado en el campo nuevo `enforcementPlanChangeEventsExcluded` (nunca en
  silencio) — `src/__tests__/application/finance/BuildFinanceMonthlySnapshot.test.ts` (describe "fix-wave-3
  🔴 1"), reproduce los 4 escenarios medidos por la review (IP-REDUCCION priceada, IP-BAJA, baja mismo mes con
  doble conteo, N reducciones escaladas).
- [x] RED→GREEN 🔴2: `collectionRatePct` mezclaba `revenueTotalArs` (Capa A, TODO el universo) sobre
  `mrrFinalArs` (sólo internet) — podía superar 100%. Numerador corregido a `revenueInternetAttributedArs`
  (misma población que el denominador) — `BuildFinanceMonthlySnapshot.test.ts` (describe "fix-wave-3 🔴 2"),
  reproduce el caso medido (contrato de internet + cliente TV-only, 500% → 100%).
- [x] RED→GREEN 🟡3: resultado no reproducible entre corridas — `PrismaPppoeServiceRepository
  .findCurrentProfilesByContractIds` sin `orderBy` + `pickCurrentPppoeService` sin desempate final por `id`
  ante un empate genuino de `createdAt`. Desempate por `id` agregado al helper de dominio (compartido por
  ambos adapters, generalizado a `Pick<PppoeService,'status'|'createdAt'|'id'>`) + `orderBy` en el adapter
  Prisma — `src/__tests__/infrastructure/PrismaPppoeServiceRepository.findCurrentProfilesByContractIds.test.ts`.
- [x] RED→GREEN 🟡4: el residuo del bridge no tenía señal cuando no cerraba. Campo nuevo `bridgeResidualArs`
  (snapshot + DTO), `0` en el caso sano (asertado en el test de los 9 movimientos), valor real del hueco en
  cualquier otro caso — identidad ahora asertada en el test F2/C1 de precio irresoluble que antes montaba el
  caso sin verificarla. Migración aditiva `20261024000300_finance_snapshot_bridge_residual_enforcement`.
- [x] RED→GREEN 🔵5a: `BackfillFinanceMonthlySnapshots` sin techo temporal hacia adelante — guard `to <= mes
  actual` (reloj inyectable) agregado — `src/__tests__/application/finance/BackfillFinanceMonthlySnapshots.test.ts`.
- [x] RED→GREEN 🔵5b: `findCurrentProfilesByContractIds` traía `password` de TODOS los PPPoE a memoria sin
  `select` — proyección restringida a `{id, contractId, profile, status, createdAt}` (mismo fix que 🟡3, mismo
  método).
- [x] `design.md`/`spec.md` actualizados: sección "Deuda declarada — fix-wave-3" en design.md, requirements
  corregidos en spec.md (collection rate, enforcement en el bridge de plata, bridgeResidualArs, alcance del
  Requirement "Contract-modification listing...", guard del backfill), tabla de dependencias de
  `BuildFinanceMonthlySnapshot` corregida (faltaba `PppoeServiceRepository`).
- [ ] **BLOQUEADO — decisión pendiente del usuario, NO ejecutar sin ella**: backfill histórico masivo de
  `FinanceMonthlySnapshot` hacia meses viejos (más allá de una ventana reciente con precios representativos).
  `FinancePlanPrice` no tiene historia de precios — el MRR contratado histórico valuado a precios de HOY es
  ficción (medido: mismo contrato, mismo plan, `mrrFinalArs` idéntico en 2019 y 2026 pese a que el precio real
  de 2019 era ~60x menor). Ver design.md "Deuda declarada — fix-wave-3" y spec.md Requirement "Monthly
  snapshots must be backfillable on demand..." para las 3 opciones sobre la mesa — ninguna implementada.
- [ ] Documentado, no arreglado: riesgo de `TransferPppoe` sobre meses pasados de un contrato DESTINO con
  historia propia (ver design.md); multi-PPPoE por contrato — el desempate elige un ganador, no suma
  (subvalúa el MRR de un contrato multi-servicio; ver design.md).

## Fase 4 — API de lectura

### `GetFinanceOverview` (deflactación en lectura — Decision 4/6 del design)
- [x] 4.1 RED: rango de meses todos con IPC cargado → serie real calculada correctamente con el
  encadenamiento desde `inflationBaseYearMonth` (test con valores conocidos a mano, verificar la fórmula
  exacta del design).
- [x] 4.2 RED: un mes SIN IPC dentro del rango → la serie real se trunca ahí (fix-wave-4: expuesto vía
  `realSeriesMissingMonths: string[]`, no un único `realSeriesTruncatedAt` — ver fix-wave-4 abajo), la
  serie nominal sigue completa para todo el rango.
- [x] 4.3 RED: `inflationBaseYearMonth` sin configurar (`""`) → toda la serie real es `null`,
  `realSeriesMissingMonths` = TODOS los meses del rango pedido (no crashea, no inventa una base).
- [x] 4.4 GREEN: `src/application/use-cases/finance/GetFinanceOverview.ts`.
- [x] 4.5 RED (supertest): `GET /api/finance/growth/overview` sin `finance:read` → `403`; con permiso → `200`
  con el shape exacto del contrato HTTP (test campo por campo, no solo `toMatchObject` parcial), incluyendo
  `metricBasis: 'cash_collected'` — el test que previene que alguien lo interprete como facturación emitida.
- [x] 4.6 GREEN: ruta montada.

### `GetFinanceCohorts`
- [x] 4.7 RED+GREEN: use case + ruta `GET /cohorts`, guard `finance:read`, shape campo por campo.

### `ComputeCacAndPayback`
- [x] 4.8 RED: payback dentro del umbral → `lossMaking: false`.
- [x] 4.9 RED: payback por encima de `maxPaybackMonths` → `lossMaking: true`.
- [x] 4.10 RED: `mrrAtribuidoArs: 0` → `paybackMonths: null` (no divide por cero, no devuelve `Infinity`).
- [x] 4.11 GREEN: use case + ruta `GET /cac`, guard `finance:read`.

### `RankEarlyChurnByVendor`
- [x] 4.12 RED: vendedor con alto volumen pero alto churn temprano se distingue del vendedor con altas
  sanas. **fix-wave-4 🔵14: el fixture original (50 altas/30 churn vs 20 altas/1 churn) NO discriminaba** —
  A ganaba por volumen Y por tasa; reescrito con el caso discriminante (A: 10 altas/8 churn=80% vs B: 50
  altas/5 churn=10% — A gana por tasa a pesar de 5x menos altas).
- [x] 4.13 RED: ordenamiento DESC por `earlyChurnPct`, no por `altasTotal` (mismo fixture discriminante de 4.12).
- [x] 4.14 GREEN: use case + ruta `GET /vendors/early-churn`, guard `finance:read`.

### `RankNetGrowthByNode`
- [x] 4.15 RED: nodo con más bajas que altas → `netGrowth` negativo; contratos sin nodo asignado se agrupan
  bajo `networkSiteId: null` (no se pierden ni rompen el agregado).
- [x] 4.16 GREEN: use case + ruta `GET /nodes/growth`, guard `finance:read`.

### `RankCancellationReasonsByLostRevenue`
- [x] 4.17 RED: motivo con menos bajas pero mayor MRR perdido queda primero en el ranking (fixture del
  escenario del spec — "mudanza" vs "precio").
- [x] 4.18 RED: `Contract.motivoBaja` null → cae a `ContractServiceEvent.reason`; ambos null → agrupa bajo
  `"sin especificar"`.
- [x] 4.19 GREEN: use case + ruta `GET /motivos-baja`, guard `finance:read`.

### Passthrough de modificaciones de contrato
- [x] 4.20 Confirmar el mount actual de `ListInternetServiceHistory` (path real en `app.ts`) y documentar en
  `design.md`/FE el endpoint exacto a consumir — SIN crear una ruta nueva ni duplicar el use case. Confirmado
  fix-wave-4: monta en `GET /api/pppoe/activation-history` bajo el guard `pppoe:read` (NO `finance:read`) —
  documentado como la única excepción de guard en design.md, sin cambio de comportamiento (decisión de
  producto pendiente para Fase 5).

### fix-wave-4 (2026-07-27) — re-review CON ARITMÉTICA VERIFICADA de la Fase 4 completa: 4 🔴 + 9 🟡, todos
cerrados + los 🔵 baratos (14, 14b, 15, 16, 17)
- [x] RED→GREEN 🔴1: `realSeriesTruncatedAt` (un solo mes) no podía describir un hueco no-contiguo en ambas
  direcciones desde `base`. Reemplazado por `realSeriesMissingMonths: string[]` (BREAKING) —
  `buildChainedIndex` simplificado (ya no calcula ningún marcador de truncamiento, el `Map` de índices es la
  única fuente de verdad), `GetFinanceOverview` deriva la lista de `allMonths.filter(m =>
  !chainedIndexByMonth.has(m))`. Cierra 🟡13 gratis (un hueco antes de `from` ya no puede filtrarse como
  coordenada fuera de rango). Tests: `financeInflation.test.ts`, `GetFinanceOverview.test.ts` (describe
  "fix-wave-4 🔴1"/"🟡13"), `financeGrowth.routes.test.ts`.
- [x] RED→GREEN 🔴2 + 🟡6: `GET /cac` perdía en silencio las altas con `technology: null` (la MAYORÍA de los
  contratos derivados de GR) de TODAS las tecnologías. Campo nuevo `altasDelMesSinTecnologia: number`
  (BREAKING) + match de tecnología case-insensitive (antes case-sensitive pese a que el catálogo ya resuelve
  case-insensitive). Tests: `ComputeCacAndPayback.test.ts` (describe "fix-wave-4 🔴2"/"🟡6").
- [x] RED→GREEN 🔴3: `GET /motivos-baja` colapsaba a `mrrPerdidoArs: 0` en TODAS las filas cuando
  `FinancePlanPrice` está vacía (medido: estado real de prod, 387/387 sin precio) — el ranking por plata
  perdía su razón de ser sin señal. Campo nuevo `bajasSinPrecio: number` POR MOTIVO (BREAKING). Tests:
  `RankCancellationReasonsByLostRevenue.test.ts` (describe "fix-wave-4 🔴3").
- [x] RED→GREEN 🔴4: la ventana "temprano" se medía desde el 1° del mes calendario de la alta, no desde la
  alta real — subestimaba sistemáticamente el churn de vendedores que cierran a fin de mes. Función nueva
  `addCalendarMonthsToDate` (`financeDates.ts`, con clamp de día long→short mes) reemplaza
  `addMonthsToYearMonth(arYearMonth(...))`. Sin cambio de forma. Tests: `financeDates.test.ts`,
  `RankEarlyChurnByVendor.test.ts` (describe "fix-wave-4 🔴4").
- [x] RED→GREEN 🟡5: altas inmaduras diluían `earlyChurnPct` al contar en el denominador `altasTotal`. Campo
  nuevo `altasMaduras: number` (BREAKING) como denominador REAL (madura = ventana cerrada O ya churneó
  temprano); `earlyChurnPct: number` → `number | null` (BREAKING, `null` sin altas maduras). Tests:
  `RankEarlyChurnByVendor.test.ts` (describe "fix-wave-4 🟡5").
- [x] RED→GREEN 🟡7: `costConfigured: true` no distinguía "cargado" de "fila en cero" (las 3 columnas de
  `FinanceTechnologyCost` son `@default(0)`). Campo nuevo `costIsZero: boolean` (BREAKING). Tests:
  `ComputeCacAndPayback.test.ts` (describe "fix-wave-4 🟡7").
- [x] RED→GREEN 🟡8: `activated`+`reactivated` del mismo contrato se contaban DOS VECES en
  `RankEarlyChurnByVendor`/`RankNetGrowthByNode` (`ComputeCacAndPayback` ya deduplicaba). Dedup por
  `contractId` replicado en los 3. Sin cambio de forma. Tests: `RankEarlyChurnByVendor.test.ts`,
  `RankNetGrowthByNode.test.ts` (describe "fix-wave-4 🟡8").
- [x] RED→GREEN 🟡9: `GET /cohorts` devolvía `[]` mudo (estado real de prod: el backfill nunca corrió) sin
  distinguir "no computado" de "no hubo altas". Campo nuevo `monthsWithoutCohortSnapshot: string[]`
  (BREAKING), mismo patrón que `/overview`. Tests: `GetFinanceCohorts.test.ts` (describe "fix-wave-4 🟡9").
- [x] RED→GREEN 🟡10: `motivos-baja` no normalizaba (`"Contrato"`/`"  Contrato  "`, `"Precio"`/`"precio"`
  partían la plata en dos filas). Agrupado por `trim().toLowerCase()`, conserva el primer casing como
  display. Sin cambio de forma. Tests: `RankCancellationReasonsByLostRevenue.test.ts` (describe "fix-wave-4
  🟡10").
- [x] RED→GREEN 🟡11: el `||` del vendedor no manejaba whitespace-only (`"   "` abría su propio bucket).
  `.trim()` antes del `||`. Sin cambio de forma. Tests: `RankEarlyChurnByVendor.test.ts` (describe "fix-wave-4
  🟡11").
- [x] RED→GREEN 🟡12: `monthlyRatePct <= -100` rompía `buildChainedIndex` (`chainedIndex: 0` →
  `mrrFinalRealArs: Infinity`, sólo "sobrevivía" como `null` en JSON por accidente de
  `JSON.stringify(Infinity)`). Guard de una línea en `UpdateFinanceInflationIndex`. Tests:
  `UpdateFinanceInflationIndex.test.ts` (describe "B: rejects monthlyRatePct <= -100").
- [x] RED→GREEN 🔵14: test tautológico de `RankEarlyChurnByVendor` (4.12/4.13, ver arriba) reescrito con
  fixture discriminante.
- [x] RED→GREEN 🔵14b: cobertura de contrato en tests de ruta — `/vendors/early-churn`, `/nodes/growth`,
  `/motivos-baja` sólo tenían wire tests con `[]`; agregado un test no-vacío por endpoint con `toEqual`
  exacto sobre la fila. `/overview` agregó un test dedicado de `churnRevenuePct: null` sobreviviendo a HTTP
  sin coerción (el test viejo fijaba `0`, que un `?? 0` hubiera dejado pasar igual).
- [x] RED→GREEN 🔵15: `maxPaybackMonths: 0` sin guard de `>= 1` — `UpdateFinanceTargets` ahora exige `>= 1`.
  Tests: `UpdateFinanceTargets.test.ts` (describe "🔵15").
- [x] RED→GREEN 🔵16: empates sin desempate determinístico en los 3 rankings — desempate secundario ASC por
  `vendedor`/`networkSiteId` (nulls al final)/`motivo` agregado a los 3. Tests: `RankNetGrowthByNode.test.ts`,
  `RankCancellationReasonsByLostRevenue.test.ts` (describe "fix-wave-4 🔵16"; el de vendors ya lo cubre el
  fixture discriminante de 🔵14).
- [x] RED→GREEN 🔵17: sin límite de ancho de rango — `assertYearMonthRangeWidth` (`financeDates.ts`, cap 240
  meses) agregado a los 5 endpoints de lectura. Tests: `financeDates.test.ts` +
  un test por use case (describe "fix-wave-4 🔵17").
- [ ] Documentado, NO arreglado: 🔵18 (`pct: 0` en vez de `null` para una cohorte con `originalCount: 0` —
  requeriría volver `CohortSurvivalPoint.pct` nullable, deuda de bajo riesgo, ver design.md) y el guard
  asimétrico `pppoe:read` del passthrough de `/contract-changes` (ver 4.20 arriba y design.md).
- [x] `design.md`/`spec.md` actualizados: sección "fix-wave-4" en design.md (HTTP Contract campo por campo +
  changelog), Requirements de spec.md actualizados con los escenarios de cada 🔴/🟡ranking + el fixture
  discriminante de early-churn.
- [x] Gate: `npx tsc --noEmit` (0 errores) + `npx jest` (suite completa) verdes tras el fix wave.

## Fase 5 — FE (sección nueva)

> Skills obligatorias durante esta fase: `ui-ux-pro-max` (diseño estático, tokens, layout) y las skills de
> motion de Emil Kowalski (micro-interacciones de las transiciones nominal↔real y de los estados de carga)
> — invocarlas ANTES de escribir componentes, no como revisión posterior.

- [ ] 5.1 Sidebar: ítem nuevo "Crecimiento Financiero" (o el nombre que confirme el usuario — pregunta
  abierta NO-bloqueante #3), fuera del grupo "Finanzas" existente, oculto sin `finance.read`.
- [ ] 5.2 Hook `useFinanceOverview.ts` (TanStack Query) consumiendo `GET /overview`; 4 estados
  (loading/empty/error/success) explícitos.
- [ ] 5.3 Página overview: KPI tiles + gráfico bridge (waterfall) + toggle nominal/real con mensaje visible
  cuando `realSeriesTruncatedAt` no es null.
- [ ] 5.4 Hook + página de cohortes: heatmap/matriz de supervivencia 3/6/12.
- [ ] 5.5 Hook + página de CAC/payback: tabla de altas del mes con columna `lossMaking` resaltada.
- [ ] 5.6 Hook + página de ranking vendedor: `earlyChurnPct` como columna primaria (jerarquía visual
  invertida respecto de un ranking de ventas tradicional).
- [ ] 5.7 Hook + página de crecimiento por nodo: lista/mapa con los nodos de `netGrowth` negativo
  destacados.
- [ ] 5.8 Hook + página de motivos de baja: tabla ordenada por `mrrPerdidoArs`.
- [ ] 5.9 Página de settings — costos por tecnología: tabla editable, `Select` propio para elegir tecnología
  (NO `<select>` nativo), validación de formulario espejando las reglas `400` del BE.
- [ ] 5.10 Página de settings — precios por plan: misma estructura que 5.9.
- [ ] 5.11 Página de settings — metas: formulario simple (singleton).
- [ ] 5.12 Página de settings — índice IPC: tabla mes×valor editable, `Combobox` de mes (no `<input type=month>`
  crudo si el design system ya tiene un componente de selección de período — verificar antes de crear uno).
- [ ] 5.13 Página de settings — clasificación de tipos de comprobante: lista con badge `unclassified`
  destacado (para que un admin lo note y reclasifique), acción de reclasificar con `finance.manage_costs`.
- [ ] 5.14 Botón "sincronizar ahora" (`finance.sync`): deshabilitado con tooltip mientras hay una corrida en
  curso (poll de `GET /sync/status`), nunca oculto sin más.
- [ ] 5.15 A11y pass completo: contraste ≥4.5:1 calculado en ambos temas para las series nominal/real y los
  badges de estado, touch targets ≥44px, `aria-live` en los contadores que cambian tras una acción (ej. tras
  reclasificar un tipo de comprobante), labels asociados en todos los formularios de settings.
- [ ] 5.16 Reuso de átomos existentes: `DataTable` para todas las tablas/rankings, `ConfirmModal` para
  acciones destructivas/de reclasificación, `Pagination` donde el volumen lo pida, `Button`/`Tabs` para la
  navegación entre las 5 sub-páginas.

## Fase 6 (deferred — NO se implementa en este change)

Costo de instalación real desde `ContractInstalledItem` + inventario (EPIC #38). Sin tasks — el punto de
extensión queda documentado en `design.md` (Data Model → nota de extensión) para cuando se priorice.
