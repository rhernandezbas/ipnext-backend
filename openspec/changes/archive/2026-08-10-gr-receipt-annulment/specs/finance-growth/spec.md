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
`reconcileWindowDays` es un knob de COBERTURA en `[1, 90]`, default `35` — cuán tarde puede llegar una
confirmación/anulación y todavía ser cazada. NO es un invariante de corrección: la visibilidad en el
dashboard la garantiza el encolado de rebuild (ver el requirement "An annulment on a closed month queues
that month for a snapshot rebuild"), no el ancho de la ventana. `reconcileCheckIntervalMs` MUST ser configurable en DB, default
`21600000` (6 h), con piso `3600000` (1 h) — por debajo, el carril queda permanentemente "due" y se lleva
~71% del presupuesto compartido de GR, matando de hambre al backfill.

La ventana MUST terminar AYER, no hoy (`[ayer-(N-1), ayer]`): un límite superior "hoy" hace crecer el
result set MIENTRAS el barrido pagina, y los offsets del cursor dejan de significar lo mismo (recibos que
se leen dos veces, recibos que se saltean). Hoy es exactamente lo que cubre el carril delta.

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

#### Scenario: The reconcile window is a coverage knob, not a correctness invariant
- GIVEN `FinanceReceiptSyncConfig.reconcileWindowDays` se configura en `20` (dentro de `[1, 90]`, por
  debajo del default)
- WHEN se guarda la config
- THEN se acepta tal cual — la visibilidad en el dashboard NO depende de este número
- AND un valor fuera de `[1, 90]` (0, negativo, no entero, > 90) cae al default seguro `35`, nunca clampeado
  (nota: la versión anterior de este scenario exigía un piso efectivo de `35` "porque el rebuild nocturno
  cubre 35 días". La aritmética es falsa: el rebuild recomputa `[mes anterior, mes corriente]`, que
  garantiza **28** días — el 1 de marzo cubre desde el 1 de febrero. El invariante estaba INVERTIDO y el
  número inventado; la corrección se movió al encolado de meses, abajo.)

### Requirement: An annulment on a closed month queues that month for a snapshot rebuild

Cuando el espejo pasa un recibo de `anulado: false` a `anulado: true` (un FLIP — el recibo ya estaba
espejado, así que su plata YA fue contada por un snapshot), y el mes de su `fechaRecibo` NO es el mes
CORRIENTE en hora argentina al momento del ingest, el sistema MUST encolar ese mes para reconstrucción
explícita. El job nocturno MUST reconstruir los meses encolados ADEMÁS de su horizonte
(`[mes anterior, mes corriente]`), y MUST desencolar sólo los que reconstruyó con éxito.

La condición de encolado MUST NOT depender del horizonte del job nocturno. El horizonte se recomputa con el
reloj del NOCTURNO; consultarlo con el reloj del INGEST es una carrera entre dos relojes que se abre en cada
borde de mes: un flip de las 20:00 ART del 28-02 sobre un recibo del 28-01 lee el horizonte como
`[2026-01, 2026-02]`, concluye "ya cubierto" y no encola nada; el nocturno corre el 01-03 con horizonte
`[2026-02, 2026-03]` y enero no se reconstruye NUNCA (~21 h de ventana ciega por mes, en silencio).
Con la regla "≠ mes corriente" no hay un segundo reloj con el cual discrepar.
(Previously: "el mes cae FUERA del horizonte que el job nocturno recomputa".)

Los dos bordes de la regla nueva:
- Un flip del mes ANTERIOR se encola aunque el nocturno de esta misma noche ya lo fuera a cubrir. La
  redundancia cuesta ≈ 0: la cola deduplica (encolar un mes ya pendiente ni siquiera escribe), el nocturno
  filtra los encolados que ya están en su horizonte (no reconstruye dos veces) y los desencola igual.
- Un flip del mes CORRIENTE a las 23:59 del último día del mes NO se encola, y se repara igual: cuando
  corra cualquier nocturno, ese mes ya es el corriente o el anterior, es decir está dentro de
  `[mes anterior, mes corriente]` por construcción. El único modo de perderlo es un nocturno que no corra
  en un mes calendario ENTERO — una caída del motor de métricas que deja stale a todos los meses, visible
  en `GET /sync/status` (`finance-snapshot-job.lastRunAt`), no un agujero de esta regla.

#### Scenario: An annulment on a closed month repairs that month's snapshot
- GIVEN un recibo del 31-01 ya espejado y contado en el snapshot de `2026-01`
- AND GR lo reporta anulado el 01-03 (29 días después — dentro de la ventana del reconcile)
- WHEN el carril reconcile lo re-consulta y el espejo lo flipea a `anulado: true`
- THEN `2026-01` queda encolado en `SyncState` (`finance-snapshot-rebuild-queue`)
- AND la siguiente corrida del job nocturno recomputa `2026-01` y lo desencola — el dashboard deja de
  contar esa plata

#### Scenario: A flip near the month boundary is queued regardless of the nightly horizon
- GIVEN un recibo del 28-01 ya espejado
- WHEN flipea a anulado el 28-02 a las 20:00 ART (el mes corriente es `2026-02`, el horizonte del nocturno
  todavía incluiría `2026-01`)
- THEN `2026-01` SE ENCOLA igual — el nocturno que efectivamente corre lo hace el 01-03, ya sin `2026-01`
  en su horizonte, y sólo la cola lo reconstruye

#### Scenario: A flip on the CURRENT month queues nothing
- GIVEN un recibo cuyo mes es el mes corriente en hora argentina
- WHEN se persiste el flip
- THEN NO se encola nada — todo nocturno recomputa el mes corriente, y cuando el mes cierre pasa a ser el
  mes anterior, que también recomputa

#### Scenario: A failed rebuild keeps the month queued
- GIVEN `2026-01` encolado
- WHEN el job nocturno falla al reconstruirlo
- THEN el mes SIGUE encolado — se reintenta la noche siguiente, nunca se descarta en silencio

### Requirement: The annulled flag is a one-way latch

El upsert del espejo MUST escribir `anulado: true` cuando GR reporta una anulación sobre un recibo ya
espejado (el FLIP que justifica el carril reconcile), y MUST NO escribir `anulado: false` sobre una fila ya
anulada. Cada flip MUST loguearse con el id del recibo y el valor CRUDO de `fecha_anulacion`.

#### Scenario: A mirrored receipt flips to annulled
- GIVEN un recibo espejado con `anulado: false`
- WHEN un barrido posterior lo trae con `fecha_anulacion` real
- THEN la MISMA fila queda `anulado: true` (no se duplica) y se emite el log del flip

#### Scenario: GR blanking fecha_anulacion never un-annuls the mirror
- GIVEN un recibo ya espejado con `anulado: true`
- WHEN un barrido posterior lo trae con el centinela todo-ceros (drift de formato, respuesta parcial)
- THEN la fila SIGUE `anulado: true` — el resto de los campos sí se refresca
- AND revertir una anulación falsa es una acción HUMANA por SQL, no un efecto silencioso de una página de GR
  (una des-anulación masiva es indistinguible de datos sanos aguas abajo: ningún guard podría cazarla)

#### Scenario: Three consecutive guard aborts abandon the sweep
- GIVEN el guard sistémico aborta la misma página del reconcile tres veces seguidas
- WHEN se registra el tercer abort
- THEN el barrido se ABANDONA (cursor → `null`, `lastRunAt` = ahora), el carril queda degradado con el
  ABORT en `lastResult`, y el próximo intento espera la cadencia normal en vez de repetir la misma página
  en cada tick para siempre

#### Scenario: The abort counter survives an unrelated error in between
- GIVEN el guard aborta, después la llamada a GR falla con `ECONNRESET`, después el guard aborta de nuevo,
  otro `ECONNRESET`, y un tercer abort del guard
- WHEN se registra ese tercer abort
- THEN el barrido se ABANDONA igual — el contador de aborts es estado PERSISTIDO propio del carril
  (`SyncState` `"{carril}:guard-aborts"`, clave = el rango del barrido), MUST NOT derivarse del último
  `lastResult`, y sólo lo incrementa un abort del guard
- AND el contador se pone en cero al completar una página, al abandonar el barrido, y al empezar un barrido
  con un rango distinto
  (Previously: el streak se parseaba del marcador `guardAborts=N` en `lastResult`, así que cualquier otro
  error intercalado lo devolvía a 1 y el umbral de abandono era inalcanzable contra un GR intermitente —
  justo el escenario que este requirement viene a cortar.)

#### Scenario: GR's error envelope during reconcile never degrades to an empty write
- GIVEN GR responde `{"error": "N"}` (N != "0") a una página del reconcile
- WHEN `parseReceiptsResponse` lo procesa
- THEN tira excepción (mismo comportamiento que delta/backfill hoy) — el reconcile NUNCA interpreta el
  sobre de error como "cero recibos en la ventana" ni escribe nada para esa página

### Requirement: A non-empty, non-sentinel fecha_anulacion means annulled — the format only decides whether to warn

`isRealAnnulment` MUST devolver `true` para CUALQUIER `fecha_anulacion` no vacío que no sea el centinela
todo-ceros: GR no llena ese campo por gusto. El FORMATO no cambia la clasificación, sólo el ruido: los dos
formatos reconocidos (`DD-MM-AAAA[ HH:MM:SS]` y el ISO `AAAA-MM-DD[ HH:MM:SS]`) se aceptan en silencio;
cualquier otro valor no vacío y no-centinela también cuenta como anulado, pero con un `console.warn`
ruidoso. El fail-closed es POR FILA: NUNCA MUST abortar la página completa ni las demás filas de la
respuesta (eso es trabajo del guard sistémico, sobre la proporción de la página).
El centinela todo-ceros, en cualquier ancho/orden/separador, MUST devolver `false` sin warning.
(Previously: fail-open — cualquier valor no parseable se trataba como "no anulado" con solo un
`console.warn`.)

#### Scenario: ISO-formatted fecha_anulacion is a real annulment, recognized without noise
- GIVEN `fecha_anulacion` = `"2026-06-15 10:00:00"` (ISO, no centinela)
- WHEN se evalúa `isRealAnnulment`
- THEN devuelve `true` (GR reporta una anulación real) y NO se emite warning — el formato es uno de los
  dos reconocidos
  (nota: la versión anterior de este scenario decía "devuelve `false`", contradiciendo tanto al design como
  a la implementación. Una fecha de anulación VÁLIDA es la forma más clara posible de "este recibo está
  anulado"; leerla como "no anulado" habría sido justamente el fail-open que este change vino a cerrar.)

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

El sistema MUST comparar, ANTES de escribir nada de cada página, la proporción de recibos marcados
`anulado: true` contra `FinanceReceiptSyncConfig.annulmentGuardMaxPct` (configurable en DB, default 5).
Si la proporción SUPERA ESTRICTAMENTE el umbral (`>`, no `>=`: el nombre del knob es "máximo permitido", así
que 5/100 pasa y 6/100 aborta — aritmética entera, sin punto flotante que pueda correr la frontera) Y la
cantidad absoluta de anulados alcanza `annulmentGuardMinCount` (piso `>=`: exactamente 5 de 20 YA dispara),
el sistema MUST abortar SIN persistir ninguna fila de esa página.
El piso absoluto existe para que una página de cola con 1-2 anulaciones legítimas no trabe el carril para
siempre.
El sistema MUST loguear el abort con el conteo, el umbral, el `rango` y el `offset` de la página, y una
muestra de hasta 5 valores CRUDOS de `fecha_anulacion` en formato `id="valor"` — valores idénticos indican
drift del centinela (NO subir el knob); fechas variadas y verosímiles indican un pico legítimo (subir el
knob). Los `grReceiptId` solos no responden ninguna de las dos preguntas.
El guard MUST correr en los TRES carriles con la config VIVA de DB — un umbral hardcodeado en el carril
delta deja la perilla inerte justo sobre la caja del día.
(Previously: el texto decía `annulmentAbortThresholdPct` e "IGUALA O SUPERA" — ni el nombre del campo ni la
comparación coincidían con el design ni con la implementación.)

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
