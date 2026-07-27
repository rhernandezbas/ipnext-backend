# Finance Growth Specification

## Purpose

Unit economics de un ISP sobre datos REALES de cobranza (Gestión Real), no un catálogo de precios de lista ni
facturación emitida (GR no expone un endpoint de facturación/comprobantes emitidos — verificado en vivo,
2026-07-26, 17 nombres de action probados). Cubre: ingest global incremental de recibos de cobranza GR como
goteo continuo (carril backfill histórico + carril delta reciente en cadencia de minutos, ambos resumibles,
con presupuesto de requests compartido y prioridad absoluta del carril reciente — ver Requirement de pacing),
clasificación robusta de tipos de comprobante, configuración
editable de costos/metas/inflación, motor de métricas (bridge de MRR, churn de contratos e ingresos, cohortes
de retención, CAC/payback, ranking de churn temprano por vendedor, crecimiento neto por nodo, ranking de
motivos de baja) y la API de lectura que alimenta la sección nueva del sidebar (fuera del cementerio Splynx
"Finanzas"). **Toda métrica de "revenue"/MRR de este spec es cobranza real (cash collected), nunca facturación
emitida (accrual)** — limitación estructural documentada, no una elección estética; el timing del pago puede
desfasar un mes contra otro. **Fuera de alcance de este spec**: cualquier página del módulo `billing`
existente, costo de instalación REAL desde inventario (fase posterior, documentada como extensión en
`design.md`), reconstrucción de facturación emitida (técnicamente imposible con la API actual), y sync/
escritura hacia GR fuera de lectura de recibos/facturas.

## Requirements

### Requirement: Global incremental receipt ingest (backfill + delta), never per-client for the full population
El sistema DEBE (MUST) reconstruir la cobranza histórica sincronizando el action GLOBAL `recibos` por rango
de fechas (paginado por `offset`), NUNCA iterando `cuentas.invoices[]` cliente por cliente para la población
completa (verificado en vivo: ese endpoint solo devuelve deuda ABIERTA — un cliente al día trae cero
facturas, así que no sirve como fuente histórica). El ingest DEBE (MUST) correr en dos carriles
independientes pero coordinados (ver el Requirement de pacing más abajo para la coordinación): un carril
BACKFILL resumible que camina hacia atrás desde el mes actual hasta un piso configurable, y un carril DELTA
que avanza hacia adelante desde el último punto sincronizado con éxito. Ambos DEBEN (MUST) usar el formato de
fecha `DD-MM-AAAA` exigido por GR (`recibos` responde HTTP 500 con fechas ISO), y cada carril DEBE (MUST)
persistir su propio cursor de forma independiente vía el `SyncStateRepository` ya existente (entidades
`finance-receipts-backfill` y `finance-receipts-delta` — sin puerto nuevo).

#### Scenario: A voided receipt is excluded from ingestion, never persisted as revenue
- GIVEN un recibo con `fecha_anulacion` distinto del centinela `"00-00-0000 00:00:00"` (anulación real)
- WHEN el ingest lo encuentra
- THEN el recibo NO se persiste (ni él ni sus aplicaciones cuentan para ninguna métrica)

#### Scenario: A receipt's applications pay multiple invoices (1-to-N)
- GIVEN un recibo con 2 entradas en `aplicaciones` (paga 2 comprobantes distintos)
- WHEN se persiste
- THEN se crean 2 filas de `FinanceReceiptApplication`, cada una con su propio `grInvoiceId` compuesto
  (`{tipo}-{sucursal}-{numero}`) y su propio `amount`, ambas vinculadas al mismo recibo

#### Scenario: A receipt's items and retenciones persist alongside its applications, each in its own table
- GIVEN un recibo con `aplicaciones`, `items` Y `retenciones` presentes
- WHEN se persiste
- THEN se crean filas en `FinanceReceiptApplication`, `FinanceReceiptItem` Y `FinanceReceiptRetencion` — las
  tres tablas, nunca sólo `FinanceReceiptApplication` (ver el Requirement de metric basis para la definición
  de cada una)

#### Scenario: Dict-keyed GR nodes are normalized to lists, never crash the parser
- GIVEN un payload de `recibos` donde `aplicaciones` (o `items`, o el nodo raíz) viene como OBJETO keyed by
  id en vez de array (mismo patrón que `clientes` en `clientes_consulta`)
- WHEN el parser lo procesa
- THEN normaliza el dict a una lista de filas sin lanzar excepción y sin perder ninguna entrada

#### Scenario: A single client failure or page failure does not abort the batch
- GIVEN una página de `recibos` falla (timeout tras agotar reintentos) durante el backfill o el delta
- WHEN corre el ingest
- THEN el error se cuenta y logea, el cursor NO avanza más allá de la última página exitosa, y una corrida
  posterior retoma desde ahí (mismo criterio de resiliencia que `RefreshDebtorBalances`/`SyncGestionRealContractsDelta`)

### Requirement: Receipt ingest pacing — continuous shared request budget, recent-lane priority, adaptive throttle
El sistema DEBE (MUST) pacear el ingest de `recibos` como un GOTEO CONTINUO durante todo el día — nunca un
batch nocturno de "N meses/día por corrida" — consumiendo UN presupuesto de requests GR ÚNICO y COMPARTIDO
entre el carril DELTA (recibos recientes) y el carril BACKFILL (historia). El sistema DEBE (MUST) procesar el
histórico en orden **newest → oldest** (caminando hacia atrás desde el mes calendario actual hasta
`FinanceReceiptSyncConfig.backfillFloorYearMonth`), porque los meses recientes son los que habilitan
comparaciones MoM/YoY usables desde el día uno — se prioriza por VALOR, no por cronología de carga. En cada
tick del presupuesto compartido, el sistema DEBE (MUST) atender PRIMERO al carril delta si tiene trabajo
pendiente (páginas sin procesar del rango "hasta hoy", o venció su intervalo de chequeo); el carril backfill
SOLO recibe el turno cuando el delta no tiene trabajo pendiente en ese instante — el backfill NUNCA retrasa
al delta. El sistema DEBE (MUST) degradar automáticamente el ritmo (backoff) ante fallas de GR (5xx/timeout,
ya reintentadas sin éxito por el retry existente de `GestionRealClient` — este Requirement NO reimplementa
ese retry, lo consume) y recuperar el ritmo base tras una corrida exitosa, sin intervención manual.

#### Scenario: The delta lane claims the shared tick when it has pending work
- GIVEN el carril delta tiene páginas pendientes (está a mitad de ponerse al día con "hoy") o venció
  `FinanceReceiptSyncConfig.deltaCheckIntervalMs` desde su última corrida completa
- WHEN el árbitro del presupuesto compartido decide a qué carril atender en el próximo tick
- THEN atiende al carril delta, sin importar si el carril backfill también tiene trabajo pendiente

#### Scenario: The backfill lane yields its turn while the delta lane is catching up
- GIVEN el carril delta lleva varios ticks consecutivos con páginas pendientes (recuperando un atraso, p.ej.
  tras un reinicio o un pico de recibos)
- WHEN corren esos ticks
- THEN el carril backfill NO avanza ni una página durante ese lapso — su cursor persistido queda intacto
  hasta que el delta se pone al día

#### Scenario: A quiet delta lane lets the backfill lane use the shared budget
- GIVEN el carril delta no tiene páginas pendientes y su `deltaCheckIntervalMs` todavía no venció
- WHEN corre un tick del presupuesto compartido
- THEN el turno se le asigna al carril backfill

#### Scenario: The backfill walks the historical months from newest to oldest, one GR page per turn
- GIVEN el cursor del backfill apunta al mes `2026-06` (o al mes calendario actual, si nunca corrió) con
  offset `0`
- WHEN el carril backfill recibe un turno
- THEN pagina UNA sola página (`cantidad=100`) de `recibos` para ese mes, persiste sus recibos y
  aplicaciones, y avanza el offset persistido — NUNCA pagina el mes completo en un solo turno (a diferencia
  del batch nocturno descartado)

#### Scenario: A month boundary advances the backfill cursor to the previous month
- GIVEN la última página procesada de un mes devolvió menos de `cantidad` resultados, o el offset alcanzó el
  total reportado por GR para ese mes
- WHEN el carril backfill termina de procesar esa página
- THEN el cursor avanza al mes calendario ANTERIOR con offset `0` — nunca salta hacia adelante, siempre
  continúa hacia atrás en el tiempo (newest→oldest)

#### Scenario: The backfill is resumable mid-page after a crash
- GIVEN el proceso se cae después de persistir la página en offset `1300` del mes `2026-03`
- WHEN se reinicia el proceso y el carril backfill recibe su próximo turno
- THEN retoma exactamente `2026-03` en offset `1300`, sin reprocesar páginas ya persistidas de ese mes ni
  saltarse ninguna

#### Scenario: The backfill stops at the configured floor and disarms
- GIVEN el cursor del backfill llegó al mes piso configurado (`FinanceReceiptSyncConfig.backfillFloorYearMonth`)
  y ese mes ya se procesó completo
- WHEN el carril backfill recibe el siguiente turno
- THEN se marca `done`, no hace más llamadas a GR, y queda en no-op hasta que se re-arme

#### Scenario: The delta lane bootstraps to today only, never the full history
- GIVEN el carril delta nunca corrió (sin cursor persistido)
- WHEN recibe su primer turno
- THEN sincroniza SOLO el día de hoy (la reconstrucción histórica es responsabilidad exclusiva del carril
  backfill, nunca del delta)

#### Scenario: The delta lane advances its cursor forward with overlap, paging if needed
- GIVEN el carril delta completó con éxito su última corrida (cursor = ayer)
- WHEN recibe un turno hoy
- THEN sincroniza desde el cursor (ayer) hasta hoy inclusive (overlap de ≥1 día, idempotente vía upsert por
  `grReceiptId`), paginando de a un turno por página si el volumen del rango excede una página, y el cursor
  avanza a hoy recién cuando termina de paginar todo el rango

#### Scenario: The delta lane runs on a real-time cadence, not once a day
- GIVEN `FinanceReceiptSyncConfig.deltaCheckIntervalMs` configurado en minutos (default 5 minutos)
- WHEN el carril delta completó su última corrida sin páginas pendientes y pasan `deltaCheckIntervalMs` desde
  entonces
- THEN vuelve a chequear "hoy" en el próximo tick disponible, sin esperar una ventana de 24 horas — el panel
  refleja la cobranza del día en minutos, no al día siguiente

#### Scenario: Repeated GR failures degrade the shared pacing rate automatically
- GIVEN varios ticks consecutivos fallan por timeout/5xx (ya agotados los reintentos internos de
  `GestionRealClient`)
- WHEN el árbitro del presupuesto compartido programa el siguiente tick
- THEN el intervalo efectivo entre ticks crece (backoff exponencial), acotado por
  `FinanceReceiptSyncConfig.maxRequestIntervalMs`, sin que ningún use case de negocio necesite implementar
  esa lógica

#### Scenario: A successful tick after degradation recovers the base pacing rate
- GIVEN el presupuesto compartido está degradado (intervalo efectivo > `requestIntervalMs`) por fallas previas
- WHEN un tick se ejecuta con éxito
- THEN el intervalo efectivo vuelve a `requestIntervalMs` (recuperación inmediata al primer éxito, no
  gradual)

#### Scenario: The AR-midnight password rotation is already satisfied by the existing adapter, never cached at the scheduler level
- GIVEN el presupuesto compartido corre de forma continua y cruza la medianoche argentina en algún tick
- WHEN ese tick (de cualquiera de los dos carriles) dispara una request a GR
- THEN `GestionRealClient` recomputa el password `MD5(CUIT+SECRET+fecha)` PARA ESE INTENTO usando
  `isoDate()` (huso `America/Argentina/Buenos_Aires`) — el scheduler NUNCA reutiliza ni cachea una instancia
  de credenciales entre ticks, así que el cruce de medianoche no puede reproducir el incidente histórico de
  error 90 "No tiene Acceso"

### Requirement: The existing per-client debtor sync extends to estado Incobrable, never to estado Activo
El sistema DEBE (MUST) extender `RefreshDebtorBalances` para cubrir también el estado GR `4` (Incobrable),
sumado a los estados `2` (Deudor) y `3`/`6` (Inactivo/Baja) que ya cubre. El sistema NO DEBE (MUST NOT)
extenderlo al estado `1` (Activo) — verificado en vivo que ese estado siempre devuelve cero facturas y
agregarlo solo incrementa el volumen de llamadas GR sin aportar dato.

#### Scenario: A client in estado Incobrable (4) gets its invoices synced
- GIVEN un cliente GR en estado `4` (Incobrable) que antes no era cubierto por `RefreshDebtorBalances`
- WHEN corre `RefreshDebtorBalances`
- THEN el cliente se enumera y su balance/facturas se persisten, igual que los estados `2/3/6`

#### Scenario: Estado Activo is never enumerated by the debtor-like sync
- GIVEN clientes en estado `1` (Activo)
- WHEN corre `RefreshDebtorBalances`
- THEN esos clientes NO se enumeran (el estado `1` no forma parte de `DEBTOR_LIKE_STATUSES`)

### Requirement: Invoice-type classification is data-driven, never a hardcoded vocabulary
El sistema DEBE (MUST) clasificar cada `grType` visto en una aplicación de recibo sincronizada
(`FinanceReceiptApplication.grType`) contra un catálogo de filas (`FinanceInvoiceTypeClassification`), NUNCA
contra una lista fija en código. Un `grType` sin fila en el catálogo se DEBE (MUST) auto-crear con
`bucket: 'unclassified'` en el momento en que se sincroniza, sin romper el ingest ni descartar la aplicación.

#### Scenario: A known revenue type is classified correctly
- GIVEN `FinanceInvoiceTypeClassification` tiene una fila `{grType: 'FB', bucket: 'revenue'}`
- WHEN se computa la cobranza neteada de un mes que incluye una aplicación `grType: 'FB'`
- THEN su `amount` suma a la cobranza del mes

#### Scenario: A known contra type nets against revenue
- GIVEN `FinanceInvoiceTypeClassification` tiene una fila `{grType: 'NC', bucket: 'contra'}`
- WHEN se computa la cobranza neteada de un mes que incluye una aplicación de nota de crédito `grType: 'NC'`
- THEN su `amount` resta de la cobranza del mes (netea, no se ignora ni se suma)

#### Scenario: An unseen grType is auto-classified as unclassified, not dropped
- GIVEN el ingest encuentra una aplicación con `grType: 'XZ'` que no existe en el catálogo
- WHEN persiste la aplicación
- THEN crea `FinanceInvoiceTypeClassification{grType: 'XZ', bucket: 'unclassified'}` y la aplicación se
  EXCLUYE de la cobranza neteada del mes, pero su `amount` se suma a un contador `unclassifiedAmount` visible
  en el snapshot del mes (nunca se pierde silenciosamente)

#### Scenario: Reclassifying a type from unclassified to revenue affects future snapshots
- GIVEN una fila `{grType: 'XZ', bucket: 'unclassified'}` y un admin la reclasifica a `revenue` vía
  `PATCH /api/finance/growth/config/invoice-types/XZ`
- WHEN se recomputa el snapshot del mes correspondiente (próxima corrida nocturna)
- THEN las aplicaciones `grType: 'XZ'` de ese mes pasan a sumar a la cobranza

### Requirement: The growth metric basis is cash collected, never issued invoicing, never debt cancelled
El sistema DEBE (MUST) documentar y exponer que toda cifra de "revenue"/MRR de este spec proviene de cobranza
real, NUNCA de facturación emitida — GR no expone un endpoint de facturación/comprobantes emitidos (verificado
en vivo, 17 nombres de action probados, todos inexistentes). El sistema DEBE (MUST) exponer explícitamente
esta base metodológica en la respuesta de la API de overview.

**Aclaración (fix-wave-2 R1, decisión LOCK del usuario, 2026-07-26)**: "cobranza real"/"cash collected" se
calcula desde `FinanceReceiptItem` (`recibo.items[]`, medido en vivo como la ÚNICA cifra que GR reporta que
representa cash efectivamente recibido), NUNCA desde `FinanceReceiptApplication` (`recibo.aplicaciones[]`,
deuda CANCELADA — puede exceder el cash real cuando el recibo también trae `retenciones`, certificados
impositivos que nunca son cash). El sistema DEBE (MUST) persistir las tres cifras
(`aplicaciones`/`items`/`retenciones`) por separado, cada una en su propia tabla, precisamente para que esta
definición de métrica sea reversible sin re-ingerir el histórico completo si cambia en el futuro. El sistema
DEBE (MUST) exponer `retenciones` como una serie separada, nunca neteada en silencio contra la cobranza. Medido
en vivo (junio 2026, 4.839 recibos, 0 excepciones): `SUM(aplicaciones) - SUM(items) - SUM(retenciones) = -0,00`
— identidad exacta; descartar `items`/`retenciones` sobreestimaba la cobranza exactamente en el total de
retenciones (0,931% en junio 2026).

#### Scenario: The overview response declares its metric basis explicitly
- GIVEN cualquier consulta a `GET /api/finance/growth/overview`
- WHEN se recibe la respuesta
- THEN incluye `metricBasis: 'cash_collected'`, dejando explícito que no es facturación emitida

#### Scenario: A receipt with tax withholdings but no cash items still ingests correctly, with zero cash and the withholding recorded separately
- GIVEN un recibo con `retenciones` (certificado impositivo) pero SIN ningún `items` (cash real cero para ese
  recibo — medido en vivo: 7 de 18 recibos de junio 2026 con `retenciones` no traen `items`)
- WHEN el ingest lo procesa
- THEN `aplicaciones` se persiste igual (deuda cancelada, sin cambios), la cobranza en cash de ese recibo
  computa `0` (no el monto de `aplicaciones`), y la retención se persiste como su propia fila en
  `FinanceReceiptRetencion`, nunca conflada con `items` ni con `aplicaciones`

#### Scenario: The three figures reconcile via an identity guard
- GIVEN un recibo con `aplicaciones`, `items` y `retenciones` ya persistidos
- WHEN se verifica la consistencia del ingest
- THEN `SUM(aplicaciones) == SUM(items) + SUM(retenciones)` (tolerancia de redondeo de punto flotante); una
  discrepancia se loguea como WARNING — nunca aborta el ingest ni se descarta en silencio

#### Scenario: Payment timing can shift revenue between months, and this is accepted
- GIVEN una factura emitida en junio pero cobrada (aplicación de recibo) en julio
- WHEN se computan los meses de junio y julio
- THEN el monto cuenta como cobranza de JULIO (mes de `appliedDate`, no de emisión) — el desfasaje es
  aceptado y documentado, no se intenta reconstruir el mes de emisión

### Requirement: Two-layer attribution — accounting truth vs. operational estimate
El sistema DEBE (MUST) separar explícitamente (a) la verdad contable de cobranza total por mes (Capa A,
directa de `FinanceReceiptApplication` neteada, sin estimación) de (b) la atribución de esa cobranza a nivel
de CONTRATO individual (Capa B, estimación cuando el cliente tiene más de un contrato activo), y DEBE (MUST)
exponer el porcentaje de MRR atribuible con confianza en cada snapshot mensual.

#### Scenario: Single-contract client — collected amount IS the contract's MRR, no estimation
- GIVEN un cliente con exactamente 1 contrato activo en el mes
- WHEN se atribuye su cobranza neteada del mes a nivel de contrato
- THEN el monto atribuido al contrato es el monto total neteado cobrado ese mes, marcado
  `attributionConfidence: 'exact'`

#### Scenario: Multi-contract client — attribution is an estimate, marked as such
- GIVEN un cliente con 2 o más contratos activos en el mes y al menos uno de sus planes tiene fila en
  `FinancePlanPrice`
- WHEN se atribuye su cobranza neteada del mes a nivel de contrato
- THEN el monto se reparte proporcional al `estimatedMonthlyPrice` de cada plan, y cada contrato queda
  marcado `attributionConfidence: 'estimated'`

#### Scenario: Multi-contract client with no plan-price data falls back to equal split, still marked
- GIVEN un cliente con 2 contratos activos donde NINGUNO de sus planes tiene fila en `FinancePlanPrice`
- WHEN se atribuye su cobranza neteada del mes
- THEN el monto se reparte en partes iguales entre los contratos, marcado
  `attributionConfidence: 'estimated-equal'`

#### Scenario: Monthly snapshot exposes the attributable-MRR percentage
- GIVEN un mes con una mezcla de contratos `exact`/`estimated`/`estimated-equal`
- WHEN se consulta el snapshot de ese mes vía la API de overview
- THEN el payload incluye `attributionPct` = (MRR de contratos `exact`) / (MRR total del mes), sin
  disimular el número aunque sea bajo

### Requirement: MRR bridge (waterfall) per month
El sistema DEBE (MUST) computar, para cada mes con datos, el bridge `MRR inicial → +altas → +upgrades −
downgrades − bajas = MRR final`, derivado de `ContractServiceEvent` (eventType `activated`/`deactivated`/
`reactivated`/`modified`) cruzado con la atribución de MRR por contrato del mes.

#### Scenario: An activation adds to mrrNewArs
- GIVEN un contrato con un evento `activated` dentro del mes, con MRR atribuido estimable
- WHEN se computa el snapshot del mes
- THEN su MRR atribuido suma a `mrrNewArs` del bridge

#### Scenario: A plan upgrade adds the delta to mrrUpgradeArs
- GIVEN un contrato con un evento `modified` de cambio de plan cuya dirección derivada (mismo criterio que
  `ListInternetServiceHistory`) es `upgrade`
- WHEN se computa el snapshot del mes
- THEN la diferencia de MRR atribuido (nuevo − viejo) suma a `mrrUpgradeArs`

#### Scenario: A plan downgrade subtracts the delta into mrrDowngradeArs
- GIVEN un contrato con un evento `modified` de cambio de plan cuya dirección derivada es `downgrade`
- WHEN se computa el snapshot del mes
- THEN la diferencia de MRR atribuido resta en `mrrDowngradeArs`

#### Scenario: A deactivation subtracts from mrrChurnArs
- GIVEN un contrato con un evento `deactivated` dentro del mes
- WHEN se computa el snapshot del mes
- THEN su MRR atribuido (del último mes con cobranza registrada) resta de `mrrChurnArs`

#### Scenario: The bridge is internally consistent
- GIVEN un snapshot mensual ya calculado
- WHEN se suman `mrrInicialArs + mrrNewArs + mrrUpgradeArs − mrrDowngradeArs − mrrChurnArs`
- THEN el resultado es igual a `mrrFinalArs` del mismo snapshot (tolerancia de redondeo ≤ 1 unidad de moneda)

### Requirement: Churn is measured at the contract level, in both units and revenue
El sistema DEBE (MUST) computar churn en dos sabores por mes: `churnContractsPct` (contratos dados de baja /
contratos activos al inicio del mes) y `churnRevenuePct` (MRR perdido por baja / MRR inicial del mes). Un
cliente con 2 contratos que da de baja 1 cuenta como churn de 1 contrato, NO como churn de cliente.

#### Scenario: A client with 2 contracts that cancels 1 counts as contraction, not full churn
- GIVEN un cliente con 2 contratos activos, uno de los cuales recibe un evento `deactivated` en el mes
- WHEN se computa el churn del mes
- THEN el contrato dado de baja cuenta en `churnContractsPct`/`churnRevenuePct`, pero el cliente NO se
  considera "churneado" (su otro contrato sigue activo)

#### Scenario: Revenue churn weighs by plan value, not by contract count
- GIVEN dos bajas en el mismo mes: un contrato de 50 Mbps y uno de 500 Mbps, con MRR atribuido distinto
- WHEN se computa `churnRevenuePct`
- THEN el contrato de 500 Mbps pesa más en el resultado que el de 50 Mbps (no es un simple conteo)

### Requirement: Retention cohorts at 3/6/12 months
El sistema DEBE (MUST) agrupar las altas de contrato por mes de cohorte (mes del evento `activated`) y
reportar cuántas de ellas siguen activas 3, 6 y 12 meses después.

#### Scenario: A cohort's 3-month survival is computed correctly
- GIVEN una cohorte de 20 altas en enero, de las cuales 18 siguen activas al cierre de abril (3 meses después)
- WHEN se consulta la cohorte de enero
- THEN `survivingCount` a `monthsElapsed: 3` es `18` sobre `originalCount: 20`

#### Scenario: A cohort younger than 12 months has no 12-month data point
- GIVEN una cohorte de altas de hace 5 meses
- WHEN se consulta esa cohorte
- THEN existen los puntos `monthsElapsed: 3` y `monthsElapsed: 6` (si corresponde) pero NO existe
  `monthsElapsed: 12` (no inventa un dato que no puede existir aún)

### Requirement: CAC and payback, per technology, flags loss-making plans
El sistema DEBE (MUST) computar, por tecnología, `CAC = costoVentaArs + costoInstalacionArs` (de
`FinanceTechnologyCost`) y `paybackMonths = CAC / mrrDelAlta`, y DEBE (MUST) marcar como alerta cualquier
alta cuyo `paybackMonths` exceda `FinanceTargetsConfig.maxPaybackMonths`.

#### Scenario: A sale with fast payback is not flagged
- GIVEN una tecnología con CAC $30.000 y una alta con MRR atribuido $10.000/mes (payback 3 meses) y
  `maxPaybackMonths: 12`
- WHEN se computa el CAC/payback del mes
- THEN esa alta NO aparece en la lista de alertas de venta a pérdida

#### Scenario: A sale with payback beyond the threshold is flagged
- GIVEN la misma tecnología con CAC $30.000, una alta con MRR atribuido $1.500/mes (payback 20 meses) y
  `maxPaybackMonths: 12`
- WHEN se computa el CAC/payback del mes
- THEN esa alta aparece en la lista de ventas a pérdida, con su `paybackMonths` calculado

### Requirement: Early-churn-by-vendor ranking exposes short-lived sales, not just volume
El sistema DEBE (MUST) exponer, por `Contract.vendedor`, tanto el conteo de altas como el conteo de esas
altas que reciben un evento `deactivated` dentro de una ventana temprana configurable (mismo
`maxPaybackMonths` como proxy de "temprano", salvo que el usuario defina otro corte), de forma que un
vendedor con muchas altas pero alto churn temprano NO quede indistinguible de uno con altas sanas.

#### Scenario: A vendor with high volume but high early churn is distinguishable from a healthy one
- GIVEN el vendedor A con 50 altas en el mes de las cuales 30 se dan de baja dentro de la ventana temprana, y
  el vendedor B con 20 altas de las cuales 1 se da de baja en la misma ventana
- WHEN se consulta el ranking de churn temprano por vendedor
- THEN el vendedor A aparece con una tasa de churn temprano (60%) sustancialmente mayor que B (5%), aun
  cuando A tiene más altas totales que B

### Requirement: Net growth by node/AP surfaces technical churn, not just commercial
El sistema DEBE (MUST) computar, por `Contract.networkSiteId`/`accessPointId`, altas menos bajas del mes, de
forma que un nodo con crecimiento neto negativo sea identificable sin necesitar el cruce con `noc-alerts-hub`
(el diseño no cierra la puerta a ese cruce, pero no lo implementa).

#### Scenario: A node with more churn than activations shows negative net growth
- GIVEN un nodo con 2 altas y 8 bajas en el mes
- WHEN se consulta el crecimiento neto por nodo
- THEN ese nodo aparece con `netGrowth: -6`

### Requirement: Cancellation-reason ranking is ordered by lost revenue, not count
El sistema DEBE (MUST) ordenar el ranking de `Contract.motivoBaja` (o `ContractServiceEvent.reason` cuando
`motivoBaja` es null) por MRR perdido acumulado, NO por cantidad de bajas.

#### Scenario: A less-frequent reason with higher-value contracts outranks a frequent low-value one
- GIVEN el motivo "mudanza" con 10 bajas de contratos de $5.000/mes ($50.000 perdidos) y el motivo "precio"
  con 15 bajas de contratos de $2.000/mes ($30.000 perdidos)
- WHEN se consulta el ranking de motivos de baja
- THEN "mudanza" aparece primero pese a tener menos bajas, porque perdió más plata

### Requirement: Nominal vs. inflation-adjusted (real) revenue series
El sistema DEBE (MUST) exponer, para cualquier rango de meses, tanto la serie **nominal** de cobranza (cash
collected, ver Decision 0) como la serie **real** deflactada por `FinanceInflationIndex` encadenado desde
`FinanceTargetsConfig.inflationBaseYearMonth`, además del crecimiento en **contratos** (unidades) y **ARPU**
(cobranza ÷ contratos activos), de forma independiente entre sí.

#### Scenario: Nominal revenue always grows with a fully-loaded inflation series
- GIVEN una serie de 12 meses con IPC cargado para todos los meses y cobranza nominal que subió 40% en
  pesos corrientes pero solo 5% en contratos
- WHEN se consulta la serie nominal
- THEN refleja el +40% sin ajustar

#### Scenario: The real series exposes the true story the nominal series hides
- GIVEN el mismo escenario (cobranza nominal +40%, pero inflación acumulada del período +50%)
- WHEN se consulta la serie real (deflactada)
- THEN el valor real muestra una CAÍDA (no un crecimiento), evidenciando que el crecimiento nominal era
  placebo inflacionario

#### Scenario: A missing month breaks the real series honestly (no silent interpolation)
- GIVEN una serie de 12 meses donde el mes 7 no tiene `FinanceInflationIndex` cargado
- WHEN se consulta la serie real para el rango completo
- THEN la serie real se trunca en el mes 6 (inclusive), el payload incluye
  `realSeriesTruncatedAt: "<mes 7>"`, y la serie nominal y de contratos SIGUEN completas para los 12 meses

### Requirement: Contract-modification listing reuses the existing plan-direction derivation
El sistema DEBE (MUST) exponer las modificaciones de contrato (upgrades/downgrades) reutilizando
`ListInternetServiceHistory` y su criterio de derivación de dirección por `downloadKbps`, sin implementar un
segundo criterio de comparación de planes.

#### Scenario: An upgrade/downgrade shown in finance-growth matches the internet-history page
- GIVEN un evento `modified` de cambio de plan que `ListInternetServiceHistory` clasifica como `upgrade`
- WHEN se consulta el listado de modificaciones de contrato en finance-growth para el mismo rango
- THEN aparece con la misma dirección `upgrade` (no una derivación distinta o inconsistente)

### Requirement: Technology, plan, target and inflation values are editable, row-based where they vary
El sistema DEBE (MUST) permitir editar costo de venta, costo de instalación y costo mensual de servicio por
tecnología (`FinanceTechnologyCost`, una fila por `ContractTechnology.name`), precio estimado por plan
(`FinancePlanPrice`, una fila por `Plan.code`), metas globales (`FinanceTargetsConfig`, singleton: churn
objetivo, payback máximo, meta de altas del mes, mes base de inflación) e índice IPC mensual
(`FinanceInflationIndex`, una fila por mes), y DEBE (MUST) rechazar valores no numéricos o negativos donde
no corresponda (costos, precios, porcentajes) sin aplicar actualizaciones parciales.

#### Scenario: Editing a technology's cost persists and is visible to a subsequent CAC computation
- GIVEN `FinanceTechnologyCost` para "Fibra" no existe aún (defaults en cero)
- WHEN un usuario con `finance:manage_costs` hace `PUT /api/finance/growth/config/technology-costs/Fibra`
  con `costoVentaArs: 15000, costoInstalacionArs: 20000, costoMensualServicioArs: 3000, comisionVentaPct: 5`
- THEN la fila se crea/actualiza, y el próximo cálculo de CAC para "Fibra" usa esos valores

#### Scenario: A negative cost value is rejected without partial update
- GIVEN una fila existente de `FinanceTechnologyCost` para "Wireless", **y "Wireless" existe en el catálogo
  `ContractTechnology`** (si no existiera, el guard de existencia responde `404` antes de validar el payload —
  ver el escenario del 404 más abajo)
- WHEN un usuario con `finance:manage_costs` envía `PUT .../technology-costs/Wireless` con
  `costoInstalacionArs: -500`
- THEN responde `400` y ninguno de los campos de esa fila cambia

#### Scenario: A new technology with no configured cost defaults to zero, never crashes
- GIVEN una tecnología existe en `ContractTechnology` pero nunca se configuró su costo
- WHEN se consulta `GET /api/finance/growth/config/technology-costs`
- THEN esa tecnología aparece en la lista con todos los costos en `0`, no se omite ni rompe la respuesta

#### Scenario: Writing a cost for a technology absent from the catalog is rejected with 404, not silently persisted
> Contrato agregado por la fix wave 1 de la Fase 2. Antes devolvía `200 OK` y persistía una fila que el `GET`
> (LEFT JOIN sobre el catálogo) **nunca mostraba**: el operador creía haber cargado los costos y no lo había
> hecho. En la Fase 3 eso se lee como `cacArs: 0` y `lossMaking: false` para TODAS las altas — un CAC de cero
> no se interpreta como "falta configurar", se interpreta como "todo rentable".
- GIVEN un `technologyName` que NO existe en el catálogo `ContractTechnology` (un typo como "Fibrra", o el
  nombre viejo después de un rename del catálogo)
- WHEN un usuario con `finance:manage_costs` hace `PUT .../technology-costs/Fibrra` con un payload válido
- THEN responde `404` con `code: FINANCE_TECHNOLOGY_NOT_FOUND` y **no persiste ninguna fila**
- AND el mismo criterio aplica a `PUT .../plan-prices/:planCode` con `code: FINANCE_PLAN_NOT_FOUND`
- AND el guard de existencia corre **ANTES** de validar el payload: un nombre inexistente con valores
  inválidos responde `404` (el path identifica el recurso), no `400`

#### Scenario: The persisted key is the catalog's canonical name, not the raw path segment
- GIVEN la tecnología existe en el catálogo como "Fibra"
- WHEN un usuario con `finance:manage_costs` hace `PUT .../technology-costs/fibra` (distinto casing)
- THEN la fila se persiste bajo el nombre canónico "Fibra", **no** se crea una segunda fila variante de casing
  (la resolución del catálogo es case-insensitive y el upsert usa el nombre canónico que devuelve)

#### Scenario: A value exceeding the column's precision is rejected with 400, never a 500
> Contrato agregado por la fix wave 1 de la Fase 2. Las columnas tienen precisión fija y la validación sólo
> chequeaba `isFinite` + rango de negocio, así que el overflow lo rechazaba **Postgres** con un error que no es
> de dominio ⇒ `500 INTERNAL_ERROR` opaco. Caso real: un operador que pega el índice del INDEC en vez de la
> tasa mensual.
- GIVEN la columna `monthlyRatePct` es `Decimal(6,3)` (magnitud máxima `999.999`)
- WHEN un usuario con `finance:manage_inflation` envía `PUT .../config/inflation/2026-01` con
  `monthlyRatePct: 42000`
- THEN responde `400` con un mensaje que nombra la cota de la columna, y no persiste nada
- AND el mismo criterio aplica a los costos (`Decimal(12,2)`), los porcentajes (`Decimal(5,2)`) y los enteros
  (`maxPaybackMonths`/`monthlyNewContractsGoal`, `INTEGER` de 32 bits)

#### Scenario: An empty range filter means "no filter", not an invalid one
- GIVEN la serie de IPC tiene filas cargadas
- WHEN se consulta `GET /api/finance/growth/config/inflation?from=&to=` (lo que emite `URLSearchParams`
  cuando el filtro está sin setear)
- THEN responde `200` con la serie COMPLETA, no `400`
- AND un valor presente pero mal formado (`?from=2026-1`, sin `padStart`) SÍ responde `400`, porque la
  comparación es lexicográfica y devolvería silenciosamente el tramo equivocado de la serie

### Requirement: Two-layer permission model — BE guard + FE gate, module `finance`
El sistema DEBE (MUST) exponer un módulo RBAC nuevo `finance` (separado de `billing`), con acciones `read`,
`manage_costs`, `manage_targets`, `manage_inflation` y reuso de la acción existente `sync`. Toda ruta de
lectura DEBE (MUST) exigir `finance:read`; toda ruta de escritura de configuración DEBE (MUST) exigir la
acción granular correspondiente; el disparo manual del sync completo DEBE (MUST) exigir `finance:sync`. El
BE NUNCA debe aceptar "solo autenticado" como sustituto del guard.

#### Scenario: A user without finance.read cannot see the overview
- GIVEN un usuario autenticado sin `finance:read`
- WHEN hace `GET /api/finance/growth/overview`
- THEN responde `403`

#### Scenario: A user with finance.read but without finance.manage_costs cannot edit costs
- GIVEN un usuario con `finance:read` pero SIN `finance:manage_costs`
- WHEN hace `PUT /api/finance/growth/config/technology-costs/Fibra`
- THEN responde `403` y la fila no cambia

#### Scenario: A user with finance.manage_costs cannot trigger a manual sync without finance.sync
- GIVEN un usuario con `finance:manage_costs` pero SIN `finance:sync`
- WHEN hace `POST /api/finance/growth/sync/run`
- THEN responde `403` y el sync no se dispara

#### Scenario: The FE-facing permission catalog exposes finance.* as dot-namespaced strings
- GIVEN un usuario con los 5 permisos de `finance` asignados
- WHEN consulta `GET /api/auth/me` (o el endpoint equivalente de permisos efectivos)
- THEN el array de permisos incluye `finance.read`, `finance.manage_costs`, `finance.manage_targets`,
  `finance.manage_inflation`, `finance.sync` (namespace con PUNTO, no colon — mismo criterio que el resto
  del catálogo, `ResolveUserPermissions.ts`)

## Testing Notes

Molde de `SyncGestionRealContractsDelta` (cursor de fecha) + `BackfillGrContractsBatch`/
`ArmGrContractsBackfill` (backfill resumible) para el ESQUELETO del ingest de recibos (Fase 1), pero con una
desviación deliberada y obligatoria: a diferencia de esos moldes (que paginan un mes/día COMPLETO dentro de
un solo `execute()`), `SyncGrReceiptsBackfillBatch`/`SyncGrReceiptsDelta` procesan **una sola página GR por
`execute()`** — es lo que hace posible el presupuesto compartido de requests (ver Requirement de pacing). El
árbitro del turno (`FinanceReceiptIngestScheduler`, ver `design.md`) se testea con un **reloj falso
inyectable** (mismo patrón que `isoDate(this.now())` en `GestionRealClient`) para poder simular el paso del
tiempo entre ticks sin `setTimeout` real: casos obligatorios — delta con páginas pendientes gana el turno
sobre backfill con trabajo pendiente; delta sin trabajo y dentro de su `deltaCheckIntervalMs` cede el turno a
backfill; N fallas consecutivas duplican el intervalo efectivo hasta el techo `maxRequestIntervalMs`; un
éxito after degradación resetea el intervalo a `requestIntervalMs` en el acto. Reusar el retry/backoff ya
existente en `GestionRealClient` para las fallas 5xx/timeout de UNA request — NUNCA reimplementarlo; el
backoff del scheduler opera un nivel arriba (espaciado ENTRE ticks), no dentro de una request. `RefreshDebtorBalances`
se testea con su molde existente, solo agregando el caso del estado `4`. Molde `GestionRealIngestConfig`/
`NocAlertThresholdsConfig` para los singletons de configuración (Fase 2/3). Los use cases de métricas
(bridge/churn/cohortes/CAC/ranking) se testean con adapters **in-memory** sobre `FinancePaymentReceipt`/
`FinanceReceiptApplication`/`Contract`/`ContractServiceEvent`/los modelos de Fase 2/3 — NUNCA mockear Prisma.
Los tests de "atribución multi-contrato" (Decision 1 de `design.md`) son el punto más crítico del seam: cada
escenario de este spec (`exact`/`estimated`/`estimated-equal`) necesita su propio test con fixtures reales de
`ContractServiceEvent` + `FinanceReceiptApplication`, no solo el cálculo aritmético aislado. El parser de
`recibos` necesita un test explícito de normalización dict→lista (fixture con `aplicaciones` como objeto
keyed-by-id, igual que el fixture ya usado para `clientes_consulta`) y un test de exclusión de anulados. Los
tests de rutas usan supertest con repos in-memory inyectados y cubren los 2 caminos de permisos (con/sin cada
acción) por endpoint de escritura. El test de la serie real truncada (`realSeriesTruncatedAt`) es
obligatorio — es el escenario que previene el placebo inflacionario que motivó el pedido completo.
