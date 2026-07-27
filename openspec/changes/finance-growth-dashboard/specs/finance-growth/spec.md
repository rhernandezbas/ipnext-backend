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
"Finanzas"). **Fuera de alcance de este spec**: cualquier página del módulo `billing`
existente, costo de instalación REAL desde inventario (fase posterior, documentada como extensión en
`design.md`), reconstrucción de facturación emitida (técnicamente imposible con la API actual), y sync/
escritura hacia GR fuera de lectura de recibos/facturas.

**REWORK 2026-07-27 — DOS NÚMEROS, DOS PREGUNTAS (decisión LOCK del usuario, ver Requirement "MRR bridge" y
"Cobranza real y tasa de cobranza" más abajo).** Una re-review adversarial encontró que el bridge de MRR
original (definido sobre cobranza) es estructuralmente incapaz de cerrar: cash se mueve por mora, pagos
adelantados, regularizaciones e inflación — ninguno de los cuales es un evento de contrato. Este spec ahora
distingue explícitamente DOS números que responden DOS preguntas distintas, nunca mezclados:
1. **MRR CONTRATADO** (Σ precio de plan × contratos activos) — el bridge corre sobre ESTO y cierra por
   construcción, porque esta base sólo cambia por altas/upgrades/downgrades/bajas. Responde *"¿crece la base y
   su valor?"*.
2. **COBRANZA REAL** (cash collected, sin cambios respecto de la definición original — `FinanceReceiptItem`,
   nunca facturación emitida) — serie propia, SIN bridge. Responde *"¿entró plata?"*.
3. **Tasa de cobranza** (cobranza / MRR contratado) conecta ambas series.

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

#### Scenario: An application with a null appliedDate still reaches unclassifiedAmountArs (rework 2026-07-27, F9)
- GIVEN una aplicación con `grType` sin clasificar y `appliedDate: null` (el campo puede faltar en el wire),
  pero cuyo recibo padre tiene `fechaRecibo` dentro del mes consultado
- WHEN se computa `unclassifiedAmountArs` del mes
- THEN el monto de esa aplicación SÍ se cuenta (el corte es por `receipt.fechaRecibo`, nunca por el
  `appliedDate` propio y nullable de la aplicación) — el watchdog que existe específicamente para que la plata
  mal clasificada nunca desaparezca no puede tener el mismo agujero de fecha que se corrigió para `items`

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

> **REWORK 2026-07-27**: esta atribución (Capa A/Capa B) YA NO alimenta el bridge de MRR (ese rol pasó a MRR
> CONTRATADO, ver Decision 1b de `design.md`) — sigue existiendo como diagnóstico de cobranza (ARPU,
> `attributionPct`). La población que mide `attributionPct` se corrigió (F6): antes excluía contratos que se
> daban de baja durante el mes del denominador, escondiendo hasta la mitad del cash real de algún mes; ahora
> incluye TODO contrato de internet tocado durante el mes (activo al cierre O dado de baja durante el mes).

El sistema DEBE (MUST) separar explícitamente (a) la verdad contable de cobranza total por mes (Capa A,
directa de `FinanceReceiptApplication` neteada, sin estimación) de (b) la atribución de esa cobranza a nivel
de CONTRATO individual (Capa B, estimación cuando el cliente tiene más de un contrato activo), y DEBE (MUST)
exponer el porcentaje de cobranza atribuible con confianza en cada snapshot mensual.

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

#### Scenario: Monthly snapshot exposes the attributable-cash percentage
- GIVEN un mes con una mezcla de contratos `exact`/`estimated`/`estimated-equal`
- WHEN se consulta el snapshot de ese mes vía la API de overview
- THEN el payload incluye `attributionPct` = (cobranza de contratos `exact`) / (cobranza total atribuida a
  TODOS los contratos de internet tocados el mes), sin disimular el número aunque sea bajo

#### Scenario: A contract that collects cash and then churns mid-month is not invisible to attributionPct (rework 2026-07-27, F6)
- GIVEN dos contratos de internet: uno cobra su cuota y se da de baja a mitad de mes, el otro sobrevive
  cobrando el mismo monto
- WHEN se computa `attributionPct` del mes
- THEN el denominador incluye la cobranza de AMBOS contratos, no sólo la del que sigue activo al cierre — el
  contrato que se fue no queda invisible a la métrica ni esconde su mitad del cash real del mes

#### Scenario: ARPU divides by internet-client cash only, never the whole-company cobranza figure (rework 2026-07-27, F5)
- GIVEN un mes con un cliente de internet que paga su cuota y un cliente SIN ningún contrato de internet
  (ej. sólo TV) que paga un monto mucho mayor
- WHEN se computa `arpuArs`
- THEN el numerador es SÓLO la cobranza atribuida a clientes con contrato de internet activo al cierre del
  mes — el pago del cliente sin internet cuenta en `revenueTotalArs` (Capa A, cobranza total) pero NUNCA en
  `arpuArs`

### Requirement: MRR bridge (waterfall) per month, over MRR CONTRATADO — never over cash

> **REWORK 2026-07-27 (decisión LOCK, Decision 1b de `design.md`)**: el bridge original corría sobre cobranza
> (cash). Una re-review adversarial + cálculo a mano demostró que eso es estructuralmente incorrecto — el cash
> se mueve por mora, pagos adelantados, regularizaciones e inflación, ninguno de los cuales es
> altas/upgrades/downgrades/bajas. El bridge se REDEFINE para correr sobre **MRR CONTRATADO** (Σ precio de
> plan × contratos activos, vía `FinancePlanPrice`) — una base que sólo cambia por esos 4 eventos, así que
> cierra por construcción. La cobranza real SIGUE existiendo (ver el Requirement "Cobranza real y tasa de
> cobranza" nuevo, más abajo) — simplemente deja de ser la base del bridge.

El sistema DEBE (MUST) computar, para cada mes con datos, el bridge `MRR contratado inicial → +altas →
+upgrades − downgrades − bajas = MRR contratado final`, derivado de `ContractServiceEvent` (eventType
`activated`/`deactivated`/`reactivated`/`modified`) cruzado con `FinancePlanPrice`. `mrrInicialArs`/
`mrrFinalArs` se computan FRESH en cada corrida (nunca encadenados de un snapshot anterior almacenado) — un
mes salteado en el histórico de snapshots NUNCA debe poder zeroear silenciosamente la base de un mes
posterior.

#### Scenario: An activation adds to mrrNewArs
- GIVEN un contrato con un evento `activated` dentro del mes, activo al cierre del mes, con precio de plan
  resoluble
- WHEN se computa el snapshot del mes
- THEN su precio de plan (al cierre del mes, subsumiendo cualquier upgrade/downgrade posterior dentro del
  mismo mes) suma a `mrrNewArs` del bridge

#### Scenario: A plan upgrade adds the price delta to mrrUpgradeArs
- GIVEN un contrato YA activo al inicio del mes, con un evento `modified` de cambio de plan dentro del mes
  donde AMBOS planes (viejo y nuevo) tienen fila en `FinancePlanPrice`
- WHEN se computa el snapshot del mes
- THEN la diferencia de PRECIO (nuevo − viejo, sólo si es positiva) suma a `mrrUpgradeArs` — este bucket es
  price-sign based, NO el mismo criterio kbps-based que `contractsUpgraded`/`ListInternetServiceHistory` (un
  cambio de plan "lateral", mismos kbps pero distinto precio, SÍ mueve este bucket aunque no tenga dirección
  kbps)

#### Scenario: A plan downgrade subtracts the price delta into mrrDowngradeArs
- GIVEN el mismo contexto pero la diferencia de precio es negativa
- WHEN se computa el snapshot del mes
- THEN el valor absoluto de la diferencia resta en `mrrDowngradeArs`

#### Scenario: A plan-change event with an unresolvable price is excluded, never guessed as zero
- GIVEN un contrato activo al inicio del mes con un evento `modified` donde el plan VIEJO, el NUEVO, o ambos,
  NO tienen fila en `FinancePlanPrice`
- WHEN se computa el snapshot del mes
- THEN ese evento NO contribuye a `mrrUpgradeArs` ni a `mrrDowngradeArs` (nunca trata el lado sin precio como
  si valiera `0` — eso triplicaba el delta real en el bug medido antes de este rework), y se cuenta en
  `unpricedPlanChangeEvents`

#### Scenario: A plan-change event that lands on an enforcement code is excluded from the money buckets, even if that code has a price (fix-wave-3 🔴 1)
> Re-review con aritmética verificada (fix-wave-3): el conteo kbps-based (`contractsUpgraded`/
> `contractsDowngraded`, vía `deriveDirection`) y `mrrInicialArs`/`mrrFinalArs` (vía `resolvedPlanCodeAt`) ya
> excluían los códigos de enforcement (`IP-REDUCCION`/`IP-BAJA`); este bucket de PLATA era el único de los tres
> que no lo hacía. Medido: un solo evento `IP-100(15000)`→`IP-REDUCCION` con `IP-REDUCCION` PRICEADA en
> `FinancePlanPrice` (5000) — algo alcanzable desde la UI, `GetFinancePlanPrices`/`UpdateFinancePlanPrice` no
> excluyen estos códigos del catálogo editable — producía un `mrrDowngradeArs` fantasma de 10000 y un gap del
> bridge de -10000, pese a que el contrato NUNCA cambió su plan comercial real.
- GIVEN un contrato activo al inicio del mes con un evento `modified` donde el plan VIEJO, el NUEVO, o ambos,
  son un código de ENFORCEMENT (`IP-REDUCCION`/`IP-BAJA`) — incluso si ese código tiene una fila en
  `FinancePlanPrice`
- WHEN se computa el snapshot del mes
- THEN ese evento NO contribuye a `mrrUpgradeArs` ni a `mrrDowngradeArs` (nunca se trata como un cambio
  comercial real), y se cuenta por separado en `enforcementPlanChangeEventsExcluded` — nunca en silencio, y
  nunca mezclado con `unpricedPlanChangeEvents` (acá el precio SÍ puede ser resoluble; la exclusión es por el
  código en sí)

#### Scenario: A deactivation subtracts from mrrChurnArs — only for a contract that does NOT come back same month
- GIVEN un contrato activo al inicio del mes, con un evento `deactivated` dentro del mes, y SIN volver a estar
  activo al cierre del mismo mes
- WHEN se computa el snapshot del mes
- THEN su precio de plan (al momento de la baja, incluyendo cualquier upgrade/downgrade previo dentro del
  mismo mes) resta de `mrrChurnArs`

#### Scenario: A same-month deactivation+reactivation does NOT count as churn for the bridge
- GIVEN un contrato activo al inicio del mes que recibe un evento `deactivated` y luego `reactivated` DENTRO
  del mismo mes (el cliente nunca se fue realmente)
- WHEN se computa el snapshot del mes
- THEN ese contrato NO resta de `mrrChurnArs` y su precio sigue contando en `mrrFinalArs` sin cambios — aunque
  los contadores RAW `contractsNew`/`contractsChurned` (informativos, actividad cruda) sí reflejan que
  ocurrieron ambos eventos

#### Scenario: A same-month activation+deactivation contributes zero to the bridge, not a phantom gap
- GIVEN un contrato que se activa Y se da de baja dentro del MISMO mes (nunca estuvo activo ni al inicio ni al
  cierre del mes)
- WHEN se computa el snapshot del mes
- THEN no contribuye a `mrrInicialArs`, `mrrNewArs`, `mrrChurnArs` ni `mrrFinalArs` — su paso por el mes neteó
  a cero, consistente con no estar activo en ninguno de los dos extremos

#### Scenario: The bridge is internally consistent — EXACT, not just within tolerance, when every touched contract is priced
- GIVEN un snapshot mensual ya calculado donde todo contrato tocado por altas/upgrades/downgrades/bajas ese
  mes tiene precio de plan resoluble en ambos extremos de su transición
- WHEN se suman `mrrInicialArs + mrrNewArs + mrrUpgradeArs − mrrDowngradeArs − mrrChurnArs`
- THEN el resultado es EXACTAMENTE igual a `mrrFinalArs` del mismo snapshot (la tolerancia de redondeo ≤ 1
  unidad de moneda sigue siendo el techo aceptable, no el resultado esperado en el caso completamente priceado)

#### Scenario: A bridge that does NOT close exposes the gap as bridgeResidualArs, never silently (fix-wave-3 🟡 4)
> Re-review con aritmética verificada: antes de este campo, un caso donde el bridge no cerraba (un extremo sin
> precio, un evento `'modified'` perdido por el `try/catch` best-effort de `ChangePppoePlanService`, o
> cualquier caso futuro no previsto) no dejaba NINGUNA señal — el gap medido llegaba a -15000 con
> `unpricedContractsActive: 0`, ninguna bandera apuntando al problema.
- GIVEN un snapshot mensual donde `mrrInicialArs + mrrNewArs + mrrUpgradeArs − mrrDowngradeArs − mrrChurnArs`
  NO es igual a `mrrFinalArs` (por ejemplo, un evento de cambio de plan con el precio VIEJO irresoluble)
- WHEN se consulta el snapshot
- THEN `bridgeResidualArs` = `mrrFinalArs − (mrrInicialArs + mrrNewArs + mrrUpgradeArs − mrrDowngradeArs −
  mrrChurnArs)`, EXACTAMENTE `0` en el caso sano y el valor real del hueco en cualquier otro caso — nunca
  omitido del payload

### Requirement: Contracted-price visibility — a contract with no resolvable price is never a silent zero

> **NUEVO (rework 2026-07-27, F2)** — consecuencia directa de que el bridge ahora dependa de `FinancePlanPrice`:
> un contrato sin precio resoluble (plan code irresoluble, o plan sin fila en `FinancePlanPrice`) contribuye
> `0` al MRR contratado. Ese `0` DEBE (MUST) ser visible, nunca indistinguible de "el contrato realmente vale
> cero".
>
> **fix-wave-2 (2026-07-27) — la fuente del plan es `PppoeService.profile`** (el ÚNICO campo que
> `ChangePppoePlanService` escribe en un cambio de plan real, y que stampea el MISMO valor en el
> `oldPlan`/`newPlan` del `ContractServiceEvent` `'modified'` que registra), rebobinado hacia atrás con la
> historia `'modified'` del contrato (`contractLifecycle.resolvedPlanCodeAt`) para resolver el plan en
> cualquier mes pasado. Esto da cobertura COMPLETA para todo contrato con un `PppoeService` resoluble — antes,
> un contrato que JAMÁS tuvo un evento `'modified'` real quedaba `unpriced` de por vida, aunque estuviera
> conectado y pagando desde el día uno.

#### Scenario: An active contract with an unresolvable price is counted, not hidden
- GIVEN un contrato activo al cierre del mes cuyo precio no puede resolverse (sin `PppoeService` resoluble en
  absoluto, o plan resuelto sin fila en `FinancePlanPrice`)
- WHEN se computa el snapshot del mes
- THEN ese contrato NO suma a `mrrFinalArs`, y se cuenta en `unpricedContractsActive`/`unpricedContractsPct`
  del snapshot

#### Scenario: A contract that never had a plan-change event still has a resolvable price, sourced from its PppoeService profile
- GIVEN un contrato activo con un `PppoeService` cuyo `profile` es un plan con fila en `FinancePlanPrice`, pero
  SIN ningún evento `'modified'` de cambio de plan en su historia
- WHEN se computa el snapshot del mes
- THEN su precio de plan se resuelve igual (desde `PppoeService.profile`) y suma a `mrrFinalArs` — NO se cuenta
  en `unpricedContractsActive`

#### Scenario: A contract cut for mora keeps its full contracted price — enforcement never zeroes the MRR
- GIVEN un contrato con `PppoeService.enforcedState` en `'reduced'` o `'blocked'` (corte por mora), cuyo
  `profile` sigue siendo su plan comercial (el enforcement NUNCA pisa `profile` — ver
  `RouterOsEnforcementAdapter`/`OrchestratorEnforcementAdapter`, que parchean el router/orchestrator, nunca la
  fila de `PppoeService`)
- WHEN se computa el snapshot del mes
- THEN el contrato sigue sumando su precio COMPLETO a `mrrFinalArs` — estar cortado NO es lo mismo que no
  tener plan contratado

### Requirement: Real cash collection and the collection rate — a series independent of the MRR bridge

> **NUEVO (rework 2026-07-27, decisión LOCK #2/#3)** — la cobranza real (cash puro, sin cambios respecto de
> la definición original de "cash collected") sigue existiendo como serie PROPIA, sin bridge. La tasa de
> cobranza es la métrica nueva que conecta esta serie con el MRR contratado.
>
> **fix-wave-3 (🔴 2, re-review con aritmética verificada)** — el numerador de `collectionRatePct` se corrigió
> de `revenueTotalArs` (Capa A, cash de TODO el universo — incluye clientes SOLO-TV, decisión LOCK) a
> `revenueInternetAttributedArs` (Capa B, cash atribuido a contratos de internet — la MISMA población que
> `mrrFinalArs`, el denominador). Mezclar una población whole-company contra un denominador internet-only
> dejaba pasar valores > 100% para una base que pagó EXACTAMENTE lo que debía: medido, 1 contrato de internet
> (MRR 10000) que paga 10000 exacto + 1 cliente SOLO-TV que paga 40000 daba `collectionRatePct: 500` cuando la
> verdad es `100`. `revenueTotalArs` en sí (Capa A, expuesto aparte) NO cambia — sigue siendo cash de TODO el
> universo, sin bridge.

El sistema DEBE (MUST) exponer `revenueTotalArs` (cash collected, `FinanceReceiptItem`, TODO el universo,
sin bridge — Requirement "growth metric basis" sin cambios) y `collectionRatePct` = `revenueInternetAttributedArs
/ mrrFinalArs * 100` (misma población — internet — en ambos lados de la razón, NUNCA `revenueTotalArs`, que
incluye clientes sin contrato de internet), `null` cuando `mrrFinalArs` es `0` (sin base contratada contra la
cual comparar — nunca un `0%` que insinúe "no se cobró nada").

#### Scenario: A non-paying debtor does not distort the contracted MRR bridge
- GIVEN un contrato activo TODO el mes sin ningún evento de contrato, cuyo cliente no paga NADA ese mes
- WHEN se computa el snapshot del mes
- THEN `mrrInicialArs`/`mrrFinalArs` del contrato NO cambian (siguen reflejando su precio contratado), y
  `revenueTotalArs` refleja el cash real (0 de este contrato) de forma completamente independiente

#### Scenario: A collection rate below 100% signals payment lag, not a lie about the contracted base
- GIVEN un mes donde `revenueInternetAttributedArs` es menor que `mrrFinalArs`
- WHEN se consulta el snapshot
- THEN `collectionRatePct` refleja ese déficit (< 100), sin que el bridge de MRR contratado se vea afectado

#### Scenario: A TV-only client's cash never inflates collectionRatePct past what internet clients actually paid (fix-wave-3 🔴 2)
- GIVEN un contrato de internet con MRR contratado 10000 que paga exactamente 10000 ese mes, y un cliente
  SOLO-TV (sin contrato de internet) que paga 40000 el mismo mes
- WHEN se computa el snapshot del mes
- THEN `revenueTotalArs` es 50000 (Capa A, sin cambios — todo el universo), pero `collectionRatePct` es `100`
  (NUNCA 500) — el numerador de la tasa está scopeado a la MISMA población de internet que `mrrFinalArs`

### Requirement: Churn is measured at the contract level, in both units and revenue
El sistema DEBE (MUST) computar churn en dos sabores por mes: `churnContractsPct` (contratos dados de baja /
contratos activos al inicio del mes) y `churnRevenuePct` (MRR contratado perdido por baja / MRR contratado
inicial del mes). Un cliente con 2 contratos que da de baja 1 cuenta como churn de 1 contrato, NO como churn
de cliente. Ninguno de los dos cuenta un contrato que se activó y se dio de baja DENTRO del mismo mes (nunca
estuvo en la base de inicio de mes), ni uno que se dio de baja y volvió a activarse dentro del mismo mes (el
cliente nunca se fue realmente).

#### Scenario: A client with 2 contracts that cancels 1 counts as contraction, not full churn
- GIVEN un cliente con 2 contratos activos, uno de los cuales recibe un evento `deactivated` en el mes
- WHEN se computa el churn del mes
- THEN el contrato dado de baja cuenta en `churnContractsPct`/`churnRevenuePct`, pero el cliente NO se
  considera "churneado" (su otro contrato sigue activo)

#### Scenario: An activation-and-cancellation within the same month never pushes churnContractsPct past 100%
- GIVEN una base de N contratos activos al inicio del mes que no se mueven, más M contratos que se activan Y
  se dan de baja dentro del mismo mes
- WHEN se computa el churn del mes
- THEN `churnContractsPct` NO cuenta esos M contratos (nunca estuvieron en la base de inicio de mes) — el
  resultado nunca puede superar el 100% de la base real

#### Scenario: churnRevenuePct is null, never a lying zero, when there is no starting base to measure against
- GIVEN un mes donde no había NINGÚN contrato activo al inicio del mes (o el snapshot del mes anterior nunca
  se computó — el cálculo es fresco, no depende de que exista)
- WHEN se consulta `churnRevenuePct`
- THEN el valor es `null` — nunca un `0` que un lector confunda con "no hubo churn"

#### Scenario: Revenue churn weighs by contracted plan price, not by contract count
- GIVEN dos bajas en el mismo mes: un contrato de 50 Mbps y uno de 500 Mbps, con precio de plan contratado
  distinto
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

#### Scenario: A contract whose only recorded event is `reactivated` belongs to no cohort (rework 2026-07-27, F8)
- GIVEN un contrato cuyo evento MÁS ANTIGUO registrado es `reactivated` (su `activated` real precede al
  histórico rastreado, ej. datos legacy) — NUNCA tuvo un evento `activated` en el log
- WHEN se agrupan las altas por mes de cohorte
- THEN ese contrato NO se asigna a NINGÚN mes de cohorte (ni al mes de su `reactivated`, ni a ningún otro) —
  no se inventa un mes de alta que no se puede determinar, y NO infla el `originalCount` de la cohorte del
  mes en que ocurrió la reactivación

#### Scenario: A cohort month never computed at all is distinguishable from one with no altas (fix-wave-4 🟡9)
> Medido en prod: el backfill de `FinanceCohortSnapshot` nunca corrió — `GET /cohorts` responde el `[]` mudo
> que `/overview` ya había aprendido a no devolver por su cuenta (`monthsWithoutSnapshot`).
- GIVEN un rango de meses donde `FinanceCohortSnapshot` NO tiene ninguna fila (el job/backfill nunca corrió
  para esos meses)
- WHEN se consulta `GET /cohorts` para ese rango
- THEN `cohorts` es `[]` PERO `monthsWithoutCohortSnapshot` lista cada uno de esos meses — el FE puede
  distinguir "no computado todavía" de "no hubo altas ese mes" (que en cambio SÍ aparecería como una fila con
  `originalCount: 0`, si el job corrió y encontró cero altas)

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

#### Scenario: Altas whose technology cannot be classified are surfaced, never silently read as "no sales" (fix-wave-4 🔴2)
> `Contract.technology` es `null` para la MAYORÍA de los contratos derivados de GR (ver
> `ContractRepository.findFinanceDetailsByIds`). Antes de este fix, esas altas desaparecían de
> `altasDelMes` en TODAS las tecnologías sin ninguna señal — la respuesta decía "CAC $X, cero ventas este
> mes" cuando la verdad era "N ventas reales que no puedo clasificar".
- GIVEN 5 altas reales del mes con cash cobrado, `technology: null` en las 5, y un costo configurado para
  "Fibra"
- WHEN se consulta `GET /cac?technology=Fibra&yearMonth=...`
- THEN `altasDelMes` es `[]` (correcto, ninguna resuelve a "Fibra"), pero `altasDelMesSinTecnologia: 5`
  distingue explícitamente "no vendiste" de "vendiste pero no sé de qué tecnología"

#### Scenario: The technology filter matches case-insensitively, same criterion as the catalog's own resolution (fix-wave-4 🟡6)
- GIVEN un contrato con `Contract.technology: "fibra"` (minúscula) y el catálogo `ContractTechnology` tiene
  "Fibra" (con mayúscula) como nombre canónico
- WHEN se consulta `GET /cac?technology=Fibra&yearMonth=...`
- THEN esa alta aparece en `altasDelMes` — el mismatch de casing NUNCA la excluye en silencio

#### Scenario: A configured cost row whose values are all zero is distinguishable from "no configurado" (fix-wave-4 🟡7)
> Las 3 columnas de `FinanceTechnologyCost` son `@default(0)` — una fila creada y nunca completada es
> indistinguible de una tecnología genuinamente gratuita bajo `costConfigured: true` solo.
- GIVEN una fila de `FinanceTechnologyCost` EXISTE para "Fibra" pero sus 3 columnas están en `0`
- WHEN se consulta `GET /cac?technology=Fibra&yearMonth=...`
- THEN `costConfigured: true` Y `costIsZero: true` — el FE puede distinguir "cargado en cero" de "nunca
  cargado" (`costConfigured: false`)

### Requirement: Early-churn-by-vendor ranking exposes short-lived sales, not just volume
El sistema DEBE (MUST) exponer, por `Contract.vendedor`, tanto el conteo de altas como el conteo de esas
altas que reciben un evento `deactivated` dentro de una ventana temprana configurable (mismo
`maxPaybackMonths` como proxy de "temprano", salvo que el usuario defina otro corte), de forma que un
vendedor con muchas altas pero alto churn temprano NO quede indistinguible de uno con altas sanas. La
ventana "temprana" se mide en meses calendario DESDE LA FECHA REAL DE LA ALTA (no desde el 1° del mes en que
ocurrió) — dos altas del mismo mes pero de días distintos tienen cutoffs distintos.

#### Scenario: A vendor with FEWER sales but a HIGHER early-churn rate ranks first (fix-wave-4 🔵14 — discriminating fixture)
> El escenario anterior de este Requirement (A: 50 altas/60% vs B: 20 altas/5%) NO discriminaba el bug que
> decía cubrir — A ganaba tanto por tasa CUANTO por volumen, así que un ranking por volumen puro también
> hubiera pasado el test. Reemplazado por un fixture donde el criterio de volumen y el de tasa DIVERGEN.
- GIVEN el vendedor A con 10 altas maduras de las cuales 8 se dan de baja dentro de la ventana temprana
  (80%), y el vendedor B con 50 altas maduras de las cuales 5 se dan de baja en la misma ventana (10%)
- WHEN se consulta el ranking de churn temprano por vendedor
- THEN el vendedor A aparece PRIMERO pese a tener 5 veces menos altas que B — el orden es por
  `earlyChurnPct`, nunca por volumen

#### Scenario: Immature altas are excluded from the denominator, not counted as silent successes (fix-wave-4 🟡5)
> Antes de este fix, `earlyChurnPct` dividía por `altasTotal` (TODAS las altas del rango, maduras o no). Una
> alta de la semana pasada que técnicamente no tuvo tiempo de fallar todavía contaba como "no churneó",
> diluyendo la tasa real y hundiendo en el ranking a vendedores cuyas ventas más recientes simplemente no
> maduraron aún.
- GIVEN un vendedor con 10 altas maduras (su ventana ya cerró) de las cuales 5 churnearon temprano, MÁS 10
  altas de la semana pasada (su ventana todavía no cerró y ninguna churneó todavía)
- WHEN se consulta el ranking de churn temprano por vendedor
- THEN `altasMaduras: 10` (NO 20), `altasChurneadasTemprano: 5`, y `earlyChurnPct: 50` (NO 25) — las
  altas inmaduras se exponen (`altasTotal: 20`) pero NO diluyen la tasa
- AND si TODAS las altas de un vendedor son inmaduras (`altasMaduras: 0`), `earlyChurnPct` es `null`, nunca
  un `0%` adivinado

#### Scenario: An alta on the last day of the month gets its FULL window, not one truncated to the 1st (fix-wave-4 🔴4)
> El código anterior media la ventana desde el 1° del mes calendario de la alta, no desde la fecha real —
> una alta del día 31 perdía hasta 30 días de su propia ventana, subestimando el churn temprano
> sistemáticamente en los vendedores que cierran ventas a fin de mes.
- GIVEN una alta ocurrida el día 31 de un mes, con una ventana de 6 meses, y una baja ~160 días después (DENTRO
  de los 6 meses calendario reales desde el día 31, pero fuera de los 6 meses medidos desde el día 1)
- WHEN se consulta el ranking de churn temprano por vendedor
- THEN esa baja SÍ cuenta como churn temprano — la ventana se mide desde la fecha REAL de la alta

### Requirement: Net growth by node/AP surfaces technical churn, not just commercial
El sistema DEBE (MUST) computar, por `Contract.networkSiteId`/`accessPointId`, altas menos bajas del mes, de
forma que un nodo con crecimiento neto negativo sea identificable sin necesitar el cruce con `noc-alerts-hub`
(el diseño no cierra la puerta a ese cruce, pero no lo implementa). Una misma venta nunca debe contarse dos
veces: un contrato con evento `activated` Y `reactivated` dentro del mismo rango cuenta como UNA sola alta
(fix-wave-4 🟡8 — mismo criterio de deduplicación que `/cac` y `/vendors/early-churn`).

#### Scenario: A node with more churn than activations shows negative net growth
- GIVEN un nodo con 2 altas y 8 bajas en el mes
- WHEN se consulta el crecimiento neto por nodo
- THEN ese nodo aparece con `netGrowth: -6`

#### Scenario: An activated+reactivated pair on the same contract counts as ONE alta (fix-wave-4 🟡8)
- GIVEN un contrato con un evento `activated` y, más tarde en el mismo rango, un evento `reactivated`
- WHEN se consulta el crecimiento neto de su nodo
- THEN `altas` cuenta ESE contrato una sola vez, no dos — el mismo criterio que `/cac`'s dedup por
  `contractId` evita que el mismo mes muestre un conteo de altas distinto entre endpoints

### Requirement: Cancellation-reason ranking is ordered by lost revenue, not count
El sistema DEBE (MUST) ordenar el ranking de `Contract.motivoBaja` (o `ContractServiceEvent.reason` cuando
`motivoBaja` es null) por MRR perdido acumulado, NO por cantidad de bajas. `motivo` se normaliza (trim +
comparación case-insensitive) antes de agrupar — un mismo motivo con distinto casing o espacios en blanco
(datos GR de texto libre, sin vocabulario fijo) NUNCA parte la plata en dos filas (fix-wave-4 🟡10).

#### Scenario: A less-frequent reason with higher-value contracts outranks a frequent low-value one
- GIVEN el motivo "mudanza" con 10 bajas de contratos de $5.000/mes ($50.000 perdidos) y el motivo "precio"
  con 15 bajas de contratos de $2.000/mes ($30.000 perdidos)
- WHEN se consulta el ranking de motivos de baja
- THEN "mudanza" aparece primero pese a tener menos bajas, porque perdió más plata

#### Scenario: Unpriced bajas are surfaced per motivo, never silently collapsed to $0 (fix-wave-4 🔴3)
> Medido en prod: `FinancePlanPrice` está VACÍA (387/387 contratos sin precio). Sin este campo, TODAS las
> filas leen `mrrPerdidoArs: 0`, el orden DESC colapsa a orden de inserción, y la razón de ser del endpoint
> (rankear por plata, no por cantidad) desaparece sin ninguna señal.
- GIVEN `FinancePlanPrice` completamente vacía, 3 bajas de motivo "Precio" y 10 de "Mudanza", todas con un
  plan que no resuelve a ningún precio
- WHEN se consulta el ranking de motivos de baja
- THEN ambas filas muestran `mrrPerdidoArs: 0` PERO `bajasSinPrecio: 3` y `bajasSinPrecio: 10`
  respectivamente — el FE puede distinguir "no perdieron plata" de "no puedo calcular cuánta plata perdieron"

#### Scenario: "Contrato" and "  Contrato  " group under one row, never two (fix-wave-4 🟡10)
- GIVEN dos bajas, una con `motivoBaja: "Contrato"` y otra con `motivoBaja: "  Contrato  "` (espacios en
  blanco de más, dato GR de texto libre)
- WHEN se consulta el ranking de motivos de baja
- THEN ambas bajas caen en la MISMA fila (`bajas: 2`), no en dos filas separadas que parten la plata perdida

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
- THEN la serie real se trunca en el mes 6 (inclusive), el payload incluye `"<mes 7>"` y todo mes posterior
  en `realSeriesMissingMonths`, y la serie nominal y de contratos SIGUEN completas para los 12 meses

#### Scenario: A gap in EACH direction leaves a non-contiguous set of real months, never describable by a single cutoff (fix-wave-4 🔴1)
> `realSeriesTruncatedAt: string | null` (un solo mes) reemplazado por `realSeriesMissingMonths: string[]`
> (la lista exhaustiva). Medido: `base=2026-03`, rango `[2026-01, 2026-06]`, IPC cargado SOLO en 2026-03 y
> 2026-04 ⇒ el conjunto de meses con valor real es `{02, 03, 04}` (NO contiguo desde el principio del rango)
> mientras `{01, 05, 06}` quedan sin valor — un único `truncatedAt` no puede describir esta forma; el FE no
> podía derivar la nulidad de 02/03/04 (que SÍ tienen valor) a partir de ese campo.
- GIVEN IPC cargado únicamente en los meses que encadenan hacia 2026-02, 2026-03 (base) y 2026-04, con huecos
  tanto antes como después de esos tres meses dentro del rango pedido
- WHEN se consulta la serie real para `[2026-01, 2026-06]`
- THEN `realSeriesMissingMonths` es exactamente `["2026-01", "2026-05", "2026-06"]`, y `mrrFinalRealArs` es
  un valor real (no `null`) para 2026-02/03/04

#### Scenario: A chain gap chronologically before "from" never leaks into the response (fix-wave-4 🟡13)
> Antes de este fix, un hueco entre `inflationBaseYearMonth` y `from` (necesario solo para encadenar hasta
> el rango visible, pero cronológicamente ANTERIOR a él) se reportaba como `truncatedAt`, una coordenada
> fuera del rango pedido — inútil para el FE, que nunca preguntó por ese mes.
- GIVEN `inflationBaseYearMonth` muy anterior al rango pedido, con un hueco de IPC entre la base y el rango
  visible que rompe la cadena antes de llegar a `from`
- WHEN se consulta la serie real para ese rango
- THEN `realSeriesMissingMonths` sólo contiene meses DENTRO de `[from, to]` — nunca el mes del hueco si ese
  mes cae fuera del rango pedido

### Requirement: Contract-modification listing reuses the existing plan-direction derivation
El sistema DEBE (MUST) exponer las modificaciones de contrato (upgrades/downgrades) reutilizando
`ListInternetServiceHistory` y su criterio de derivación de dirección por `downloadKbps`, sin implementar un
segundo criterio de comparación de planes.

> **Alcance corregido (fix-wave-3, deriva de artefactos detectada por la re-review)**: este Requirement
> aplica al listado de modificaciones y a los CONTADORES `contractsUpgraded`/`contractsDowngraded`
> (kbps-based, vía `deriveDirection`) — NUNCA a `mrrUpgradeArs`/`mrrDowngradeArs` (PLATA), que son
> deliberadamente price-sign based (ver el Requirement "MRR contracted bridge..." más arriba, escenario "A
> plan upgrade adds the price delta..."): un cambio "lateral" (mismos kbps, precio distinto) no tiene
> dirección kbps pero SÍ mueve plata, y `deriveDirection` lo clasificaría como `null`. Los dos criterios son
> ejes ortogonales E INTENCIONALMENTE distintos — no es una violación de este Requirement, es el "segundo
> criterio de comparación" correcto para una pregunta distinta (actividad en unidades vs. impacto en plata).
> Esta nota corrige una lectura ambigua del texto original, no cambia comportamiento.

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

#### Scenario: A monthlyRatePct of -100 or worse is rejected, it breaks the chained-index math (fix-wave-4 🟡12)
> `-100` produce `chainedIndex = 0` en `buildChainedIndex` (división por cero) ⇒ `mrrFinalRealArs: Infinity`,
> que solo "sobrevive" en la respuesta porque `JSON.stringify(Infinity) === "null"` — el tipo `number | null`
> del DTO es una MENTIRA en runtime para cualquier consumidor que no sea `res.json` (ej. un export CSV
> futuro). Un valor menor a `-100` invierte el signo de la cadena completa.
- GIVEN un usuario con `finance:manage_inflation`
- WHEN envía `PUT .../config/inflation/2026-01` con `monthlyRatePct: -100` (o cualquier valor `<= -100`)
- THEN responde `400` y no persiste nada — ninguna deflación mensual real llega al 100%

#### Scenario: maxPaybackMonths must be at least 1, never 0 (fix-wave-4 🔵15)
> Un payback de 0 meses no es un valor de negocio real: degenera el cutoff de "temprano" de
> `RankEarlyChurnByVendor` a la fecha exacta de la alta (ventana vacía) y el umbral de `lossMaking` de
> `ComputeCacAndPayback` a "cualquier payback es pérdida".
- GIVEN un usuario con `finance:manage_targets`
- WHEN envía `PUT /config/targets` con `maxPaybackMonths: 0`
- THEN responde `400` y no actualiza ningún campo del singleton

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

### Requirement: Monthly snapshots must be backfillable on demand, and the nightly job's status must be observable

> **NUEVO (rework 2026-07-27, J1/J3)**: el job nocturno (`FinanceSnapshotScheduler`) recomputa SÓLO el mes
> actual y el anterior, siempre — por diseño (agrega meses ya cerrados, no un backlog). Sin un trigger manual
> para rangos históricos, `FinanceMonthlySnapshot` nunca tendría filas para meses más viejos, sin importar
> cuánta historia de recibos traiga el ingest de Fase 1 — el bridge retroactivo de MRR contratado, la razón de
> ser de este change, nunca llegaría a existir.

El sistema DEBE (MUST) exponer un trigger manual (`POST /api/finance/growth/sync/backfill-snapshots`, guard
`finance:sync`) que compute `FinanceMonthlySnapshot` y `FinanceCohortSnapshot` para un rango `[from, to]`
explícito, inclusive, sin abortar el resto del rango si un mes individual falla. El sistema DEBE (MUST)
también persistir el estado de la ÚLTIMA corrida del job nocturno (éxito/error, meses computados) de forma
consultable — un job que falla TODAS las noches DEBE ser distinguible de uno que simplemente no tuvo nada
nuevo que computar.

#### Scenario: An explicit range backfill computes both the monthly and cohort snapshot for every month in it
- GIVEN un rango `from: "2020-01"`, `to: "2020-06"` sin snapshots previos para esos meses
- WHEN un usuario con `finance:sync` hace `POST /api/finance/growth/sync/backfill-snapshots` con ese rango
- THEN los 6 meses quedan computados en `FinanceMonthlySnapshot`/`FinanceCohortSnapshot`, en la respuesta
  `monthsComputed`

#### Scenario: A single poisoned month does not abort the rest of the backfill range
- GIVEN un rango de varios meses donde uno de ellos falla (ej. un error transitorio de repositorio)
- WHEN corre el backfill
- THEN los demás meses del rango se computan igual, y el mes fallido aparece en `monthsFailed` con su error

#### Scenario: A "to" beyond the current month is rejected without computing anything (fix-wave-3 🔵 5)
> Sin este guard, un `to` futuro (fat-fingered, o un bug del FE construyendo el rango) computaría y
> PERSISTIRÍA snapshots en cero para meses que todavía no ocurrieron — un `GetFinanceOverview` leería eso como
> una caída a cero al final de la serie, no como "todavía no hay datos".
- GIVEN un rango cuyo `to` es un mes calendario POSTERIOR al mes actual (ej. `to: "2030-12"` con el sistema en
  `2026-07`)
- WHEN un usuario con `finance:sync` hace `POST /api/finance/growth/sync/backfill-snapshots` con ese rango
- THEN responde con error, NINGÚN mes del rango se computa ni se persiste, y `to` igual al mes actual (nunca
  posterior) sigue siendo válido

> **LIMITACIÓN CONOCIDA, sin resolver — decisión pendiente del usuario (fix-wave-3)**: `FinancePlanPrice` NO
> tiene historia de precios (`planCode` es la clave, un ÚNICO `estimatedMonthlyPrice` vigente). El bridge
> resuelve el MRR contratado de CUALQUIER mes pasado contra el precio ACTUAL del plan — medido, el mismo
> contrato da `mrrFinalArs(2019-06) = 42000` y `mrrFinalArs(2026-06) = 42000` para el MISMO plan, cuando el
> precio real de 2019 rondaba los $700. Con la inflación argentina, el MRR contratado histórico valuado a
> precios de hoy es ficción, y ese número queda CONGELADO en `FinanceMonthlySnapshot` hasta que alguien vuelva
> a correr el backfill para ese mes. El backfill histórico hacia atrás de este change (más allá de una
> ventana reciente donde los precios cargados sean representativos) **NO DEBE ejecutarse** hasta que el
> usuario decida entre: (a) agregar historia de precios a `FinancePlanPrice` (`validFrom`/vigencia por
> período), (b) limitar el backfill histórico a una fecha de corte donde los precios actuales sean
> representativos, o (c) aceptar la ficción con el número explícitamente etiquetado como tal en la UI. Ninguna
> de las tres se implementó en este fix-wave.

#### Scenario: A failing nightly job is distinguishable from a job with nothing new to compute
- GIVEN el job nocturno de snapshots falla varias noches seguidas
- WHEN se consulta `GET /api/finance/growth/sync/status`
- THEN el campo `snapshotJob.lastResult` refleja el error de la última corrida — el panel NUNCA muestra el
  mismo estado para "todo salió bien, nada cambió" y "el job lleva días muerto"

### Requirement: Read endpoints cap the width of "from"/"to" ranges
El sistema DEBE (MUST) rechazar, en cada uno de los 5 endpoints de lectura de Fase 4
(`/overview`, `/cohorts`, `/vendors/early-churn`, `/nodes/growth`, `/motivos-baja`), un rango `[from, to]`
que exceda 240 meses (20 años) — el mismo cap defensivo que `POST /sync/backfill-snapshots` ya aplica a su
propio rango (fix-wave-4 🔵17).

#### Scenario: An absurdly wide range is rejected instead of walking decades of history
- GIVEN un request con `from: "1990-01"` y `to: "2026-12"` (444 meses)
- WHEN se consulta cualquiera de los 5 endpoints de lectura de Fase 4
- THEN responde `400`, sin ejecutar ninguna query contra los repositorios

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
acción) por endpoint de escritura. El test de la serie real truncada (`realSeriesMissingMonths`, fix-wave-4
🔴1 — reemplaza el `realSeriesTruncatedAt` original) es obligatorio — es el escenario que previene el placebo
inflacionario que motivó el pedido completo. Los tests de ranking (`/vendors/early-churn`, `/nodes/growth`,
`/motivos-baja`) DEBEN usar fixtures que DISCRIMINEN el criterio de ordenamiento bajo prueba (ej. volumen vs.
tasa) — un fixture donde ambos criterios coinciden en el mismo ganador no prueba nada (fix-wave-4 🔵14: el
fixture original de early-churn, 50 altas/60% vs 20 altas/5%, no discriminaba).

**REWORK 2026-07-27 — criterio obligatorio para el test de la identidad del bridge**: un fixture donde el cash
(o cualquier otro insumo) de cada contrato se fija A MANO en exactamente el valor que hace cerrar la cuenta NO
prueba nada — es una tautología (cambiar un número del fixture exige cambiar la aserción en lockstep, así que
NUNCA puede fallar por una regresión real). El test de la identidad del bridge DEBE construir movimientos de
contrato REALES y no rigged para que cierren — como mínimo: un contrato estable que NO paga nada ese mes
(prueba que el MRR contratado es inmune al cash), un contrato que regulariza pagando de más (misma prueba),
alta+baja dentro del mismo mes, alta+upgrade dentro del mismo mes, upgrade+baja dentro del mismo mes,
baja+re-alta dentro del mismo mes (el cliente nunca se fue), y un cambio de plan "lateral" (mismos kbps,
precio distinto) — y verificar la identidad **al centavo** (no sólo dentro de la tolerancia ≤1 que el
Requirement permite como techo, no como resultado esperado). Ver
`src/__tests__/application/finance/BuildFinanceMonthlySnapshot.test.ts` para la implementación de referencia
de este criterio.
