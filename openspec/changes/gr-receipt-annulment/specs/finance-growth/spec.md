# Delta for `finance-growth`

Target: `openspec/changes/finance-growth-dashboard/specs/finance-growth/spec.md` (capability aún no
archivada). Este delta asume que `finance-growth-dashboard` archiva primero; si el orden se invierte,
`sdd-archive` debe aplicar este delta contra `openspec/specs/finance-growth/spec.md` una vez exista.

## MODIFIED Requirements

### Requirement: Global incremental receipt ingest (backfill + delta), never per-client for the full population

El sistema MUST reconstruir la cobranza histórica sincronizando el action GLOBAL `recibos` por rango de
fechas (paginado por `offset`), NUNCA iterando `cuentas.invoices[]` cliente por cliente. El ingest MUST
correr en carriles independientes pero coordinados (delta, backfill, y reconcile — ver Requirement de
pacing), cada uno con su propio cursor en `SyncStateRepository`. Un recibo con `fecha_anulacion` real MUST
persistirse con `anulado: true`, NUNCA descartarse antes de llegar al mapper.
(Previously: un recibo con `fecha_anulacion` distinto del centinela se filtraba con `continue` en
`GestionRealClient.parseReceiptsResponse` ANTES del mapper, y `mapGrReceipt.ts` hardcodeaba `anulado:
false` — ningún recibo anulado llegaba jamás a persistirse.)

#### Scenario: A receipt with a real annulment date is persisted with anulado=true, never skipped
- GIVEN un recibo cuyo `fecha_anulacion` es distinto del centinela `"00-00-0000 00:00:00"` y parsea como
  fecha válida (DD-MM-AAAA o ISO)
- WHEN el ingest lo procesa (delta, backfill o reconcile)
- THEN el recibo SE persiste con `anulado: true`
- AND sus `items`/`aplicaciones`/`retenciones` también se persisten (auditoría completa, no se descartan)

#### Scenario: Dict-keyed GR nodes are normalized to lists, never crash the parser
- GIVEN un payload de `recibos` donde `aplicaciones`/`items`/el nodo raíz viene como objeto keyed-by-id
- WHEN el parser lo procesa
- THEN normaliza a una lista sin lanzar excepción y sin perder ninguna entrada

#### Scenario: A receipt's applications pay multiple invoices (1-to-N)
- GIVEN un recibo con 2 entradas en `aplicaciones`
- WHEN se persiste
- THEN se crean 2 filas de `FinanceReceiptApplication`, cada una con su `grInvoiceId` y `amount` propios

#### Scenario: A receipt's items and retenciones persist alongside its applications, each in its own table
- GIVEN un recibo con `aplicaciones`, `items` y `retenciones`
- WHEN se persiste
- THEN se crean filas en las tres tablas, siempre — nunca solo `FinanceReceiptApplication`

#### Scenario: A single page failure does not abort the batch
- GIVEN una página de `recibos` falla (timeout tras reintentos) durante cualquier carril
- WHEN corre el ingest
- THEN el error se cuenta/logea, el cursor NO avanza más allá de la última página exitosa, y una corrida
  posterior retoma desde ahí

### Requirement: Receipt ingest pacing — continuous shared request budget, recent-lane priority, adaptive throttle

El sistema MUST pacear `recibos` como goteo continuo, con presupuesto de requests compartido entre TRES
carriles: DELTA, RECONCILE y BACKFILL, en ese orden de prioridad estricto (delta > reconcile > backfill).
El backfill SOLO recibe turno cuando ni delta ni reconcile tienen trabajo pendiente en ese instante.
(Previously: solo dos carriles — delta con prioridad absoluta, backfill con el resto del presupuesto.)

#### Scenario: Delta claims the tick over reconcile and backfill
- GIVEN el carril delta tiene páginas pendientes o venció su intervalo de chequeo
- WHEN el árbitro decide el próximo tick
- THEN atiende a delta, sin importar si reconcile o backfill también tienen trabajo pendiente

#### Scenario: Reconcile claims the tick when delta is quiet and its own cadence is due
- GIVEN delta no tiene páginas pendientes y su intervalo aún no venció
- AND venció `FinanceReceiptSyncConfig.reconcileCheckIntervalMs` desde la última corrida completa del
  reconcile, o el reconcile tiene páginas pendientes de una ventana en curso
- WHEN corre un tick del presupuesto compartido
- THEN el turno se le asigna a reconcile, antes que a backfill

#### Scenario: Backfill is not starved indefinitely — it gets turns between reconcile windows
- GIVEN reconcile no tiene trabajo pendiente (su ventana ya se barrió completa y su cadencia no venció)
- WHEN corre un tick
- THEN el turno se le asigna a backfill — reconcile NUNCA bloquea el presupuesto de forma permanente

#### Scenario: The backfill walks the historical months newest to oldest, one GR page per turn
- GIVEN el cursor del backfill apunta a un mes con offset `0`
- WHEN recibe un turno
- THEN pagina UNA sola página (`cantidad=100`), persiste, y avanza el offset — nunca pagina el mes
  completo en un turno

#### Scenario: The backfill is resumable mid-page and stops at the configured floor
- GIVEN el proceso se cae a mitad de un mes, o el cursor llega a `backfillFloorYearMonth`
- WHEN se reinicia o recibe el siguiente turno
- THEN retoma exactamente donde quedó, o se marca `done` y deja de llamar a GR hasta re-armarse

#### Scenario: The delta lane advances forward with overlap on a real-time cadence
- GIVEN el carril delta completó su última corrida (cursor = ayer)
- WHEN recibe un turno tras `deltaCheckIntervalMs`
- THEN sincroniza desde el cursor hasta hoy inclusive, paginando si hace falta

#### Scenario: Repeated GR failures degrade the shared pacing rate for all three lanes
- GIVEN varios ticks consecutivos fallan por timeout/5xx (reintentos de `GestionRealClient` agotados)
- WHEN el árbitro programa el siguiente tick
- THEN el intervalo efectivo crece (backoff), acotado por `maxRequestIntervalMs`, y aplica por igual a
  delta, reconcile y backfill (presupuesto único)
- AND un tick exitoso restaura el intervalo base de inmediato

## ADDED Requirements

### Requirement: Reconciliation lane repairs late-confirmed receipts and catches real annulments

El sistema MUST correr un tercer carril `reconcile` en `FinanceReceiptIngestScheduler` que re-consulta a
GR una ventana móvil de `FinanceReceiptSyncConfig.reconcileWindowDays` días hacia atrás desde hoy, y
re-upsertea cada recibo de esa ventana (una página GR por tick, mismo criterio de cursor reanudable que
delta/backfill: `"{fechaDesde}:{fechaHasta}:{offset}"`, `SyncState` propio `finance-receipts-reconcile`).
`reconcileWindowDays` MUST ser ≥ la ventana que el rebuild nocturno de snapshots recomputa (mes corriente +
mes anterior); el valor por defecto es `35`. `reconcileCheckIntervalMs` MUST ser configurable en DB, default
`21600000` (6 h).

#### Scenario: Reconcile catches a receipt confirmed after the delta's overlap window
- GIVEN un recibo con `fecha_recibo` de hace 3 días, ausente del espejo porque su `fecha_confirmacion`
  llegó después de que el delta avanzara su cursor
- WHEN el carril reconcile barre su ventana de `reconcileWindowDays` días
- THEN el recibo se upsertea (items/aplicaciones/retenciones incluidos) y queda visible en el portal y el
  dashboard desde el próximo rebuild de snapshots

#### Scenario: Re-running the same window twice does not duplicate rows
- GIVEN el carril reconcile ya barrió la ventana completa una vez
- WHEN corre de nuevo sobre el mismo rango de fechas
- THEN el upsert por `grReceiptId` reescribe las mismas filas — no se crean duplicados en
  `FinancePaymentReceipt`/`FinanceReceiptItem`/`FinanceReceiptApplication`/`FinanceReceiptRetencion`

#### Scenario: The window-vs-rebuild invariant is enforced
- GIVEN `FinanceReceiptSyncConfig.reconcileWindowDays` se intenta configurar por debajo de la ventana que
  recomputa el rebuild nocturno de snapshots (mes corriente + mes anterior)
- WHEN se guarda la config
- THEN la escritura se rechaza o se acota al mínimo válido — un recibo reparado fuera de la ventana de
  rebuild nunca llegaría al dashboard sin un backfill de snapshots manual

#### Scenario: GR's error envelope during reconcile never degrades to an empty write
- GIVEN GR responde `{"error": "N"}` (N != "0") a una página del reconcile
- WHEN `parseReceiptsResponse` lo procesa
- THEN tira excepción (mismo comportamiento que delta/backfill hoy) — el reconcile NUNCA interpreta el
  sobre de error como "cero recibos en la ventana" ni escribe nada para esa página

### Requirement: isRealAnnulment classifies annulment per row, without failing the whole batch

`isRealAnnulment` MUST aceptar tanto `DD-MM-AAAA[ HH:MM:SS]` como ISO (`AAAA-MM-DD[ HH:MM:SS]`) como
formatos de fecha válida no anulada. Un `fecha_anulacion` no vacío, no-centinela, y no parseable en
NINGUNO de los dos formatos MUST clasificarse `anulado: true` para ESA fila únicamente, con un warning —
NUNCA MUST abortar la página completa ni las demás filas de la respuesta.
(Previously: fail-open — cualquier valor no parseable se trataba como "no anulado" con solo un
`console.warn`; `isRealAnnulment('2026-06-15 10:00:00')` devolvía `false`.)

#### Scenario: ISO-formatted fecha_anulacion is recognized as a valid non-annulled date
- GIVEN `fecha_anulacion` = `"2026-06-15 10:00:00"` (ISO, no centinela)
- WHEN se evalúa `isRealAnnulment`
- THEN devuelve `false` (fecha válida, recibo no anulado) — sin warning

#### Scenario: The all-zero sentinel in any width/order is still "not annulled"
- GIVEN `fecha_anulacion` = `"00-00-0000 00:00:00"` (o variantes de ancho/orden ya generalizadas)
- WHEN se evalúa
- THEN devuelve `false`, sin warning

#### Scenario: An unparseable non-empty residue marks only that row as annulled
- GIVEN `fecha_anulacion` = `"nota de credito"` (no vacío, no centinela, no parseable en ningún formato) en
  una página de 100 recibos
- WHEN se evalúa esa fila
- THEN esa fila se persiste con `anulado: true` y un warning ruidoso
- AND las otras 99 filas de la misma página se persisten normalmente — el residuo no bloquea la página

### Requirement: Systemic guard aborts a run when the annulled ratio spikes

El sistema MUST comparar, al final de cada página/corrida, la proporción de recibos marcados `anulado:
true` contra `FinanceReceiptSyncConfig.annulmentAbortThresholdPct` (configurable, default conservador
recomendado 5%, valor final de diseño). Si la proporción de la corrida IGUALA O SUPERA el umbral, el
sistema MUST abortar SIN persistir ninguna fila de esa corrida y MUST loguear el abort con el conteo y el
umbral.

#### Scenario: A normal run with zero or few annulments persists as usual
- GIVEN una corrida de 500 recibos con 0 marcados `anulado: true`
- WHEN termina de procesar
- THEN se persisten los 500, ninguno abortado

#### Scenario: A sentinel drift that floods the batch with false annulments aborts and writes nothing
- GIVEN GR driftea su centinela (p.ej. a `"0000-00-00 00:00:00"`, no reconocido) y el 80% de una página de
  100 recibos cae en el residuo no parseable
- WHEN el guard evalúa la proporción de la corrida
- THEN aborta ANTES de persistir cualquier fila de esa página — el espejo NO se vuelca a `anulado: true`
  en masa, mismo criterio que el sobre de error de GR
