# Design: Finance Growth Dashboard

> Base: `proposal.md` (Fases 1-5 cerradas) + `specs/finance-growth/spec.md`. Este design NO reabre las 6
> decisiones LOCK del usuario — las aterriza. Citas `archivo:línea` = worktree BE actual (2026-07-26).
>
> **REVISIÓN (2026-07-26)**: las 2 preguntas bloqueantes originales se verificaron EN VIVO contra la API real
> de GR (solo lectura). La respuesta invalidó la Fase 1 tal como estaba planteada (extender el sync per-client
> a todos los estados) y cambió la métrica base del change (de facturación emitida a cobranza real). Ver
> Decision 0 y Decision 0b, nuevas en esta revisión — el resto de las Decisions 1-6 se mantienen conceptualmente
> pero se actualizan para leer de `FinanceReceiptApplication` (cobranza) en vez de `Invoice` (facturación).
>
> **REVISIÓN 2 (2026-07-26, mismo día) — pacing rediseñado, decisión LOCK del usuario**: el modelo de "1 mes
> backfilleado por corrida nocturna" (`backfillIntervalMs=86400000`) de la primera versión de este design se
> REEMPLAZA por un goteo continuo de todo el día con presupuesto de requests COMPARTIDO entre un carril delta
> (prioridad absoluta, cadencia de minutos) y un carril backfill (histórico, newest→oldest, una página GR por
> turno). Ver **Decision 4b**, nueva en esta revisión — reemplaza únicamente las filas de "Ingest histórico"/
> "Ingest diario" de la tabla de Decision 4; el resto de Decision 4 (snapshots nocturnos, queries vivas para
> rankings) NO cambia.
>
> **REVISIÓN 3 (2026-07-27) — REWORK del motor de métricas (Fase 3), "DOS NÚMEROS, DOS PREGUNTAS", decisión LOCK
> del usuario.** Dos revisores adversariales auditaron `BuildFinanceMonthlySnapshot` (6 🔴 + 6 🟡) y un revisor
> calculó los números A MANO contra el código. Hallazgo raíz: **el bridge de MRR (Decision 1 original) NO PUEDE
> cerrar sobre cobranza** — no es un bug puntual, es estructural. El bridge descompone el cambio mensual en
> altas/upgrades/downgrades/bajas, y esa descomposición sólo tiene sentido sobre una base que cambie
> ÚNICAMENTE por esos 4 eventos. El cash (`FinanceReceiptItem`) no es eso: se mueve por mora, pagos
> adelantados, regularizaciones e inflación — ninguno de los cuales el bridge tiene un término para explicar.
> Gaps medidos en vivo, sobre bases de 10.000-20.000: un cliente que simplemente no paga ese mes aparecía como
> "-100% de churn" con el contrato seguía activo.
>
> **Decisión: el bridge deja de correr sobre cash y pasa a correr sobre MRR CONTRATADO** (Σ precio de plan ×
> contratos activos, derivado de `ContractServiceEvent` + `FinancePlanPrice`) — una base que, por definición,
> sólo cambia vía esos 4 eventos, así que el bridge cierra POR CONSTRUCCIÓN. La cobranza real (cash puro,
> `FinanceReceiptItem`) sigue existiendo como serie PROPIA, sin bridge — nunca dejó de ser la definición de
> "cash collected" del spec (Decision 0c), simplemente deja de ser la base sobre la que se intenta bridgear.
> Una métrica nueva, **tasa de cobranza** (cobranza / MRR contratado), conecta ambas series. Ver **Decision 1b**
> (nueva, reemplaza el rol de bridge que tenía Decision 1 — Decision 1 en sí, la atribución de dos capas,
> SOBREVIVE sin cambios conceptuales, sólo se usa para un propósito más chico: el diagnóstico de
> `attributionPct`/ARPU, ya no para el bridge). Consecuencia directa: `FinancePlanPrice` pasa a ser
> LOAD-BEARING — un contrato sin precio resoluble NO puede sumar al MRR contratado, y eso es visible
> (`unpricedContractsActive`/`unpricedContractsPct`/`unpricedPlanChangeEvents`), nunca un cero silencioso.
> Ver el Data Model y el HTTP Contract actualizados más abajo para el shape final, y
> `src/application/use-cases/finance/BuildFinanceMonthlySnapshot.ts` para la implementación (su docblock de
> clase documenta, con la misma prosa que este rework, exactamente por qué el bridge cierra al centavo).

## Technical Approach

Un módulo hexagonal nuevo (`finance-growth/`), 100% aditivo. Dirección de dependencias intacta:
`infrastructure → application → domain`. El punto de partida NO es una tabla nueva de "eventos financieros"
— es **reusar lo que ya está vivo**: `ContractServiceEvent` (ya registra activación/baja/modificación con
snapshot de planes) y `ListInternetServiceHistory` (ya deriva upgrade/downgrade), más el molde de ingest
resumible ya probado en el repo (`SyncGestionRealContractsDelta`/`BackfillGrContractsBatch`/
`ArmGrContractsBackfill`). `Invoice` (mirror local de GR, ya existe) queda INTOCADO — ver Decision 0b sobre
por qué no se reutiliza como destino de este ingest. El trabajo real de este change es: (1) construir la
fundación de datos que hoy NO existe (cobranza histórica, vía `recibos`), (2) construir el puente
cobranza-de-cliente → MRR-de-contrato que hoy no existe, y (3) computar agregados mensuales de forma
sostenible en el tiempo.

## Architecture Decisions

### Decision 0 — Fuente de la plata: cobranza real vía `recibos`, no facturación emitida

Verificado en vivo el 2026-07-26 contra `https://api.gestionreal.com.ar/` (solo lectura):

| Opción | Verificación en vivo | Decisión |
|---|---|---|
| Extender `cuentas.invoices[]` (per-client) a los 5 estados GR | **Refutada**: 6/6 clientes activos (estado 1) → `invoices=0`. Un cliente al día devuelve CERO facturas — ese endpoint es SOLO deuda abierta, no historial. Iterar los 5.327 activos habría devuelto 5.327 ceros. | ❌ |
| Reconstruir facturación EMITIDA vía algún action global | **Refutada**: 17 nombres de action probados (`ventas`, `facturas`, `facturas_emitidas`, `comprobantes`, `facturacion`, `libro_iva`, `iva_ventas`, `notas_credito`, `cuenta_corriente`, `movimientos`, `cargos`, `abonos`, `suscripciones`, `contratos_cargos`, `remitos_venta`, `ordenes_deposito`, `ordenes_pago`), todos error 91 (acción inexistente). No existe endpoint de facturación emitida en esta API. | ❌ — imposible, no una elección |
| Ingest global de `recibos` (cobranza) por rango de fechas, paginado por `offset` | **Confirmada**: `POST {action:'recibos', fecha_desde:'01-06-2026', fecha_hasta:'30-06-2026', cantidad:100, offset:0}` devolvió `resultados=4839` (junio 2026), paginación por `offset` verificada (offset=0 y offset=100 traen lotes distintos). Rango ene-jul 2026: 30.181 recibos. Es la ÚNICA serie histórica completa que la API permite. | ✅ **elegida** |

**Consecuencia arquitectónica (la más importante de esta revisión): la métrica base de TODO este change pasa
de "facturación emitida" a "COBRANZA REAL" (cash collected).** Esto se documenta como decisión Y como
limitación explícita: cobranza ≠ facturación — el timing del pago desfasa un mes contra otro (una factura de
junio cobrada en julio cuenta como cobranza de julio, no de junio). El campo `metricBasis: 'cash_collected'`
se expone en la API de overview (ver HTTP Contract) para que nadie interprete el número como facturación
emitida por accidente. El universo se cubre COMBINANDO dos fuentes complementarias:
- **Cobranza** (la fuente principal, todo el motor de métricas) → `recibos[].aplicaciones` (global, histórico,
  paginado, ingest nuevo de Fase 1).
- **Deuda abierta** (uso acotado, fuera del motor de revenue — solo para lo que ya existía) →
  `cuentas.invoices[]` vía `RefreshDebtorBalances`, que SOBREVIVE sin reescritura de fondo, solo con el
  estado `4` (Incobrable) agregado a `DEBTOR_LIKE_STATUSES`. Medido: estado `2` (Deudor) = 75 clientes en
  total, no miles — el sync per-client es trivial en volumen para este subconjunto.

**Gotchas verificados en vivo que el ingest de `recibos` DEBE resolver:**
1. **Formato de fecha obligatorio `DD-MM-AAAA`** — `recibos` con `fecha_desde` ISO (`"2026-01-01"`) devuelve
   **HTTP 500** (no error 91, un 500 real). El resto de los actions con fecha usan el mismo formato
   (`FetchContractsDeltaParams`/`GetServiceOrdersParams` ya lo hacen), así que no es un caso especial nuevo,
   pero `recibos` es intolerante al ISO donde otros actions solo devuelven error 91 — un test explícito lo
   cubre.
2. **`aplicaciones` (y probablemente el nodo raíz de `recibos`) son dict keyed-by-id, no arrays** — mismo
   patrón ya resuelto en el repo para `clientesObj` (`GestionRealClient.ts:303`) y para
   `parseServiceOrdersResponse` (`GestionRealClient.ts:520`, keyed by order id). El parser de recibos reusa
   el mismo idioma `Object.entries(obj).map(([id, v]) => ...)`, nunca `Array.isArray` a secas.
3. **Centinela `"00-00-0000 00:00:00"` = null** para `fecha_anulacion` (y también aparece como centinela de
   `fecha_creacion` en `clientes_consulta`) — un recibo con anulación REAL (≠ centinela) se EXCLUYE
   completamente del ingest (ni el recibo ni sus aplicaciones se persisten).
4. **Un recibo paga N facturas** — en 100 recibos de muestra: 99 items, 122 aplicaciones. La relación
   recibo→aplicación es 1-N, cada aplicación es su propia fila con su propio `grInvoiceId` compuesto.
5. **`cuenta_corriente` y `remitos_venta` NO existen** pese a estar documentados en la skill
   `gestion-real-ipnext` (error 91 "No Se indicó la Acción") — actualizar esa skill es una tarea APARTE, no
   de este change.
6. **`items[]`/`retenciones[]` SÍ se persisten, en tablas propias (fix-wave-2 R1, 2026-07-26 — reemplaza la
   decisión original de esta revisión, que los descartaba)**. La premisa original de descartar `items[]`
   ("la dimensión de canal sale gratis de `recaudador`") era un argumento de CANAL, nunca evaluó que
   `items[]` es la ÚNICA cifra de CASH que da GR — `aplicaciones` es deuda CANCELADA, no cash, y puede
   EXCEDER el cash cuando el recibo también trae `retenciones` (certificados impositivos: retiva/retgan/
   retib/retpat, nunca cash). No persistir esa diferencia hacía el error IRRECUPERABLE sin re-ingerir los 163
   meses de historia. Medido en vivo (junio 2026, 4.839 recibos, 0 excepciones):
   ```
   SUM(aplicaciones) = 147.786.801,41
   SUM(items)        = 146.410.553,10
   SUM(retenciones)  =   1.376.248,31   (0,931% de aplicaciones)
   aplicaciones - items - retenciones = -0,00   <- identidad EXACTA, 0 mismatches
   ```
   `retenciones` aparece en ~1/100 recibos; de los que la traen, un subconjunto (7/18 en junio 2026) NO trae
   `items` en absoluto — un recibo 100% certificado impositivo, cero cash real (ej. recibo `333605`:
   aplicaciones 20.850,60 = retenciones 20.850,60, cash 0,00). Ver Decision 0b y el Data Model actualizados.

### Decision 0b — `Invoice` queda intocado; las aplicaciones de recibo viven en tabla propia (no upsert)

La pregunta explícita a resolver: ¿el ingest de `recibos` completa `Invoice` por upsert desde
`aplicaciones[]` (aprovechando que `{tipo}-{sucursal}-{numero}` es EXACTAMENTE `Invoice.grInvoiceId`), o las
aplicaciones viven en una tabla aparte y el motor de métricas las cruza?

| Opción | Tradeoff | Decisión |
|---|---|---|
| Upsert de `Invoice` desde `aplicaciones[]` (reusar la tabla existente) | `Invoice`/`ClientMirrorRepository.upsertInvoices` implementa un **replace-all destructivo scopeado por cliente**: cada refresh de `RefreshDebtorBalances`/`RefreshClientBalanceIfStale` BORRA las `Invoice` del cliente cuyo `grInvoiceId` ya no aparece en `cuentas.invoices[]` (factura pagada → desaparece de esa lista → se borra). Si el ingest de recibos insertara ahí facturas YA COBRADAS (que por definición nunca vuelven a aparecer en `cuentas.invoices[]`), el PRIMER refresh de deuda posterior de ESE cliente las borraría de nuevo — se pisan entre sí, silenciosamente. | ❌ — rompe un invariante existente en producción (`gr-invoices-sync`, ya en prod) |
| `FinanceReceiptApplication` en tabla propia, motor de métricas la lee directo | Requiere una tabla nueva en vez de reusar `Invoice`, pero es más simple de lo que parece: cada `aplicacion` YA trae su propio `tipo`/`sucursal`/`numero` (⇒ `grType` sin necesidad de joinear a `Invoice`) y su propio `importe`/`fecha`. El motor de métricas no necesita `Invoice` para nada del cálculo de cobranza. | ✅ **elegida** |

**Justificación en 2 líneas**: `Invoice` es propiedad de un contrato YA vivo en producción (mirror de deuda
ABIERTA, con un invariante de replace-all destructivo que este change no puede romper sin arriesgar el
feature `gr-invoices-sync`). `FinanceReceiptApplication` no compite por esa tabla — trae su propio `grType`
directo de la aplicación, así que no hace falta ni un JOIN a `Invoice` para clasificar/netear. El aislamiento
de Decision 5 (el motor de métricas nunca toca `GestionRealPort` ni pisa el mirror de deuda) se mantiene intacto.

### Decision 0c — Persistir las TRES cifras por separado; la métrica base usa CASH PURO (fix-wave-2 R1, decisión LOCK del usuario, 2026-07-26)

La re-review de fix-wave-1 midió en vivo que descartar `retenciones`/`items` sobreestimaba la cobranza real
exactamente en el total de retenciones ($1.376.248,31 en junio 2026, 0,931%) — la métrica hoy contaba
"comprobantes cancelados" (`aplicaciones`), no "cash collected" como exige spec.md. Al no persistirse
`items`/`retenciones`, la diferencia NO era reconciliable después: corregirlo habría exigido re-ingerir los
163 meses completos de historia.

| Opción | Tradeoff | Decisión |
|---|---|---|
| Seguir usando `aplicaciones` como base de la métrica, sin persistir `items`/`retenciones` | Simple, pero perpetúa el error de plata medido y lo hace irrecuperable sin re-ingesta completa | ❌ |
| Persistir `items`/`retenciones` pero seguir sumando `aplicaciones` como métrica base | Corrige la persistencia pero NO el número — spec.md exige explícitamente "cash collected", no "deuda cancelada" | ❌ |
| **Persistir las TRES cifras por separado (`aplicaciones`, `items`, `retenciones`) y usar `items` (CASH PURO) como número principal, con `retenciones` como serie aparte** | Requiere 2 tablas nuevas + repos + wiring en ambos carriles de ingest, pero hace la decisión REVERSIBLE: si mañana se necesita otra definición de "revenue", los tres números ya están persistidos por separado, sin re-ingerir nada | ✅ **elegida** |

**Definición de métrica base, actualizada**: `FinanceReceiptItem` (persistido, fix-wave-2 R1) es la fuente de
"cash collected" para toda métrica de revenue/MRR de este spec (Decision 1, Capa A/B, `FinanceMonthlySnapshot.
revenueTotalArs`, etc.) — reemplaza la lectura implícita sobre `FinanceReceiptApplication` que tenía este
design antes de la re-review. `FinanceReceiptApplication` (`aplicaciones`) sigue existiendo y persistiéndose
igual (deuda CANCELADA — útil para reconciliación contable, nunca como base de "cash collected").
`FinanceReceiptRetencion` (`retenciones`) se expone como serie APARTE (certificados impositivos, nunca cash,
nunca neteado en silencio contra ninguna de las otras dos). La identidad `SUM(aplicaciones) = SUM(items) +
SUM(retenciones)` es el guardrail de integridad entre las tres tablas (ver `mapGrReceipt.receiptIdentityHolds`)
— una discrepancia se loguea como WARNING, nunca aborta el ingest ni se oculta.

**Nota de alcance**: la Fase 1 (este fix-wave) sólo cubre el INGEST — persistir las tres tablas correctamente.
El motor de métricas (`BuildFinanceMonthlySnapshot`/`GetFinanceOverview`, Fase 3/4) todavía no existe en el
código; cuando se implemente, DEBE leer `FinanceReceiptItem` (no `FinanceReceiptApplication`) para
`revenueTotalArs`/Capa A/B, y exponer las retenciones del mes como campo aparte — se deja anotado acá para que
esa fase futura no reintroduzca el error de esta ronda.

### Decision 1 — Atribución cobranza→contrato: dos capas, nunca una sola verdad

| Opción | Tradeoff | Decisión |
|---|---|---|
| Ignorar contratos, medir todo a nivel cliente | Simple, pero contradice la decisión LOCK #3 (churn = contrato) — un cliente con 2 contratos que da de baja 1 se vería como "no pasó nada" | ❌ |
| Crear un catálogo de precios de lista y usarlo como fuente de MRR | Contradice la decisión LOCK #1 (la factura real, con descuentos, es la verdad) — un catálogo de lista miente sistemáticamente hacia arriba | ❌ |
| **Capa A (verdad contable, agregada) + Capa B (atribución operativa, por contrato, con confianza declarada)** | Requiere exponer un `%` de confianza en vez de un número limpio — más honesto, más trabajo de UI | ✅ **elegida** |

**Capa A** — todo lo que es cobranza TOTAL por mes (revenue MoM/YoY, ARPU global, nominal/real) sale DIRECTO
de `FinanceReceiptApplication` agrupada por `appliedDate` (calendario AR) y neteada por
`FinanceInvoiceTypeClassification` (Decision 2, ahora sobre `application.grType` directo, sin joinear
`Invoice`). Cero estimación, cero contrato de por medio. Esto sola ya responde "¿cobramos más o menos este
mes?" con la verdad contable completa — con la limitación documentada en Decision 0 (cobranza ≠ facturación).

**Capa B** — para el BRIDGE de MRR y el churn de ingresos (que son inherentemente por-contrato, decisión LOCK
#3), la cobranza neteada de un cliente en el mes (suma de sus `FinanceReceiptApplication` netadas) se reparte
entre sus contratos activos del mes:

```
si   contratos_activos_del_cliente_en_el_mes == 1:
       MRR_contrato = cobranza_neteada_del_mes          (attributionConfidence: 'exact')
si   contratos_activos_del_cliente_en_el_mes  > 1:
       si algún plan de sus contratos tiene fila en FinancePlanPrice:
         MRR_contrato_i = cobranza_neteada × (estimatedMonthlyPrice_i / Σ estimatedMonthlyPrice_j)
                                                          (attributionConfidence: 'estimated')
       si NINGÚN plan tiene fila en FinancePlanPrice:
         MRR_contrato_i = cobranza_neteada / cantidad_de_contratos
                                                          (attributionConfidence: 'estimated-equal')
```

Por qué esto es seguro: la ENORME mayoría de clientes tiene 1 solo contrato (verificado por el usuario en la
exploración) → para esos, el precio real del contrato sale GRATIS de lo cobrado, sin necesidad de ningún
catálogo. `FinancePlanPrice` (settable, decisión LOCK #4 "precio por plan") NUNCA es la fuente de la
cobranza agregada (eso sigue siendo Capa A) — es SOLO el criterio de reparto proporcional cuando hay que
partir una cobranza entre 2+ contratos, y también alimenta el "what-if" de CAC/payback para planes nuevos
sin historial de ventas todavía.

**REVISIÓN 3 (2026-07-27) — alcance reducido de esta Decision tras el rework**: `attributionPct`/ARPU
(construidos con esta atribución) siguen existiendo como diagnóstico de Capa B (F5/F6, ver Decision 1b), pero
YA NO alimentan `mrrFinalArs` ni el bridge — ese rol pasó íntegro a Decision 1b (MRR contratado). La fórmula
de `attributionPct` en sí también se corrigió (F6): el denominador pasó de "MRR final" a "cobranza atribuida a
TODOS los contratos de internet tocados el mes" (incluye contratos que se dan de baja a mitad de mes — antes
quedaban invisibles al ratio, escondiendo hasta la mitad del cash real de algún mes).

### Decision 1b — MRR CONTRATADO es la base del bridge; cobranza real es una serie SIN bridge (rework 2026-07-27, decisión LOCK del usuario)

La re-review de Fase 3 (dos revisores adversariales + cálculo a mano) encontró que el bridge de MRR (definido
sobre cobranza, Decision 1 original) es estructuralmente incapaz de cerrar: la descomposición altas/upgrades/
downgrades/bajas sólo es válida sobre una base que cambia EXCLUSIVAMENTE por esos 4 eventos, y el cash no lo
es (mora, pagos adelantados, regularizaciones, inflación). Medido en vivo (fixtures reproducidas 1:1 en
`BuildFinanceMonthlySnapshot.test.ts`): un cliente que no paga un mes con el contrato SIN cambios aparecía
como -100% de "churn"; un cliente que regulariza dos meses de deuda de una vez aparecía como +100% de "alta".

| Opción | Tradeoff | Decisión |
|---|---|---|
| Parchear el bridge existente con más términos ("ajuste por mora", "ajuste por regularización") | Cada parche nuevo es una categoría de movimiento de cash distinta (inflación, pago parcial, nota de crédito aplicada tarde...) — perseguir la lista completa nunca termina, porque el cash no es decomponible en un número finito de "tipos de evento de contrato" | ❌ |
| Abandonar el bridge, quedarse sólo con series nominales | Pierde la pregunta que motivó el pedido: "¿por qué cambió el número este mes?" | ❌ |
| **Bridgear MRR CONTRATADO (Σ precio de plan × contratos activos) en vez de cash; cobranza real queda como serie propia SIN bridge; tasa de cobranza conecta ambas** | Dos números en vez de uno — más superficie de UI, pero cada uno responde una pregunta honesta y el bridge cierra de verdad | ✅ **elegida** |

**Las dos preguntas, explícitas:**
1. **MRR CONTRATADO** = Σ (precio del plan × contratos activos). El bridge (`mrrInicialArs → +mrrNewArs +
   mrrUpgradeArs − mrrDowngradeArs − mrrChurnArs = mrrFinalArs`) corre sobre esto y cierra POR CONSTRUCCIÓN
   para todo contrato con precio resoluble en ambos extremos de su transición (ver la prueba exacta al centavo
   en `BuildFinanceMonthlySnapshot.test.ts`, el test que reemplaza la tautología original de la task 3.16).
   Responde *"¿crece la base y su valor?"* — inmune al timing de pago.
2. **COBRANZA REAL** (`revenueTotalArs`, sin cambios respecto de Decision 0c) = cash puro
   (`FinanceReceiptItem`, por `receipt.fechaRecibo`), TODO el universo (no sólo internet). SIN bridge.
   Responde *"¿entró plata?"*.
3. **TASA DE COBRANZA** (`collectionRatePct`, campo nuevo) = cobranza / MRR contratado (final) del mes ×
   100 — la métrica que conecta las dos series y habilita la decisión que motivó todo el pedido: cuánto de lo
   que "corresponde" cobrar según la base contratada, efectivamente se cobró. `null` (nunca `0`) cuando
   `mrrFinalArs` es 0 — no hay base contra la cual comparar, y un `0%` ahí mentiría ("no se cobró nada" en vez
   de "no hay con qué comparar").

**Consecuencia — `FinancePlanPrice` es LOAD-BEARING**: el MRR contratado de un contrato depende ENTERAMENTE de
que su plan tenga un código resoluble Y una fila en `FinancePlanPrice`. Cuando cualquiera de las dos
condiciones falla, el contrato contribuye `0` al MRR contratado — NUNCA silenciosamente: se cuenta y expone en
`unpricedContractsActive`/`unpricedContractsPct` (contratos activos al cierre del mes sin precio resoluble) y
`unpricedPlanChangeEvents` (eventos de cambio de plan del mes donde el precio viejo o nuevo era irresoluble,
excluidos de `mrrUpgradeArs`/`mrrDowngradeArs` en vez de tratados como si el lado faltante valiera `0` — el bug
de 3x-inflación original).

**fix-wave-2 (2026-07-27) — la limitación estructural del rework original QUEDÓ RESUELTA: la fuente del plan es
`PppoeService.profile`, no `ContractServiceEvent` en soledad.**

La versión original de este rework derivaba el plan EXCLUSIVAMENTE de eventos `'modified'` de
`ContractServiceEvent`. Un `ContractServiceEvent` de tipo `'activated'` NO lleva información de plan
(verificado en el código — ningún call site de `record()` con `eventType: 'activated'` setea
`oldPlan`/`newPlan`), así que un contrato que JAMÁS tuvo un evento `'modified'` real quedaba con `planCode:
null` DURANTE TODA SU VIDA — no un caso raro, sino potencialmente la MAYORÍA de los contratos estables en datos
de producción reales (la mayoría de los contratos de un ISP nunca cambian de plan).

**La fuente existía en el repo y no se había mirado: `PppoeService.profile`.** Evidencia dura —
`ChangePppoePlanService.ts` (el ÚNICO código que ESCRIBE `PppoeService.profile` en un cambio de plan real) hace:

```ts
await this.repo.upsertByUsername({ ..., profile, ... });          // profile comercial actualizado
await this.eventRepo.record({ ..., oldPlan: service.profile ?? null, newPlan: profile, ... }); // MISMO valor
```

`oldPlan`/`newPlan` de un `ContractServiceEvent` de tipo `'modified'` SON, por construcción, valores de
`PppoeService.profile` — mismo vocabulario, confirmado por quien los escribe. El docblock del propio campo lo
confirma: `profile: string | null; // /ppp profile COMERCIAL (IP-Air-* / *-PUB) — NO se pisa al cortar`.

**Descartado explícitamente**: `Contract.plan` (nombre comercial de GR) es texto libre e inconsistente —
medido en vivo: `300MB`, `30/10 MB`, `600MB`, `40/15 MB`, `20/5MB GRAL`, `500MBFO`, `300/300MB FO`,
`20/20MBWRESIDENCIAL`. No es vocabulario del catálogo `Plan` (`IP-100`, `IP-Air-20-10`, `IP-REDUCCION`) y
cruzarlo directo daría todo sin precio.

**El fix**: el plan de un contrato AL DÍA DE HOY = el `profile` de su `PppoeService` (batch-resuelto vía
`PppoeServiceRepository.findCurrentProfilesByContractIds`, NUNCA N+1). El plan EN UN MES `M` pasado = tomar el
actual y **deshacer**, en orden cronológico inverso, los eventos `'modified'` de cambio de plan posteriores a
`M` (usando `oldPlan`, el valor previo) — ver `contractLifecycle.resolvedPlanCodeAt` para el algoritmo exacto.
Esto da cobertura COMPLETA para todo contrato con servicio PPPoE (= todo contrato de internet realmente
conectado).

Tres decisiones de diseño que este fix resuelve explícitamente:

1. **Corte por mora (`enforcedState: 'reduced'/'blocked'`)**: `PppoeService.profile` NUNCA es tocado por el
   enforcement — `EnforcePppoeService`/`RouterOsEnforcementAdapter`/`OrchestratorEnforcementAdapter` parchean
   el ROUTER (o el orchestrator RADIUS), nunca llaman `repo.upsertByUsername`. Un contrato cortado por mora
   YA tiene su plan comercial real en `profile` durante todo el corte — no hace falta ningún caso especial por
   `enforcedState`. El único guard defensivo (anomalía de datos, no el flujo normal) es en
   `resolvedPlanCodeAt`: si `profile` mismo terminó siendo un código de enforcement (`IP-REDUCCION`/`IP-BAJA`,
   `isEnforcementPlan`) por un cambio de plan manual que bypaseó el flujo reduce/restore, la función sigue
   deshaciendo eventos hacia atrás hasta encontrar el último código comercial real — nunca cuenta un código de
   enforcement como el plan contratado, y nunca lo trata como precio `0` si hay un comercial real detrás.
2. **Multi-servicio / servicio desasociado** (`PppoeService.contractId` es nullable, `onDelete: SetNull`):
   `PppoeServiceRepository.findCurrentProfilesByContractIds` resuelve, para cada contrato, un ÚNICO
   "servicio ganador" vía el criterio COMPARTIDO `pickCurrentPppoeService` (domain, mismo código en el adapter
   Prisma y el in-memory — nunca dos implementaciones que puedan driftear, la clase de bug que ya mordió a
   este change una vez): no-`'terminated'` > `'terminated'`, luego `'enabled'` > cualquier otro status, luego
   el más reciente (`createdAt` desc) como desempate. Un contrato sin ninguna fila resoluble (0 filas, o todas
   fueron desasociadas) queda AUSENTE del Map devuelto — el caller lo trata exactamente como "sin PPPoE".
3. **Contratos sin PPPoE** (ej. solo TV): sin cambios de comportamiento — siguen `unpriced` y VISIBLES
   (`unpricedContractsActive`/`unpricedContractsPct`), nunca un cero silencioso.

`unpricedContractsActive`/`unpricedContractsPct`/`unpricedPlanChangeEvents` SIGUEN existiendo — bajan mucho en
datos reales, pero ahora significan algo más angosto y honesto: sin servicio PPPoE resoluble en absoluto, o
plan resuelto sin fila en `FinancePlanPrice`. Nunca se eliminó la visibilidad, solo se redujo drásticamente su
superficie.

### Decision 2 — Clasificación de `grType`: catálogo de filas, nunca un enum en código

Mismo criterio que `SEVERITY_LABEL_TO_CRITICAL`/`inferSeverityFromAlertname` en `GrafanaWebhookSource.ts`
(whitelist conocida + fallback declarado, nunca un crash ni una suposición silenciosa) y mismo espíritu que
la lección de `AssistantIntent` (rows, no enum, para que un vocabulario que crece no requiera deploy).

`FinanceInvoiceTypeClassification { grType String @id, bucket String @default("unclassified"), label
String?, createdAt, updatedAt }`. `bucket ∈ {'revenue','contra','excluded','unclassified'}` (no un enum de
Prisma — VARCHAR + validación en el use case, mismo criterio que `PermissionAction`/RBAC action codes,
porque el vocabulario de GR es ajeno y puede traer valores no anticipados). El ingest de recibos (Fase 1) hace
`upsertIfAbsent(grType)` con `bucket: 'unclassified'` la PRIMERA vez que ve un `grType` no catalogado en una
`FinanceReceiptApplication` — nunca sobreescribe una clasificación ya hecha por un admin. `unclassified` se
EXCLUYE de la cobranza neteada pero su monto se acumula visible (`unclassifiedAmount` en el snapshot) — un
número raro que se muestra es mejor que un número limpio que miente.

**Vocabulario verificado en vivo (2026-07-26, 100 recibos de muestra)**: `FB` (100 aplicaciones, mayoría
absoluta), `FA` (12), `FX` (9), `ID` (1). Confirma — no cierra — que el catálogo de filas auto-completable
era la decisión correcta: hay AL MENOS 4 códigos reales, no solo el `FB` que documentaba el comentario de
`mapGrInvoice.ts`, y no hay garantía de que la lista esté completa. Semilla inicial de la migración: SOLO
`{grType: 'FB', bucket: 'revenue', label: 'Factura B'}` — la única certeza verificada por comportamiento
económico esperado (mayoría absoluta de las aplicaciones). `FA`/`FX`/`ID` arrancan SIN fila (se auto-clasifican
`unclassified` en el primer sync real) porque su semántica exacta (¿factura A? ¿nota de débito/interés para
`ID`?) no está confirmada — un admin los reclasifica operativamente tras ver el primer batch real de datos,
nunca se asume en código.

### Decision 3 — Índice IPC: tasa mensual cargable + encadenamiento, falla fuerte ante huecos

`FinanceInflationIndex { yearMonth String @id, monthlyRatePct Decimal, source String?, createdAt, updatedAt }`
almacena la variación mensual tal cual la publica INDEC (ej. `4.2` para +4.2% ese mes) — el usuario carga el
número del boletín directamente, sin tener que precalcular un índice base-100.

**Encadenamiento**: `FinanceTargetsConfig.inflationBaseYearMonth` fija el mes "ancla" (la serie real queda
expresada en pesos de ESE mes). El índice encadenado de un mes `m` es:

```
chainedIndex(base) = 1
chainedIndex(m)     = chainedIndex(m-1) × (1 + monthlyRatePct(m) / 100)     // hacia adelante desde base
chainedIndex(m)     = chainedIndex(m+1) / (1 + monthlyRatePct(m+1) / 100)   // hacia atrás desde base

real(m) = nominal(m) × chainedIndex(base) / chainedIndex(m)
```

**Gotcha de huecos (obligatorio del brief)**: si falta `monthlyRatePct` para algún mes DENTRO del rango
pedido, la cadena se corta ahí — NO se asume `0%` (eso subestima la inflación real y produce un "falso
crecimiento real" tan placebo como el nominal sin ajustar) y NO se interpola. **fix-wave-4 🔴1**: la
respuesta incluye `realSeriesMissingMonths: string[]` (la lista EXHAUSTIVA de meses de `[from, to]` sin valor
real) — NO un único cutoff (`realSeriesTruncatedAt`, el diseño original), porque un hueco en cada dirección
desde `base` deja un conjunto de meses reales NO contiguo que un solo marcador no puede describir. La serie
**nominal** y de **contratos** (que no dependen del IPC) se siguen devolviendo completas — el usuario nunca
pierde TODA la vista por un mes de carga olvidado.

### Decision 4 — Volumen: ingest paceado + snapshots nocturnos para el bridge/cohortes, queries vivas para rankings

**Volumen real medido en vivo (2026-07-26)**: 5.327 clientes activos, 75 deudores; **4.839 recibos en un solo
mes** (junio 2026), **30.181 en 7 meses** (~58k/año). Clientes creados desde **2013** ⇒ el histórico completo
puede ser del orden de **cientos de miles de recibos** — un orden de magnitud MAYOR al volumen que asumía el
diseño original (~5k llamadas nocturnas per-client). Paginado (100/página) y distribuido en el tiempo vía el
goteo continuo de presupuesto compartido (Decision 4b — una página GR por tick, ~20s entre ticks), el volumen
por INVOCACIÓN se mantiene chico y acotado, igual que el resto de los jobs del repo.

| Pieza | Estrategia | Por qué |
|---|---|---|
| Ingest de recibos (backfill + delta) | **REDISEÑADO (2026-07-26, decisión LOCK del usuario) — ver Decision 4b inmediatamente abajo.** Goteo continuo de todo el día, presupuesto de requests COMPARTIDO entre dos carriles con prioridad, NUNCA un batch nocturno de "N meses/corrida". | El modelo de "1 mes calendario por corrida nocturna" (versión previa de este design) tardaba ~5,4 MESES de calendario en cubrir los 163 meses de historia medidos — destruía el valor del bridge de MRR retroactivo. Ver Decision 4b para los números y el mecanismo completo. |
| Bridge de MRR, churn, ARPU, nominal/real | `FinanceMonthlySnapshot` (1 fila por mes), job nocturno | Reconstruir el MRR "al inicio del mes" para un mes arbitrario requiere reproducir el estado de TODOS los contratos activos a esa fecha — cursar esto en cada request del panel (potencialmente 24+ meses × miles de contratos) es un `O(meses × contratos)` que no escala a un dashboard interactivo. Se computa 1 vez por noche y se sirve de una tabla plana. |
| Cohortes de retención 3/6/12 | `FinanceCohortSnapshot` (1 fila por `cohortYearMonth × monthsElapsed`), mismo job nocturno | Mismo argumento: "¿cuántas de las altas de hace 8 meses siguen vivas?" es una consulta sobre TODA la ventana de vida de la cohorte, no algo que valga la pena recalcular por cada carga de página. |
| Ranking vendedor (churn temprano), ranking motivos de baja, crecimiento por nodo | Query viva, acotada por rango de fecha del request (no toda la historia) | Son reportes filtrados por un rango típico (mes/trimestre), con `GROUP BY vendedor`/`GROUP BY networkSiteId` sobre `ContractServiceEvent` indexado por `[contractId, createdAt]` — el volumen (~4-5k clientes, contratos en ese orden de magnitud) es perfectamente vivo con un índice adicional por fecha si el `EXPLAIN` lo pide. No se materializa lo que no hace falta materializar. |
| Modificaciones de contrato (upgrades/downgrades) | Reusa `ListInternetServiceHistory` sin cambios | Ya existe, ya es una query viva acotada por filtro, no se duplica. |

Justificación de volumen del motor de métricas (distinto del ingest, cubierto arriba): ~4-5k clientes, un
orden de magnitud similar de contratos, `ContractServiceEvent` en el rango de decenas de miles de filas tras
varios años de historia. `FinanceReceiptApplication` sí es de un orden mayor (cientos de miles de filas
históricas), pero indexado por `appliedDate`/`grInvoiceId` y agregado UNA VEZ por el snapshot nocturno — el
panel nunca lo escanea completo en un `GET`. Ninguno de estos números justifica una arquitectura de
streaming/OLAP.

### Decision 4b — Pacing del ingest de recibos: goteo continuo con presupuesto compartido y prioridad de carril

**REVISIÓN (2026-07-26) — decisión LOCK del usuario, reemplaza el modelo "1 mes/corrida nocturna" de la
versión anterior de este design.** Cita textual: *"hagámoslo al revés, de adelante hacia atrás, primero las
facturas actuales, así podemos sacar cálculos reales, y luego las más antiguas de adelante hacia atrás, y que
se corra todo el día en tiempo real, sin saturar la API de GR"*.

**Por qué el modelo anterior no se sostenía** — números medidos en vivo: ~4.312 recibos/mes ÷ 100/página ≈
**44 requests por mes de historia**; 163 meses (2013-01 → 2026-07) ⇒ **~7.172 requests para TODO el
backfill**. A 1 mes/corrida nocturna (`backfillIntervalMs=86400000`), eso son **163 noches ≈ 5,4 MESES de
calendario** hasta tener historia completa — inaceptable para un change cuyo valor principal es el bridge de
MRR retroactivo (sin él, las comparaciones interanuales no existirían hasta 2027). Y la "prudencia" de 1
mes/noche estaba mal calibrada: 7.172 requests totales es apenas ~1,3× lo que costaba UNA sola noche del plan
per-client ya descartado (Decision 0).

| Opción | Números | Decisión |
|---|---|---|
| Batch nocturno, 1 mes/corrida (`backfillIntervalMs=86400000`, versión previa) | 163 noches ⇒ ~5,4 meses de calendario para historia completa | ❌ — destruye el valor del bridge retroactivo |
| Goteo continuo, presupuesto único sin distinguir carriles (1 request cada N segundos, FIFO estricto newest→oldest incluyendo el delta en la misma cola) | Simple, pero un backlog grande de backfill podría retrasar el delta del día — el panel mostraría cobranza de HOY desactualizada mientras se procesa historia vieja | ❌ — viola el requisito explícito de "sin saturar" Y de datos de hoy en tiempo real |
| **Goteo continuo, DOS carriles con presupuesto COMPARTIDO y prioridad ABSOLUTA del delta** | A `requestIntervalMs=20000` (1 req/20s) el backfill standalone completa en **~1,7 días** (7.172 req ÷ 4.320 req/día); con el delta reclamando ~288 ticks/día como mínimo (chequeo cada 5 min) el backfill real corre a ~93% de esa capacidad ⇒ **~1,8-2 días** de calendario para cobertura histórica completa, mientras el delta mantiene "hoy" al día en minutos desde el arranque | ✅ **elegida** |

**Defaults elegidos (`FinanceReceiptSyncConfig`) y por qué**:
- `requestIntervalMs = 20000` (1 request GR cada 20s): conservador — deja MUCHO margen bajo lo que la API
  demostró tolerar (30.181 recibos en 7 meses ya se leyeron en la verificación en vivo sin fricción), y
  completa el backfill en ~2 días en vez de horas, priorizando "nunca saturar GR" sobre "terminar rápido". Es
  el punto configurable si en producción se confirma que GR tolera más ritmo (ir a 10s ⇒ ~1 día) o si hace
  falta bajar la presión (30s ⇒ ~2,5 días) — números de referencia ya verificados por el usuario.
- `maxRequestIntervalMs = 300000` (techo de 5 min): límite superior del backoff adaptativo — ante una caída
  sostenida de GR, el presupuesto compartido nunca espacia sus reintentos más de 5 minutos, así que ambos
  carriles se recuperan rápido apenas GR vuelve.
- `deltaCheckIntervalMs = 300000` (5 min): cadencia "en tiempo real" del carril delta — cuando no tiene
  páginas pendientes, vuelve a chequear "hoy" cada 5 minutos (minutos, no horas, per requisito explícito del
  usuario). Es el piso de latencia entre "un cliente paga" y "aparece en el panel".
- `backfillFloorYearMonth = "2013-01"` (sin cambios — se conserva de la versión anterior del design).

**Quién decide el turno (arbitraje)**: una pieza nueva de infraestructura, `FinanceReceiptIngestScheduler`
(molde `GestionRealSyncScheduler` — mismo idioma de `inFlight` + `DistributedLock`/`PgAdvisoryLock` con su
propia lock key `finance-receipts-ingest` para evitar doble-tick entre réplicas), corre UN tick a la vez y en
cada tick decide:

```
tick():
  deltaState    = state.get('finance-receipts-delta')
  deltaDue      = deltaState.hasPendingPages
                  OR (now - deltaState.lastFullRunAt) >= config.deltaCheckIntervalMs
  if deltaDue:  turno = SyncGrReceiptsDelta.execute()        // UNA página
  else:         turno = SyncGrReceiptsBackfillBatch.execute() // UNA página
  onResult(turno)  // ok → resetea backoff; error → duplica el intervalo efectivo (tope maxRequestIntervalMs)
  scheduleNextTick(effectiveIntervalMs)  // setTimeout recursivo, NUNCA setInterval fijo
```

**Deviación deliberada del idioma existente**: el resto del repo usa `setInterval(fn, intervalMs).unref()`
(intervalo FIJO — ver `GestionRealSyncScheduler.start()`/`bootstrapGestionRealSync.ts`). Acá el intervalo
CAMBIA dinámicamente bajo backoff, algo que `setInterval` no soporta sin destruir/recrear el timer. Por eso
`FinanceReceiptIngestScheduler` usa `setTimeout` recursivo (programa el próximo tick recién al terminar el
actual, con el `effectiveIntervalMs` vigente) — único scheduler del repo con este patrón, documentado acá
explícitamente para que no se confunda con un bug la próxima vez que alguien lo lea.

**Cómo se persiste el estado de cada carril** — se reusa `SyncStateRepository` (sin puerto nuevo, mismo
contrato `{entity, cursor, lastRunAt, lastResult, itemsSynced}` ya usado por
`gr-contracts-backfill`/`gr-contracts-delta`), con una convención de codificación NUEVA en `cursor` (documentada
acá porque no existe precedente exacto en el repo):
- `finance-receipts-backfill`: `cursor = "{yearMonth}:{offset}"` mientras un mes está a mitad de paginar (ej.
  `"2026-03:1300"`); al completar un mes, `cursor = "{yearMonthAnterior}:0"` (avanza hacia atrás, offset
  reiniciado); al llegar al piso y completarlo, `cursor = null` + `lastResult = 'done'` (igual que
  `BackfillGrContractsBatch`).
- `finance-receipts-delta`: `cursor = "{fechaDesde}:{fechaHasta}:{offset}"` mientras pagina un rango
  "hasta hoy" pendiente (`hasPendingPages` se deriva de que el cursor tenga este formato compuesto); al
  terminar de paginar todo el rango, `cursor = "{fechaHasta}"` (formato plano `DD-MM-AAAA`, igual que
  `SyncGestionRealContractsDelta`), que es lo que lee la próxima corrida como `fechaDesde` (overlap ≥1 día).

**Qué pasa si el delta se atrasa**: tiene prioridad ABSOLUTA e incondicional — mientras
`deltaState.hasPendingPages` sea verdadero, CADA tick va al delta, sin excepción, y el backfill no avanza ni
una página (Decision de diseño, no un bug: es exactamente lo que pidió el usuario — "nunca puede pasar que un
backfill lento retrase los números de hoy"). En la práctica el volumen diario (~160 recibos/día ≈ 2 páginas)
hace que este escenario dure segundos, no horas — el riesgo de "backfill famélico indefinidamente" solo se
materializaría ante un volumen diario anómalo, y queda anotado como riesgo NO-bloqueante en `proposal.md`.

**Throttle adaptativo — mecánica exacta**: el backoff vive en memoria del proceso (`consecutiveFailures`,
`effectiveIntervalMs`), NO persistido — un restart lo resetea a `requestIntervalMs` (aceptable: en el peor
caso, si GR sigue caído, la primera request post-restart falla de nuevo y el backoff se reconstruye en un
tick). Regla: cada fallo (tras agotar el retry interno de `GestionRealClient` para esa request) duplica
`effectiveIntervalMs` con tope `maxRequestIntervalMs`; el PRIMER tick exitoso después de una degradación
resetea `effectiveIntervalMs = requestIntervalMs` de inmediato (no gradual — no hay ambigüedad sobre cuándo
"confiar de nuevo" en GR). Este backoff opera un nivel POR ENCIMA del retry-on-5xx ya existente en
`GestionRealClient.request()` (que reintenta transitoriamente DENTRO de una sola llamada) — no lo duplica, lo
envuelve: el scheduler solo ve "esta request falló" o "esta request se resolvió" después de que
`GestionRealClient` ya agotó sus propios reintentos.

**fix-wave-2 R4 (per-lane health) + fix-wave-3 R8 (backoff acoplado al carril equivocado) — DOS señales
distintas, dos consumidores distintos.** R4 corrigió que un ÉXITO de cualquier carril resetee el contador
COMPARTIDO de fallos (antes, un backfill sano "curaba" un delta crónicamente roto cada dos ticks). Pero R4
dejó un acoplamiento sin decidir explícitamente: `effectiveIntervalMs` (el backoff hacia GR) seguía derivando
del PEOR de los dos contadores por-carril — y esos contadores cuentan CUALQUIER fallo del carril, incluida la
PERSISTENCIA (un `upsertBatch` que revienta por una fila podrida), no solo el fetch a GR. Probado en vivo: un
recibo envenenado hace fallar `applicationRepo.upsertBatch` en TODOS los ticks del delta mientras GR está
perfectamente sano; a los 4 fallos el backoff compartido queda clavado en `maxRequestIntervalMs` (300000ms)
PARA SIEMPRE — el carril backfill, sano, corre a `1/15` de su ritmo normal (163 meses de historia pasan de
~4 días a ~2 meses) por un problema que el backoff no puede resolver (GR nunca fue el problema).

La corrección separa DOS derivaciones a partir de contadores YA EXISTENTES, sin tocar el propósito de
ninguno:
- `deltaConsecutiveFailures`/`backfillConsecutiveFailures` (per-carril, R4) siguen alimentando
  EXCLUSIVAMENTE `/sync/status` (`consecutiveFailures`/`degraded`) y el circuit-breaker anti-inanición
  (`deltaStarvationThreshold`, F4) — cuentan CUALQUIER fallo, persistencia incluida, porque para "¿este
  carril está sano?" eso es exactamente lo que importa.
- Un contador NUEVO, `grConsecutiveFailures`, alimenta EXCLUSIVAMENTE `effectiveIntervalMs` (el ritmo real
  hacia GR) — sólo crece ante un fallo que NO sea de persistencia (el fetch mismo, o cualquier error anterior
  a la persistencia); se resetea a 0 tanto en un éxito completo como en un fallo de persistencia (porque el
  fetch DENTRO de esa llamada tuvo que funcionar para que la persistencia se intentara siquiera — GR quedó
  probado sano en ese tick, más allá de qué pasó después).

La distinción persistencia-vs-fetch la hace el USE CASE, no el scheduler: `SyncGrReceiptsDelta`/
`SyncGrReceiptsBackfillBatch` envuelven únicamente los pasos POST-fetch (los 4 `upsertBatch`/
`upsertIfAbsent`/`state.save` de éxito) en un `try/catch` propio que relanza como
`FinanceReceiptPersistenceError` (`financeIngestErrors.ts`) — el `catch` externo que ya graba
`lastResult: error:` en `SyncState` no cambia. El scheduler sólo necesita un `instanceof
FinanceReceiptPersistenceError` para decidir a cuál de los dos contadores afectar.

**Por qué esto no rompe R4 ni el circuit-breaker de F4**: ninguno de los dos usa `grConsecutiveFailures` —
siguen leyendo `deltaConsecutiveFailures`/`backfillConsecutiveFailures` exactamente como antes de R8. El
único comportamiento que cambia es CUÁNTO se espacían las llamadas HACIA GR; qué tan "degradado" se reporta
el status, y cuándo el backfill recibe turnos por inanición del delta, quedan idénticos.

**Restricción ya satisfecha, no un riesgo abierto**: un scheduler que corre de forma continua y cruza la
medianoche argentina en algún tick NO puede cachear credenciales — pero esto YA está resuelto en el adapter
existente, no requiere trabajo nuevo. `GestionRealClient.request()` (línea ~93) recomputa el password
`MD5(CUIT+SECRET+fecha)` **por intento** vía `auth()`, y `isoDate()` deriva `fecha` con
`Intl.DateTimeFormat('en-CA', {timeZone:'America/Argentina/Buenos_Aires'})` — nunca del huso del proceso. El
scheduler nuevo simplemente sigue llamando a `GestionRealPort.fetchReceipts(...)` por tick, como cualquier
otro consumidor del port; NO debe envolver ni cachear una instancia de `GestionRealClient` "para ahorrar
cómputo" entre ticks, porque eso reintroduciría el incidente histórico (error 90 "No tiene Acceso",
silencioso, con todo en cero) que motivó el comentario original en el código.

### Decision 5 — Aislamiento del ingest de GR: el motor de métricas no conoce `GestionRealPort`

Ningún use case de Fase 3/4 (bridge, churn, cohortes, CAC, rankings) importa `GestionRealPort` ni
`GestionRealClient` — leen exclusivamente `FinancePaymentReceiptRepository`/`FinanceReceiptApplicationRepository`/
`ContractRepository`/`ContractServiceEventRepository`/los repos de los modelos de Fase 2/3. Solo
`SyncGrReceiptsBackfillBatch`, `SyncGrReceiptsDelta` (Fase 1, nuevos) y `RefreshDebtorBalances` (existente,
extendido con el estado `4`) conocen GR, detrás del port ya existente `GestionRealPort` (extendido con
`fetchReceipts` — no se crea un port nuevo). Esto es consecuencia directa de la arquitectura existente, no
una pieza nueva; se declara explícitamente en el proposal (deuda #1) para que una fase futura no meta una
llamada a GR "para no esperar al sync nocturno" dentro de un use case de métricas.

### Decision 6 — RBAC: módulo `finance` nuevo, separado de `billing`

`billing` (módulo RBAC existente) queda EXCLUSIVAMENTE para las páginas Splynx muertas — no se reusa, para
no heredar accidentalmente acceso a finance-growth a alguien que solo tenía `billing.read` para ver una
factura vieja (o viceversa). Ver tabla de permisos abajo.

## Data Model

10 modelos nuevos, todos aditivos, ninguno toca `Invoice`/`Contract`/`ContractServiceEvent`/`Plan`/
`ContractTechnology` (ver Decision 0b sobre por qué `Invoice` queda intocado).

```prisma
// Fase 1 — clasificación de comprobantes GR (rows, no enum — Decision 2)
model FinanceInvoiceTypeClassification {
  grType    String   @id
  bucket    String   @default("unclassified") // 'revenue' | 'contra' | 'excluded' | 'unclassified'
  label     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// Fase 1 — pacing del ingest de recibos: presupuesto de requests COMPARTIDO entre carril
// delta (prioridad absoluta) y carril backfill (Decision 4b). Molde GestionRealIngestConfig,
// pero el modelo de pacing es nuevo (reemplaza el batch nocturno "1 mes/corrida" descartado).
model FinanceReceiptSyncConfig {
  id                     String   @id @default("singleton")
  enabled                Boolean  @default(true)
  requestIntervalMs      Int      @default(20000)   // ritmo base del presupuesto COMPARTIDO — 1 request GR/20s
  maxRequestIntervalMs   Int      @default(300000)  // techo del backoff adaptativo (5 min) ante 5xx/timeout sostenido
  deltaCheckIntervalMs   Int      @default(300000)  // cada cuánto el carril delta re-chequea "hoy" cuando no tiene páginas pendientes (5 min = "tiempo real")
  backfillFloorYearMonth String   @default("2013-01") // piso histórico; clientes existen desde 2013
  updatedAt              DateTime @updatedAt
}

// Fase 1 — recibo de cobranza GR (Decision 0). Identidad = clave del nodo raíz de `recibos` (a confirmar
// en el primer sync real si es dict keyed-by-id o array — parser defensivo para ambos, pregunta NO-bloqueante #3).
model FinancePaymentReceipt {
  grReceiptId       String   @id
  clientGrId        String?  // Client.grClienteId; nullable/no-FK — el recibo puede preceder al mirror local del cliente
  recaudador        String?  // 'mercadopago' | 'manual' | ... — canal de cobro, vocabulario abierto, sin enum
  fechaRecibo       DateTime? // AR midnight, parseado DD-MM-AAAA (reusa parseGrInvoiceDate)
  fechaConfirmacion DateTime?
  anulado           Boolean  @default(false) // recibos con anulación real NO se persisten (excluidos en el ingest); columna de auditoría, no de filtro en runtime
  observaciones     String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  applications FinanceReceiptApplication[]

  @@index([clientGrId])
  @@index([fechaRecibo])
}

// Fase 1 — aplicación de un recibo a UN comprobante (relación 1-N recibo→aplicaciones, Decision 0b).
// grInvoiceId = "{tipo}-{sucursal}-{numero}", LA MISMA identidad que Invoice.grInvoiceId (gr-invoices-sync),
// pero sin FK dura a Invoice — Invoice puede no tener esa fila (factura ya cobrada, nunca vuelve a estar
// "abierta") y el motor de métricas no la necesita (grType viaja en la propia aplicación).
model FinanceReceiptApplication {
  grApplicationId String   @id
  receiptId       String
  receipt         FinancePaymentReceipt @relation(fields: [receiptId], references: [grReceiptId])
  grInvoiceId     String   // "{tipo}-{sucursal}-{numero}" — misma identidad que Invoice.grInvoiceId, sin FK
  grType          String   // directo de aplicacion.tipo — clasificado vía FinanceInvoiceTypeClassification
  amount          Decimal  @db.Decimal(12, 2)
  appliedDate     DateTime? // AR midnight, de aplicacion.fecha

  @@index([grInvoiceId])
  @@index([appliedDate])
  @@index([receiptId])
}

// Fase 1 (fix-wave-2 R1, decisión LOCK 2026-07-26) — línea de recibo.items[]: CASH efectivamente
// recibido. ES la base de la métrica "cash collected" del spec (Decision 0c) — NUNCA `aplicaciones`,
// que es deuda cancelada y puede exceder el cash cuando el recibo también trae `retenciones`.
model FinanceReceiptItem {
  grItemId            String                @id // sintético "{grReceiptId}-item-{key}", mismo criterio F11
  receiptId           String
  receipt             FinancePaymentReceipt @relation(fields: [receiptId], references: [grReceiptId])
  banco               String?
  cajaCuentaId        String?
  destino             String?
  fecha               DateTime?
  amount              Decimal               @db.Decimal(12, 2)
  moneda              String?
  numeroTransferencia String?
  tipo                String?

  @@index([receiptId])
}

// Fase 1 (fix-wave-2 R1, decisión LOCK 2026-07-26) — línea de recibo.retenciones[]: certificado de
// retención impositiva (retiva/retgan/retib/retpat, vocabulario abierto). NUNCA cash — se expone como
// serie APARTE de la métrica de cash collected, nunca neteada en silencio.
model FinanceReceiptRetencion {
  grRetencionId String                @id // sintético "{grReceiptId}-ret-{key}", mismo criterio F11
  receiptId     String
  receipt       FinancePaymentReceipt @relation(fields: [receiptId], references: [grReceiptId])
  tipo          String?
  amount        Decimal               @db.Decimal(12, 2)
  fecha         DateTime?

  @@index([receiptId])
}

// Fase 2 — costo por tecnología (clave natural = ContractTechnology.name, no FK — deuda declarada #2)
model FinanceTechnologyCost {
  technologyName          String   @id
  costoVentaArs           Decimal  @default(0) @db.Decimal(12, 2)
  costoInstalacionArs     Decimal  @default(0) @db.Decimal(12, 2)
  costoMensualServicioArs Decimal  @default(0) @db.Decimal(12, 2)
  comisionVentaPct        Decimal  @default(0) @db.Decimal(5, 2) // % del abono
  updatedByUserId         String?
  updatedAt               DateTime @updatedAt
}

// Fase 2 — precio estimado por plan (clave natural = Plan.code). Uso EXCLUSIVO: reparto Capa B + CAC "what-if".
model FinancePlanPrice {
  planCode              String   @id
  estimatedMonthlyPrice Decimal  @default(0) @db.Decimal(12, 2)
  updatedByUserId       String?
  updatedAt             DateTime @updatedAt
}

// Fase 2 — metas y config global (molde singleton)
model FinanceTargetsConfig {
  id                       String   @id @default("singleton")
  churnTargetPct           Decimal  @default(5) @db.Decimal(5, 2)
  maxPaybackMonths         Int      @default(12)
  monthlyNewContractsGoal  Int      @default(0)
  inflationBaseYearMonth   String   @default("") // "YYYY-MM"; "" = sin configurar (serie real no disponible)
  updatedAt                DateTime @updatedAt
}

// Fase 2 — índice IPC mensual cargable a mano (Decision 3)
model FinanceInflationIndex {
  yearMonth      String   @id // "YYYY-MM"
  monthlyRatePct Decimal  @db.Decimal(6, 3)
  source         String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}

// Fase 3 — snapshot mensual precomputado (Decision 4, REWORK 2026-07-27 —
// Decision 1b "DOS NÚMEROS, DOS PREGUNTAS"). mrrInicialArs..mrrFinalArs son
// AHORA MRR CONTRATADO (Σ precio de plan × contratos activos, vía
// ContractServiceEvent + FinancePlanPrice) — el bridge corre sobre esto y
// cierra por construcción; NUNCA cash. revenueTotalArs sigue siendo cobranza
// real (cash puro), SIN bridge, serie propia. Migración
// `20261024000200_finance_snapshot_pricing_visibility` (aditiva). fix-wave-3
// (re-review con aritmética verificada) agrega `bridgeResidualArs` y
// `enforcementPlanChangeEventsExcluded` — migración
// `20261024000300_finance_snapshot_bridge_residual_enforcement` (aditiva).
model FinanceMonthlySnapshot {
  yearMonth                String   @id // "YYYY-MM"
  contractsActive          Int
  contractsNew             Int      // conteo RAW de eventos activated/reactivated del mes (informativo — NO el set churn-safe)
  contractsChurned         Int      // conteo RAW de eventos deactivated del mes (informativo)
  contractsUpgraded        Int      // kbps-based (ListInternetServiceHistory.deriveDirection), TODOS los contratos
  contractsDowngraded      Int      // kbps-based, ídem
  mrrInicialArs            Decimal  @db.Decimal(14, 2) // MRR CONTRATADO, computado FRESH cada corrida (nunca encadenado del snapshot anterior — fix F4)
  mrrNewArs                Decimal  @db.Decimal(14, 2)
  mrrUpgradeArs            Decimal  @db.Decimal(14, 2) // delta de PRECIO positivo (price-sign, NO kbps-based — fix "cambio lateral")
  mrrDowngradeArs          Decimal  @db.Decimal(14, 2) // delta de precio negativo (valor absoluto)
  mrrChurnArs              Decimal  @db.Decimal(14, 2)
  mrrFinalArs              Decimal  @db.Decimal(14, 2) // mrrInicial + new + upgrade - downgrade - churn, EXACTO si todo tiene precio resoluble
  bridgeResidualArs        Decimal  @default(0) @db.Decimal(14, 2) // fix-wave-3 🟡4: mrrFinal - (mrrInicial+new+upgrade-downgrade-churn), 0 en el caso sano, hace VISIBLE cualquier hueco
  unpricedContractsActive  Int      @default(0) // contratos activos al cierre sin precio resoluble (F2) — excluidos de mrrFinalArs, nunca 0 silencioso
  unpricedContractsPct     Decimal  @default(0) @db.Decimal(5, 2)
  unpricedPlanChangeEvents Int      @default(0) // eventos 'modified' del mes con precio viejo/nuevo irresoluble — excluidos de mrrUpgrade/mrrDowngrade
  enforcementPlanChangeEventsExcluded Int @default(0) // fix-wave-3 🔴1: eventos 'modified' cuyo plan viejo o nuevo es IP-REDUCCION/IP-BAJA — excluidos de mrrUpgrade/mrrDowngrade aunque tengan precio resoluble
  revenueTotalArs          Decimal  @db.Decimal(14, 2) // COBRANZA REAL — Capa A, cash puro (FinanceReceiptItem), TODO el universo, SIN bridge (Decision 0/0c, sin cambios)
  collectionRatePct        Decimal? @db.Decimal(9, 2)  // TASA DE COBRANZA = revenueInternetAttributedArs / mrrFinalArs * 100 (fix-wave-3 🔴2: numerador corregido de revenueTotalArs, que mezclaba TV-only); null si mrrFinalArs es 0 (sin base, no "0% cobrado")
  revenueAttributableArs   Decimal  @db.Decimal(14, 2) // Capa B diagnóstico (attributionPct), población corregida F6 (incluye bajas del mes)
  unclassifiedAmountArs    Decimal  @default(0) @db.Decimal(14, 2)
  attributionPct           Decimal  @db.Decimal(5, 2)
  arpuArs                  Decimal  @db.Decimal(12, 2) // cash (Capa B) de contratos de internet / contractsActive — nunca revenueTotalArs (fix F5)
  churnContractsPct        Decimal  @db.Decimal(5, 2)  // (bajas ∩ activos-al-inicio ∩ NO activos-al-cierre) / activos-al-inicio — excluye alta+baja (F3) y baja+re-alta (F7)
  churnRevenuePct          Decimal? @db.Decimal(5, 2)  // null si no había ningún contrato activo al inicio del mes (sin base, no "0% churn" — fix F4)
  computedAt               DateTime @default(now())
}

// Fase 3 — cohortes de retención (Decision 4)
model FinanceCohortSnapshot {
  cohortYearMonth String   // mes de alta
  monthsElapsed   Int      // 3 | 6 | 12
  originalCount   Int
  survivingCount  Int
  computedAt      DateTime @default(now())

  @@id([cohortYearMonth, monthsElapsed])
}
```

**Extensión documentada (Fase 6, NO implementada ahora)**: `FinanceTechnologyCost.costoInstalacionArs` es
hoy un valor ESTIMADO configurable. El día que se implemente costo real por consumo de material
(`ContractInstalledItem` + inventario, EPIC #38), el punto de extensión es agregar
`costoInstalacionRealArs Decimal?` (nullable) a `ContractInstalledItem` o computarlo on-the-fly cruzando con
`MaterialStock`/`InventoryAsset` — el motor de CAC (Fase 3) solo necesita que el use case
`ComputeCacAndPayback` reciba ese valor en vez del estimado cuando esté disponible; no requiere tocar el
bridge ni las cohortes.

## Ports (domain/ports/, nuevos)

- `FinanceInvoiceTypeClassificationRepository`: `get(grType)`, `upsertIfAbsent(grType, {bucket:
  'unclassified'})`, `list()`, `updateBucket(grType, bucket, label?)`.
- `FinanceReceiptSyncConfigRepository`: `get()`, `update(patch)` (molde `GestionRealIngestConfigRepository`).
- `FinancePaymentReceiptRepository`: `upsertBatch(receipts)` (idempotente por `grReceiptId`), `exists(grReceiptId)`.
- `FinanceReceiptApplicationRepository`: `upsertBatch(applications)` (idempotente por `grApplicationId`),
  `listByMonth(yearMonth)` (agrupa por `appliedDate` en calendario AR, usado por `BuildFinanceMonthlySnapshot`),
  `listByClientAndMonth(clientGrId, yearMonth)` (usado por la atribución Capa B de Decision 1).
- `FinanceReceiptItemRepository` (fix-wave-2 R1): `upsertBatch(items)` (idempotente por `grItemId`) — base de
  la métrica "cash collected" (Decision 0c); Fase 3/4 le agregará `listByMonth`/`listByClientAndMonth` cuando
  el motor de métricas se implemente (mismo criterio que `FinanceReceiptApplicationRepository`).
- `FinanceReceiptRetencionRepository` (fix-wave-2 R1): `upsertBatch(retenciones)` (idempotente por
  `grRetencionId`) — serie APARTE de certificados impositivos, nunca cash.
- `FinanceTechnologyCostRepository`: `list()`, `getByTechnology(name)`, `upsert(name, patch)`.
- `FinancePlanPriceRepository`: `list()`, `getByPlanCode(code)`, `upsert(code, patch)`.
- `FinanceTargetsConfigRepository`: `get()`, `update(patch)`.
- `FinanceInflationIndexRepository`: `list(fromYearMonth?, toYearMonth?)`, `upsert(yearMonth, patch)`.
- `FinanceMonthlySnapshotRepository`: `get(yearMonth)`, `listRange(from, to)`, `upsert(yearMonth, data)`.
- `FinanceCohortSnapshotRepository`: `listByCohort(cohortYearMonth)`, `upsert(cohortYearMonth,
  monthsElapsed, data)`.

Ninguno de estos ports depende de `GestionRealPort` (Decision 5). Los dos use cases de ingest de Fase 1 sí
dependen de `GestionRealPort` (extendido con `fetchReceipts`) + `SyncStateRepository` (reuso directo, mismo
port que `gr-contracts-backfill`/`gr-contracts-delta`, con la convención de codificación de `cursor` a nivel
de página descrita en Decision 4b) + `FinancePaymentReceiptRepository` + `FinanceReceiptApplicationRepository`
(para persistir) + `FinanceInvoiceTypeClassificationRepository` (para el `upsertIfAbsent` por cada aplicación
sincronizada). Cada `execute()` de estos dos use cases procesa EXACTAMENTE una página GR (Decision 4b) — la
decisión de a CUÁL de los dos carriles llamar en cada tick, y el pacing/backoff entre ticks, vive en
`FinanceReceiptIngestScheduler` (infraestructura), no en los use cases.

## Use Cases (application/use-cases/finance/, nuevos, verbo+sustantivo)

| Use case | Fase | Depende de (ports) |
|---|---|---|
| `SyncGrReceiptsBackfillBatch` — **procesa UNA página GR por `execute()`** (Decision 4b; desviación deliberada del molde `BackfillGrContractsBatch`, que pagina la unidad completa por corrida) | 1 | `GestionRealPort`, `SyncStateRepository`, `FinancePaymentReceiptRepository`, `FinanceReceiptApplicationRepository`, `FinanceInvoiceTypeClassificationRepository`, `FinanceReceiptSyncConfigRepository` (necesita `backfillFloorYearMonth` para saber cuándo disamar) |
| `SyncGrReceiptsDelta` — **procesa UNA página GR por `execute()`** (Decision 4b; desviación deliberada del molde `SyncGestionRealContractsDelta`, que pagina el rango completo por corrida) | 1 | `GestionRealPort`, `SyncStateRepository`, `FinancePaymentReceiptRepository`, `FinanceReceiptApplicationRepository`, `FinanceInvoiceTypeClassificationRepository` (no depende de `FinanceReceiptSyncConfigRepository` — su cadencia la decide el scheduler, no el use case) |
| `FinanceReceiptIngestScheduler` (infraestructura, no use case — molde `GestionRealSyncScheduler`, ver Decision 4b) | 1 | orquesta `SyncGrReceiptsDelta`/`SyncGrReceiptsBackfillBatch` por tick, lee `FinanceReceiptSyncConfigRepository` (para `requestIntervalMs`/`maxRequestIntervalMs`/`deltaCheckIntervalMs`), decide el carril vía `SyncStateRepository`, `DistributedLock` |
| *(modificado, no nuevo)* `RefreshDebtorBalances`: `DEBTOR_LIKE_STATUSES` `['2','3','6']` → `['2','3','4','6']` | 1 | sin cambio de ports — mismos que ya tenía |
| `GetFinanceTechnologyCosts` / `UpdateFinanceTechnologyCost` | 2 | `FinanceTechnologyCostRepository`, `ContractTechnologyRepository` (para el LEFT-JOIN de defaults en cero) |
| `GetFinancePlanPrices` / `UpdateFinancePlanPrice` | 2 | `FinancePlanPriceRepository`, `PlanRepository` |
| `GetFinanceTargets` / `UpdateFinanceTargets` | 2 | `FinanceTargetsConfigRepository` |
| `ListFinanceInflationIndex` / `UpdateFinanceInflationIndex` | 2 | `FinanceInflationIndexRepository` |
| `ListFinanceInvoiceTypes` / `ReclassifyFinanceInvoiceType` | 2 | `FinanceInvoiceTypeClassificationRepository` |
| `BuildFinanceMonthlySnapshot` (REWORK 2026-07-27 — bridgea MRR CONTRATADO, no cash; ver Decision 1b) | 3 | `ContractServiceEventRepository`, `ServiceCatalogRepository`, `PlanRepository`, `PppoeServiceRepository` (fix-wave-2 — corrección de artefacto: faltaba en esta tabla; resuelve el plan vía `findCurrentProfilesByContractIds`, ver Decision 1b), `ClientMirrorReadRepository`, `FinanceReceiptItemRepository`, `FinanceReceiptApplicationRepository`, `FinanceInvoiceTypeClassificationRepository`, `FinancePlanPriceRepository`, `FinanceMonthlySnapshotRepository` |
| `BuildFinanceCohortSnapshot` | 3 | `ContractServiceEventRepository`, `ServiceCatalogRepository`, `FinanceCohortSnapshotRepository` |
| `BackfillFinanceMonthlySnapshots` (NUEVO, rework 2026-07-27, J1) — trigger manual síncrono para un rango `[from,to]`; NO es un scheduler resumible (deuda declarada) | 3 | `BuildFinanceMonthlySnapshot`, `BuildFinanceCohortSnapshot` (compone, no repos directos) |
| `GetFinanceOverview` | 4 | `FinanceMonthlySnapshotRepository`, `FinanceInflationIndexRepository`, `FinanceTargetsConfigRepository` (deflactación en lectura, encadenado desde snapshots ya nominales — el snapshot guarda SOLO nominal; la serie real se deriva en el GET, así una carga tardía de IPC no exige recomputar snapshots) |
| `GetFinanceCohorts` | 4 | `FinanceCohortSnapshotRepository` |
| `ComputeCacAndPayback` | 4 | `FinanceTechnologyCostRepository`, `FinanceMonthlySnapshotRepository` (o query viva sobre altas del mes), `FinanceTargetsConfigRepository` |
| `RankEarlyChurnByVendor` | 4 | `ContractRepository`, `ContractServiceEventRepository`, `FinanceTargetsConfigRepository` (ventana = `maxPaybackMonths`) |
| `RankNetGrowthByNode` | 4 | `ContractRepository`, `ContractServiceEventRepository` |
| `RankCancellationReasonsByLostRevenue` | 4 | `ContractRepository`, `ContractServiceEventRepository`, la atribución de MRR de Decision 1 |

> Nota de decisión de diseño (releída de Decision 4): la deflactación (nominal→real) se hace EN LECTURA
> (`GetFinanceOverview`), no en el snapshot nocturno. Razón: `FinanceMonthlySnapshot` guarda solo montos
> NOMINALES; si se guardara ya deflactado, cargar un IPC atrasado (algo que va a pasar seguido, es carga
> manual) obligaría a recomputar snapshots históricos. Con la deflactación en lectura, cargar el IPC de un
> mes viejo actualiza la serie real INMEDIATAMENTE, sin esperar al próximo job nocturno.

## HTTP Contract (BE↔FE, campo por campo)

Prefijo `/api/finance/growth`. Todas las rutas requieren sesión (`createAuthMiddleware`) + el guard indicado.

> **fix-wave-4 (2026-07-27) — el contrato de los 5 endpoints de este bloque cambió de FORMA** (no sólo de
> comportamiento) contra lo que Fase 5 va a consumir. Ver la sección "fix-wave-4" en el changelog de este
> documento para la justificación de cada campo nuevo/renombrado. Los 5 endpoints TAMBIÉN rechazan ahora un
> `[from, to]` mayor a 240 meses con `400` (🔵17, `assertYearMonthRangeWidth`).

### `GET /overview?from=YYYY-MM&to=YYYY-MM`
Guard: `finance:read`.

> **REWORK 2026-07-27 (Decision 1b)**: `mrrInicialArs`..`mrrFinalArs` son MRR CONTRATADO, NUNCA cash — el
> bridge cierra sobre esta base por construcción. `revenueTotalArs` sigue siendo cobranza real (cash puro),
> serie SIN bridge propia. `collectionRatePct` (nuevo) conecta ambas. `unpricedContractsActive`/
> `unpricedContractsPct`/`unpricedPlanChangeEvents` (nuevos) exponen cuánto del MRR contratado es "no sé"
> (F2) — nunca un cero silencioso.

Response `200`:
```ts
{
  months: Array<{
    yearMonth: string;              // "YYYY-MM"
    contractsActive: number;
    contractsNew: number;           // conteo RAW (activated/reactivated) — informativo, ver churnContractsPct para la tasa
    contractsChurned: number;       // conteo RAW (deactivated) — informativo
    contractsUpgraded: number;      // kbps-based (ListInternetServiceHistory), TODOS los contratos
    contractsDowngraded: number;
    mrrInicialArs: number;          // MRR CONTRATADO — computado fresh, nunca encadenado del mes anterior
    mrrNewArs: number;
    mrrUpgradeArs: number;          // delta de PRECIO (price-sign), no kbps-based
    mrrDowngradeArs: number;
    mrrChurnArs: number;
    mrrFinalArs: number;
    mrrFinalRealArs: number | null;  // null si yearMonth ∈ realSeriesMissingMonths
    bridgeResidualArs: number;       // fix-wave-3 🟡4: mrrFinal - (mrrInicial+new+upgrade-downgrade-churn); 0 en el caso sano, VISIBLE en cualquier otro
    unpricedContractsActive: number; // contratos activos al cierre sin precio contratado resoluble (F2)
    unpricedContractsPct: number;    // 0-100
    unpricedPlanChangeEvents: number;
    enforcementPlanChangeEventsExcluded: number; // fix-wave-3 🔴1: eventos 'modified' del mes sobre un código IP-REDUCCION/IP-BAJA, excluidos de mrrUpgrade/mrrDowngrade
    revenueTotalArs: number;         // COBRANZA REAL — cash puro, SIN bridge, TODO el universo
    revenueTotalRealArs: number | null; // null si yearMonth ∈ realSeriesMissingMonths
    collectionRatePct: number | null; // TASA DE COBRANZA = revenueInternetAttributedArs / mrrFinalArs * 100 (fix-wave-3 🔴2: numerador corregido, misma población que el denominador); null si mrrFinalArs es 0
    revenueAttributableArs: number;   // Capa B diagnóstico (attributionPct), NO alimenta el bridge
    unclassifiedAmountArs: number;
    attributionPct: number;          // 0-100 — población corregida (F6): incluye contratos que se dieron de baja en el mes
    arpuArs: number;                 // cash de contratos de internet / contractsActive (nunca revenueTotalArs — F5)
    churnContractsPct: number;       // 0-100 — excluye alta+baja mismo mes (F3) y baja+re-alta mismo mes (F7)
    churnRevenuePct: number | null;  // null si no había contratos activos al inicio del mes (sin base — F4)
  }>;
  monthsWithoutSnapshot: string[]; // meses de [from,to] SIN fila en FinanceMonthlySnapshot — omitidos de `months`, nunca una fila de ceros
  // fix-wave-4 🔴1 (BREAKING — reemplaza `realSeriesTruncatedAt: string | null`): la lista EXHAUSTIVA de
  // meses de [from,to] cuyo valor real no pudo encadenarse desde `inflationBaseYearMonth` — leer la nulidad
  // de mrrFinalRealArs/revenueTotalRealArs DIRECTAMENTE de cada fila, o cruzar contra esta lista; un único
  // "truncatedAt" no podía describir un hueco no-contiguo (huecos en AMBAS direcciones desde `base` dejan un
  // conjunto de meses reales NO contiguo, ver financeInflation.ts).
  realSeriesMissingMonths: string[];
  inflationBaseYearMonth: string;       // eco de FinanceTargetsConfig, "" si nunca se configuró
  metricBasis: 'cash_collected';        // constante — declara explícitamente que revenueTotalArs/*RealArs de
                                         // este payload es cobranza real, NUNCA facturación emitida (Decision 0).
                                         // Los campos mrr*Ars son MRR CONTRATADO (Decision 1b) — un basis
                                         // DISTINTO, documentado por separado, nunca confundido con este.
}
```

### `GET /cohorts?fromCohort=YYYY-MM&toCohort=YYYY-MM`
Guard: `finance:read`.

Response `200`:
```ts
{
  cohorts: Array<{
    cohortYearMonth: string;
    originalCount: number;
    survival: {
      m3: { survivingCount: number; pct: number } | null;  // null = cohorte aún no llegó a esa edad
      m6: { survivingCount: number; pct: number } | null;
      m12: { survivingCount: number; pct: number } | null;
    };
  }>;
  // fix-wave-4 🟡9 (BREAKING — campo nuevo): meses de [fromCohort,toCohort] SIN NINGUNA fila en
  // FinanceCohortSnapshot (el job/backfill nunca corrió para ese mes) — mismo patrón que
  // `monthsWithoutSnapshot` de /overview. Un mes ausente de `cohorts` Y presente acá = "nunca computado"; un
  // mes ausente de `cohorts` pero NO presente acá no puede pasar (si se computó, aparece con originalCount
  // >= 0). Sin este campo, `cohorts: []` era indistinguible entre "el job nunca corrió" (medido: es el
  // estado real de prod hoy) y "no hubo altas en ningún mes del rango".
  monthsWithoutCohortSnapshot: string[];
}
```

### `GET /cac?technology=&yearMonth=YYYY-MM`
Guard: `finance:read`.

Response `200`:
```ts
{
  technology: string;
  costConfigured: boolean;        // false = NO existe fila en FinanceTechnologyCost — costos/cacArs abajo son null, NUNCA 0
  // fix-wave-4 🟡7 (BREAKING — campo nuevo): true cuando `costConfigured` es true PERO
  // costoVentaArs+costoInstalacionArs === 0 — las 3 columnas de FinanceTechnologyCost son @default(0), así
  // que una fila creada y nunca completada es indistinguible de una tecnología GENUINAMENTE gratis bajo
  // `costConfigured` solo.
  costIsZero: boolean;
  costoVentaArs: number | null;
  costoInstalacionArs: number | null;
  cacArs: number | null;           // costoVentaArs + costoInstalacionArs, null si costConfigured es false
  altasDelMes: Array<{
    contractId: string;
    clientId: string;
    customerName: string | null;
    mrrAtribuidoArs: number;
    attributionConfidence: 'exact' | 'estimated' | 'estimated-equal';
    paybackMonths: number | null; // null si mrrAtribuidoArs es 0 O cacArs es null (nunca divide por cero/null)
    lossMaking: boolean;          // paybackMonths > FinanceTargetsConfig.maxPaybackMonths
  }>;                              // SÓLO altas cuyo Contract.technology matchea `technology` (case-insensitive, fix-wave-4 🟡6)
  // fix-wave-4 🔴2 (BREAKING — campo nuevo): altas del mes (dedupeadas por contrato, mismo criterio que
  // `altasDelMes`) cuyo `Contract.technology` es `null` — UNRESOLVABLE, no "de otra tecnología". Antes de
  // este campo, esas altas desaparecían SIN SEÑAL de `altasDelMes` de TODAS las tecnologías; medido: 5 altas
  // reales con cash cobrado y `technology: null` rendían `altasDelMes: []` con un `cacArs` sano — "CAC
  // $30.000, cero ventas" cuando la verdad era "5 ventas sin clasificar".
  altasDelMesSinTecnologia: number;
  maxPaybackMonths: number;       // eco de FinanceTargetsConfig
}
```

### `GET /vendors/early-churn?from=YYYY-MM&to=YYYY-MM`
Guard: `finance:read`.

Response `200`:
```ts
{
  windowMonths: number;  // = FinanceTargetsConfig.maxPaybackMonths, la ventana "temprano"
  vendors: Array<{
    vendedor: string;         // Contract.vendedor, trimeado (fix-wave-4 🟡11); "sin vendedor" si null/vacío/whitespace
    altasTotal: number;       // TODAS las altas (deduplicadas activated+reactivated por contrato, fix-wave-4 🟡8), maduras o no
    altasChurneadasTemprano: number;
    // fix-wave-4 🟡5 (BREAKING — campo nuevo): DENOMINADOR real de earlyChurnPct, NO altasTotal. "Madura" =
    // su ventana "temprano" ya cerró (ahora >= cutoff, medido desde la fecha REAL de la alta — fix-wave-4
    // 🔴4, nunca desde el 1° de su mes calendario) O ya churneó temprano (veredicto sellado
    // independientemente de si el resto de la ventana transcurrió). Una alta inmadura que NO churneó
    // todavía no tiene veredicto — incluirla en el denominador como "no churneó" diluía la tasa real
    // (medido: 10 maduras/5 churn = 50% real, + 10 de "la semana pasada" = 25% reportado bajo el
    // denominador viejo).
    altasMaduras: number;
    earlyChurnPct: number | null; // fix-wave-4 🟡5 (BREAKING — era `number`): null cuando altasMaduras es 0, NUNCA un 0% adivinado
  }>; // ordenado DESC por earlyChurnPct (nulls al final), desempate ASC por vendedor (fix-wave-4 🔵16)
}
```

### `GET /nodes/growth?from=YYYY-MM&to=YYYY-MM`
Guard: `finance:read`.

Response `200`:
```ts
{
  nodes: Array<{
    networkSiteId: string | null;   // null = contratos sin nodo asignado, agrupados aparte
    networkSiteName: string | null;
    altas: number;                  // deduplicadas activated+reactivated por contrato (fix-wave-4 🟡8) — sin cambio de forma, sólo de conteo
    bajas: number;
    netGrowth: number;              // altas - bajas
  }>; // ordenado ASC por netGrowth (los más negativos primero), desempate ASC por networkSiteId — nulls al final (fix-wave-4 🔵16)
}
```

### `GET /motivos-baja?from=YYYY-MM&to=YYYY-MM`
Guard: `finance:read`.

Response `200`:
```ts
{
  motivos: Array<{
    motivo: string;              // Contract.motivoBaja o ContractServiceEvent.reason; trim + case-insensitive al agrupar (fix-wave-4 🟡10); "sin especificar" si ambos null/vacíos
    bajas: number;
    mrrPerdidoArs: number;
    // fix-wave-4 🔴3 (BREAKING — campo nuevo): cuántas de `bajas`, DENTRO de este motivo, tienen un precio
    // NO resoluble (sin plan, o un plan ausente de FinancePlanPrice) y por eso contribuyen `0` a
    // `mrrPerdidoArs` en vez de su pérdida real. Medido en el estado real de prod: FinancePlanPrice VACÍA
    // (387/387 contratos sin precio) ⇒ TODAS las filas leían `mrrPerdidoArs: 0`, el orden DESC colapsaba a
    // orden de inserción, y la razón de ser del endpoint (rankear por plata) desaparecía sin señal.
    bajasSinPrecio: number;
  }>; // ordenado DESC por mrrPerdidoArs (NO por `bajas`), desempate ASC por motivo (fix-wave-4 🔵16)
}
```

### `GET /contract-changes?from&to&direction=upgrade|downgrade`
Guard: `finance:read`. **No es un endpoint nuevo real** — es un passthrough documentado a
`GET /api/pppoe/internet-history` (o el path real de `ListInternetServiceHistory` — confirmar en Fase 4 el
mount actual) con los mismos query params. Se documenta acá para que el contrato BE↔FE de finance-growth no
quede incompleto, pero la implementación NO duplica lógica.

> **fix-wave-4 — confirmado, GUARD ASIMÉTRICO, para Fase 5**: el passthrough REAL monta en
> `GET /api/pppoe/activation-history`, bajo el guard **`pppoe:read`**, NO `finance:read` — la única excepción
> a "los 6 endpoints de finance-growth usan `finance:*`". Un usuario con `finance:read` pero SIN `pppoe:read`
> come `403` en este endpoint específico y en ningún otro de la sección. La Fase 5 debe manejar ese `403`
> como un caso separado del resto de la sección (o decidir, como cambio de producto, si agregar `finance:read`
> como guard alternativo ahí) — no arreglado en esta fix wave, sólo documentado.

### `GET /config/technology-costs` · `PUT /config/technology-costs/:technologyName`
Guard: `GET` → `finance:read`; `PUT` → `finance:manage_costs`.

`GET` response `200`:
```ts
{
  technologies: Array<{
    technologyName: string;             // ContractTechnology.name, LEFT JOIN con defaults en 0
    costoVentaArs: number;
    costoInstalacionArs: number;
    costoMensualServicioArs: number;
    comisionVentaPct: number;
    updatedAt: string | null;           // null = nunca configurado (defaults en 0)
  }>;
}
```

`PUT` body:
```ts
{ costoVentaArs: number; costoInstalacionArs: number; costoMensualServicioArs: number; comisionVentaPct: number }
```
Validación: los 4 campos son requeridos, numéricos, `>= 0`; `comisionVentaPct <= 100`; **cotas de precisión
derivadas del schema** (`Decimal(12,2)` para los 3 costos ARS, `Decimal(5,2)` para el pct — fix-wave-1 A).
Cualquier violación → `400`, sin actualización parcial. **`technologyName` debe existir en el catálogo
`ContractTechnology` (`getByName`, case-insensitive) → `404 FINANCE_TECHNOLOGY_NOT_FOUND` si no, chequeado
ANTES de cualquier validación de payload (fix-wave-1 D)** — sin este guard, un typo o una tecnología renombrada
después de configurar sus costos upsertea un huérfano invisible (el `GET` está driveado por el catálogo, nunca
por esta tabla). El upsert usa el nombre CANÓNICO del catálogo (`tech.name`), no el string crudo del path, para
no crear una fila case-variant duplicada.

### `GET /config/plan-prices` · `PUT /config/plan-prices/:planCode`
Guard: `GET` → `finance:read`; `PUT` → `finance:manage_costs`.

`GET` response `200`:
```ts
{ plans: Array<{ planCode: string; planName: string; estimatedMonthlyPrice: number; updatedAt: string | null }> }
```
Orden: por `planCode` (natural sort, fix-wave-1 LOW E — `PlanRepository.list()` no garantiza orden).

`PUT` body: `{ estimatedMonthlyPrice: number }` (`>= 0`, cota `Decimal(12,2)`, `400` si no). `planCode` debe
existir en el catálogo `Plan` (`findByCode`) → `404 FINANCE_PLAN_NOT_FOUND` si no (fix-wave-1 D, mismo criterio
que technology-costs). Response `200` incluye `planName` (fix-wave-1 LOW F — el use case ya resuelve el `plan`
del catálogo para el guard D, así que exponerlo es gratis; antes de este fix el PUT omitía `planName` mientras
el GET siempre lo trae, la asimetría exacta que produjo el incidente de filas en blanco del FE).

### `GET /config/targets` · `PUT /config/targets`
Guard: `GET` → `finance:read`; `PUT` → `finance:manage_targets`.

```ts
{
  churnTargetPct: number;
  maxPaybackMonths: number;
  monthlyNewContractsGoal: number;
  inflationBaseYearMonth: string; // "" = sin configurar
}
```
Validación PUT: los 4 campos requeridos; `churnTargetPct` 0-100 + cota `Decimal(5,2)` (fix-wave-1 A, redundante
con el rango de negocio pero consistente con el resto de los settables); `maxPaybackMonths`/
`monthlyNewContractsGoal` enteros `>= 0` + cota de 32 bits (`Int` de Postgres, fix-wave-1 A — sin esta cota un
`1e10` llegaba a Postgres como "integer out of range", `500` opaco en vez de `400`); `inflationBaseYearMonth`
vacío o formato `YYYY-MM`. `400` sin parcial si falla.

### `GET /config/inflation?from=YYYY-MM&to=YYYY-MM` · `PUT /config/inflation/:yearMonth`
Guard: `GET` → `finance:read`; `PUT` → `finance:manage_inflation` (acción separada de `manage_costs` —
permite que quien carga el IPC mensual no tenga acceso a tocar comisiones/costos comerciales).

`GET` response: `{ index: Array<{ yearMonth: string; monthlyRatePct: number; source: string | null }> }`.
`from`/`to` se validan con `isValidYearMonth` → `400` si alguno está mal formado (fix-wave-1 B — antes viajaban
crudos a un `gte`/`lte` de string; un `from` sin `padStart` tipo `2026-1` comparaba lexicográficamente y
devolvía el rango EQUIVOCADO con `200`, sin señal).
`PUT` body: `{ monthlyRatePct: number; source?: string }`. `yearMonth` en el path, formato `YYYY-MM`
validado; `monthlyRatePct` numérico + cota `Decimal(6,3)` (magnitud `< 1000`, fix-wave-1 A — sin esta cota, un
operador pegando el índice INDEC en vez de la tasa mensual, ej. `42000`, llegaba a Postgres como "numeric field
overflow", `500` opaco en vez de `400`); `400` si el path no matchea el formato o `monthlyRatePct` no es
numérico/excede la cota.

### `GET /config/invoice-types` · `PATCH /config/invoice-types/:grType`
Guard: `GET` → `finance:read`; `PATCH` → `finance:manage_costs` (reclasificar un tipo de comprobante es una
decisión contable, mismo permiso que costos — no se crea una 6ª acción para esto).

`GET` response: `{ types: Array<{ grType: string; bucket: 'revenue'|'contra'|'excluded'|'unclassified'; label: string | null; updatedAt: string }> }`
`PATCH` body: `{ bucket: 'revenue'|'contra'|'excluded'; label?: string }` (`unclassified` NO es un valor
válido de entrada — es solo el default de sistema; intentar setearlo explícitamente → `400`).

### `POST /sync/run`
Guard: `finance:sync`. Fuerza al carril delta a quedar `hasPendingPages` de inmediato (arma una corrida
inmediata del carril delta ignorando `deltaCheckIntervalMs`, sin tocar el cursor del carril backfill) de
forma síncrona-fire-and-log (responde `202` inmediato, el resultado se consulta en `/sync/status`). Como el
delta ya tiene prioridad ABSOLUTA en el presupuesto compartido (Decision 4b), forzarlo aquí solo salta la
espera del próximo `deltaCheckIntervalMs` — nunca compite con ni acelera el backfill histórico, que sigue su
propio ritmo automático dentro de `FinanceReceiptIngestScheduler`; este endpoint es para "traeme lo de hoy
ahora", no para acelerar el histórico.

Response `202`: `{ started: true }`

**Guard adicional — `503 SCHEDULER_NOT_RUNNING` cuando el kill-switch está apagado.** Si
`FinanceReceiptIngestScheduler.isEnabled()` (`this.currentEnabled`, ver R7 abajo) es `false`, el endpoint
responde `503 { error: 'finance receipt ingest scheduler is not running', code: 'SCHEDULER_NOT_RUNNING' }` en
vez de `202` (`financeGrowth.routes.ts`, guard `deps.isSchedulerRunning()`). **fix-wave-5 (FE) 🔴3** — este
código NUNCA estuvo documentado acá pese a existir desde R3/R7 abajo, y el FE de Fase 5 lo tradujo
genéricamente a "reintentá en unos segundos" — un consejo FALSO cuando la causa es el kill-switch apagado
(reintentar nunca funciona hasta que alguien lo prenda). El FE debe distinguir `code === 'SCHEDULER_NOT_RUNNING'`
de cualquier otro error de red/5xx transitorio.

**fix-wave-3 R7 — el kill-switch (`FinanceReceiptSyncConfig.enabled=false`) nunca se reactiva solo.** El
scheduler lee la config completa (pacing + `enabled`) en vivo, en cada tick (F6); un fallo de ESA lectura
(timeout, fila lockeada — no hace falta que la DB entera esté caída) hace fallback a
`FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` para el PACING, pero **`enabled` conserva el último valor
REALMENTE observado** (`this.currentEnabled`), nunca los defaults (que son `enabled: true`). Antes de esta
distinción, un operador que apagaba el kill-switch veía las llamadas a GR reanudarse solas ante el primer
hiccup de la config — el mismo bug de mentira que R3 cerró (`/sync/status`/`isEnabled()` reportando
`enabled: true` cuando la DB dice `false`), reabierto por R5 al agregar el fallback de config sin esta
asimetría.

**fix-wave-3 R10 — el lock de este endpoint (`ForceFinanceDeltaRun`) es best-effort DE VERDAD.** Su
escritura (`SyncStateRepository.clearLastRunAt`, R2) es segura en cualquier orden contra un tick concurrente
(actualización de UNA sola columna) — el lock es defensa en profundidad, no la garantía. Si el lock sigue
ocupado agotado el presupuesto de reintentos, este endpoint PROCEDE sin él (con un warning en logs) en vez de
devolver `5xx`: la re-review midió que el presupuesto anterior (calibrado a la latencia de fetch a GR, no al
hold real del tick — fetch + 4 `$transaction` + N upserts) fallaba con `500` en ~10-15% de las requests bajo
pacing normal, un costo estrictamente peor que proceder.

**Asimetría con `POST /sync/rearm-backfill` (fix-wave-1 F9)**: ese endpoint usa el MISMO lock, pero ahí SÍ es
load-bearing — `RearmFinanceReceiptsBackfill` y un tick concurrente escriben la MISMA columna `cursor`
(`SyncStateRepository`'s claim de "columnas disjuntas" para `rearmCursor` es FALSA — ver el fix de
documentación en `SyncStateRepository.ts`). Ahí el lock agotado SÍ debe fallar (nunca escribir sin lock,
mismo criterio que R2/R6 originalmente), pero como `503 Retry-After` (`FinanceSyncLockBusyError`,
`domain/errors/finance.ts`), nunca como `500` genérico — un lock ocupado por un tick hermano es transitorio y
reintentable, no un bug.

### `POST /sync/backfill-snapshots`
Guard: `finance:sync`. **NUEVO (rework 2026-07-27, J1)** — el job nocturno (`FinanceSnapshotScheduler`) SÓLO
recomputa el mes actual + el anterior, para siempre (ver su propio docblock). Sin este endpoint,
`FinanceMonthlySnapshot` nunca tendría filas para meses más viejos, sin importar cuánta historia de recibos
backfillee la Fase 1 — el bridge retroactivo (la razón de ser de este change) nunca existiría. Body:
`{ from: "YYYY-MM", to: "YYYY-MM" }` (inclusive, `from <= to`, cap defensivo de 240 meses por request —
`400` fuera de esos límites). Corre `BuildFinanceMonthlySnapshot` + `BuildFinanceCohortSnapshot` para cada mes
del rango, SÍNCRONO (no arma un scheduler resumible — ver deuda declarada), un mes fallando no aborta el
resto.

Response `200`: `{ monthsComputed: string[], monthsFailed: Array<{yearMonth: string; error: string}> }`

### `GET /sync/status`
Guard: `finance:read`. Lee `SyncState` para las DOS entidades del ingest de recibos: `finance-receipts-delta`
(mismo patrón que `gr-contracts-delta`) y `finance-receipts-backfill` (mismo patrón que `gr-contracts-backfill`),
más `gr-debtor-balances` (existente, ahora también cubre estado `4`), más el estado en memoria del presupuesto
compartido (`FinanceReceiptIngestScheduler`, Decision 4b).

Response `200`:
```ts
{
  pacing: {
    requestIntervalMs: number;       // configurado (FinanceReceiptSyncConfig.requestIntervalMs)
    effectiveIntervalMs: number;     // ritmo REAL actual entre ticks (> requestIntervalMs si degradado)
    degraded: boolean;               // effectiveIntervalMs > requestIntervalMs
    consecutiveFailures: number;     // 0 si no degradado
    activeLane: 'delta' | 'backfill' | 'idle'; // a qué carril fue el ÚLTIMO tick servido
    // fix-wave-2 R3 (BE) — kill-switch operativo (FinanceReceiptSyncConfig.enabled,
    // this.currentEnabled). `false` = el ingest de recibos está APAGADO a propósito:
    // ambos carriles quedan en pausa, "hoy" deja de actualizarse aunque `degraded`
    // sea `false` (degraded mide backoff por fallas, no el kill-switch). Este campo
    // vive en el DTO/código desde R3 pero NUNCA se agregó a este contrato — el FE de
    // Fase 5 copió este bloque sin `enabled`, TypeScript no lo detectó (un campo
    // extra en el JSON es legal), y el panel mostraba "● Sincronización al día" en
    // VERDE con la ingesta apagada (fix-wave-5 FE 🔴3). Documentado acá para que no
    // vuelva a driftear.
    enabled: boolean;
  };
  delta: {
    lastRunAt: string | null;
    lastResult: string | null;
    itemsSynced: number;
    pendingPages: boolean;           // true = a mitad de ponerse al día con "hoy" (el backfill está cediendo el turno)
    coveredThroughDate: string | null; // "DD-MM-AAAA", último día ya cubierto por una corrida completa
  };
  backfill: {
    lastRunAt: string | null;
    lastResult: string | null;
    itemsSynced: number;             // acumulado histórico
    cursorYearMonth: string | null;  // próximo mes a backfillear (o el que está en curso) caminando hacia atrás; null si terminó (done)
    cursorPageOffset: number;        // offset de página dentro de cursorYearMonth; 0 = arrancando ese mes desde cero
    done: boolean;
  };
  debtorBalances: { lastRunAt: string | null; lastResult: string | null; itemsSynced: number };
  // REWORK 2026-07-27 (J3) — antes de este campo, el job nocturno de
  // snapshots (FinanceSnapshotScheduler) NO tenía NINGÚN estado consultable:
  // sus errores iban a console.log y a un valor de retorno que nadie
  // consumía (main.ts es fire-and-forget). Si fallaba TODAS las noches, el
  // panel mostraba el último mes bueno para siempre — indistinguible de
  // "no cambió nada". itemsSynced acá NO es acumulado histórico (a
  // diferencia de delta/backfill/debtorBalances) — es "meses recomputados
  // en el ÚLTIMO tick" (0-2), porque este job re-computa la MISMA ventana
  // de 2 meses cada noche en vez de avanzar por un backlog.
  snapshotJob: { lastRunAt: string | null; lastResult: string | null; itemsSynced: number };
}
```
Nota: `FinanceReceiptSyncConfig` (pacing/piso) no tiene endpoint HTTP propio en este change — es un singleton
operativo, no un settable de negocio (a diferencia de `FinanceTargetsConfig`/`FinanceTechnologyCost`), y se
edita por migración/DB directa si hace falta ajustar el ritmo en producción. Fuera de alcance agregar un
`GET/PUT /config/receipt-sync` acá; el FE calcula cobertura % combinando `cursorYearMonth` (arriba) con el
mes calendario actual, sin necesitar leer `backfillFloorYearMonth` en tiempo real.

## RBAC — claves exactas de las dos capas

| BE (module, action) | BE guard (doc, colon) | FE wire key (dot, `/me`) | Uso |
|---|---|---|---|
| `finance`, `read` | `finance:read` | `finance.read` | Todas las rutas GET de overview/cohortes/CAC/rankings/config |
| `finance`, `manage_costs` | `finance:manage_costs` | `finance.manage_costs` | PUT technology-costs, PUT plan-prices, PATCH invoice-types |
| `finance`, `manage_targets` | `finance:manage_targets` | `finance.manage_targets` | PUT targets |
| `finance`, `manage_inflation` | `finance:manage_inflation` | `finance.manage_inflation` | PUT inflation |
| `finance`, `sync` | `finance:sync` | `finance.sync` | POST sync/run |

Cambios en `src/domain/entities/rbac.ts`: agregar `'finance'` a `RBAC_MODULES`; agregar `'manage_costs'`,
`'manage_targets'`, `'manage_inflation'` a `KNOWN_ACTIONS` (la acción `'sync'` YA existe — se reusa, no se
duplica). El BE llama `requirePermission(userRepo, 'finance', 'read')` etc. (misma firma de dos argumentos
que el resto de las rutas — el "colon" es convención de documentación/catálogo, no un string literal en el
código). El FE consume `useMyPermissions().can('finance.read')` / `<RequirePermission permission="finance.manage_costs">`.

## Wiring (`app.ts`)

- `bootstrapFinanceReceiptsIngest.ts` (molde `bootstrapGestionRealSync.ts`, UN solo bootstrap — reemplaza los
  dos bootstraps independientes de la versión previa de este design, ver Decision 4b): lee
  `FinanceReceiptSyncConfig`, si `enabled=false` no arranca (no-op), construye `FinanceReceiptIngestScheduler`
  con `SyncGrReceiptsDelta` + `SyncGrReceiptsBackfillBatch` + `PgAdvisoryLock` (lock key
  `finance-receipts-ingest`) y lo arranca. El scheduler decide QUÉ carril corre en cada tick (delta con
  prioridad absoluta) y programa el siguiente tick con `setTimeout` recursivo usando el
  `effectiveIntervalMs` vigente (NUNCA `setInterval` fijo — el intervalo cambia bajo backoff, ver Decision
  4b). Un solo timer, un solo `.unref()`.
- `bootstrapFinanceSnapshotJob.ts`: corre `BuildFinanceMonthlySnapshot` + `BuildFinanceCohortSnapshot` una
  vez por noche (ej. 03:00 AR, `setInterval` de 24h — el snapshot SÍ es un batch nocturno legítimo, a
  diferencia del ingest: agrega meses ya cerrados, no compite por el presupuesto de GR). A diferencia del
  ingest (que ahora es continuo, sin "ciclo" discreto que termine), este job simplemente lee
  `FinancePaymentReceipt`/`FinanceReceiptApplication` en el momento en que corre — un mes puede snapshotearse
  con datos parciales si el carril delta o backfill todavía no llegaron a cubrirlo del todo esa noche, y se
  recalcula la noche siguiente con más datos (mismo criterio de "no bloquea, se corrige solo" que el resto
  del motor de métricas). NO depende del backfill (los meses ya backfilleados se snapshotean cuando estén
  disponibles; los que faltan simplemente no tienen fila todavía).
- `createFinanceGrowthRouter(...)` montado en `/api/finance/growth`, ANTES de cualquier futuro catch-all
  `/:id` que este módulo pudiera necesitar (hoy no tiene sub-recursos con `:id` genérico, así que no aplica
  el riesgo de orden de routers, pero se documenta la regla por si Fase 6 agrega uno).
- Composition-root test nuevo (molde `inventory-composition-root.test.ts`): assert estático de que
  `app.ts` efectivamente wirea `SyncGrReceiptsBackfillBatch`/`SyncGrReceiptsDelta`/`BuildFinanceMonthlySnapshot`
  con sus repos Prisma reales (no un fixture de test filtrándose a prod) — mismo mecanismo que evitó la
  feature muerta de W6.

## FE — campo por campo consumido, notas de implementación

- Sección de sidebar propia (nombre placeholder "Crecimiento Financiero" — pregunta abierta NO-bloqueante
  #3 del proposal), NO anidada bajo el grupo "Finanzas" existente.
- Página principal: KPI tiles (contratos activos, MRR nominal vs. real del último mes, ARPU, churn
  contratos%, churn revenue%) + gráfico de bridge (waterfall) + toggle nominal/real con leyenda de
  `realSeriesMissingMonths` cuando aplica (fix-wave-4 🔴1 — lista completa, no un único cutoff; mensaje
  explícito por cada tramo sin dato, no un gráfico que se corta sin explicación).
  Disclaimer visible y permanente (no un tooltip escondido) anclado a `metricBasis: 'cash_collected'`:
  "Basado en cobranza real, no en facturación emitida" — mismo espíritu honesto que `attributionPct`.
- Página de cohortes: matriz/heatmap de supervivencia 3/6/12 meses.
- Página de ranking vendedor: tabla ordenable, columna `earlyChurnPct` destacada visualmente por encima de
  `altasTotal` (jerarquía visual invertida a propósito respecto de un ranking de ventas tradicional — es
  el punto del pedido).
- Página de settings: 4 sub-secciones (costos por tecnología, precios por plan, metas, índice IPC), cada
  una con sus 4 estados (loading/empty/error/success), `Select`/`Combobox` propio para elegir tecnología/mes
  (nunca `<select>` nativo), validación de formulario espejando las reglas `400` del BE antes de enviar.
- Todos los montos en ARS se formatean con `Intl.NumberFormat('es-AR', {style:'currency', currency:'ARS'})`
  — consistencia con el resto del panel financiero existente (a verificar el helper compartido real en
  `ipnext-frontend` durante Fase 5, no inventar uno nuevo si ya existe).
- Gráficos: paleta y tokens del design system (`var(--color-*)`), sin colores ad-hoc; mínimo 2 series
  visualmente distinguibles (nominal vs. real) con contraste ≥4.5:1 en ambos temas.
- Permisos: `<Can permission="finance.read">` envuelve la sección completa; los botones de edición de cada
  sub-sección de settings usan su propio `finance.manage_*`; el botón de "sincronizar ahora" usa
  `finance.sync` y se deshabilita (no se oculta) con tooltip explicativo mientras `lastResult` indica una
  corrida en curso.

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | +10 modelos (ver Data Model). Aditivo. |
| `prisma/migrations/*_finance_growth_foundation/` | Create | Las 10 tablas + seed `FinanceInvoiceTypeClassification{FB,revenue}` + seed `FinanceReceiptSyncConfig{singleton}` + seed `FinanceTargetsConfig{singleton}`, todo `ON CONFLICT DO NOTHING`. |
| `src/domain/entities/rbac.ts` | Modify | +módulo `finance`, +3 acciones (`manage_costs`/`manage_targets`/`manage_inflation`). |
| `src/domain/ports/GestionRealPort.ts` | Modify | +método `fetchReceipts(params)` (Fase 1, ver Decision 0). Aditivo, no cambia la firma de los métodos existentes. |
| `src/domain/entities/gestionReal.ts` | Modify | +tipos `GrReceipt`, `GrReceiptApplication` (Fase 1). |
| `src/domain/ports/Finance*Repository.ts` | Create | 9 ports nuevos (ver Ports) — `SyncStateRepository` se REUSA, no se crea uno nuevo para el ingest. |
| `src/application/use-cases/finance/*.ts` | Create | `SyncGrReceiptsBackfillBatch`, `SyncGrReceiptsDelta` (Fase 1) + CRUD de config (Fase 2) + `BuildFinanceMonthlySnapshot`/`BuildFinanceCohortSnapshot` (Fase 3) + queries de lectura (Fase 4), ~16 use cases, verbo+sustantivo. |
| `src/application/use-cases/RefreshDebtorBalances.ts` | Modify | `DEBTOR_LIKE_STATUSES` `['2','3','6']` → `['2','3','4','6']`. Única modificación a un use case existente. |
| `src/application/dto/finance.ts` | Create | DTOs de los payloads HTTP (ver HTTP Contract) — nunca entidades Prisma crudas. |
| `src/infrastructure/adapters/gestion-real/GestionRealClient.ts` | Modify | +`fetchReceipts` (parseo dict→lista de `aplicaciones`/nodo raíz, exclusión de anulados, formato `DD-MM-AAAA`). |
| `src/infrastructure/adapters/prisma/Prisma{Entity}Repository.ts` | Create | 9 adapters Prisma, naming exacto. |
| `src/infrastructure/adapters/in-memory/InMemory{Entity}Repository.ts` | Create | 9 adapters in-memory (tests). |
| `src/infrastructure/scheduling/FinanceReceiptIngestScheduler.ts` | Create | Árbitro del presupuesto compartido (Decision 4b) — molde `GestionRealSyncScheduler`, `setTimeout` recursivo (intervalo dinámico bajo backoff). |
| `src/infrastructure/scheduling/bootstrapFinanceReceiptsIngest.ts` | Create | UN bootstrap (reemplaza los 2 bootstraps independientes descartados) — construye y arranca `FinanceReceiptIngestScheduler`. |
| `src/infrastructure/scheduling/bootstrapFinanceSnapshotJob.ts` | Create | Job nocturno Fase 3, sin cambios de este rediseño. |
| `src/infrastructure/http/routes/financeGrowth.routes.ts` | Create | Router `/api/finance/growth/*`. |
| `src/infrastructure/http/app.ts` | Modify | Wiring de router + 2 jobs (`FinanceReceiptIngestScheduler` fusiona los 2 bootstraps previos en uno, Decision 4b; + snapshot nocturno de Fase 3); composition-root test nuevo. |
| `ipnext-frontend/src/pages/finance-growth/*` | Create | Sección nueva, 4 páginas + settings. |
| `ipnext-frontend/src/hooks/useFinanceGrowth*.ts` | Create | Hooks TanStack Query por endpoint. |

## Preguntas de diseño que quedan abiertas hacia tasks.md

- Hora exacta del job nocturno de snapshot (Decision 4/Wiring) — como el carril delta ahora es CONTINUO
  (Decision 4b, no "corre a las 02:00" como en la versión previa), el snapshot simplemente toma un horario de
  madrugada fijo (ej. 04:00 AR) y lee lo que el delta ya haya cubierto a esa hora; no hace falta coordinar dos
  horarios entre sí. No bloquea el diseño, se resuelve en implementación.
- Forma exacta del nodo raíz de `recibos` (dict keyed-by-id o array plano) — NO-BLOQUEANTE, parser
  defensivo desde el día 1 (ver Decision 0, gotcha #2); **actualizado fix-wave-3**: confirmado en vivo (100
  recibos reales) que `recibos`/`aplicaciones`/`items`/`retenciones` son SIEMPRE dict con ids globalmente
  únicos — la rama `array` de `parseReceiptsResponse` (y su fallback `page${offset}-${key}`) queda CONFIRMADA
  código muerto contra la API real hoy; se mantiene como defensa en profundidad ante un cambio futuro de GR,
  documentado inline como tal (no se borra).
- **Deuda declarada, fix-wave-3** (no bloqueante, explícitamente diferida): (a) sin limpieza de huérfanos —
  si GR corrige un recibo con MENOS líneas, las filas viejas de `items`/`aplicaciones` quedan (upsert-only,
  sin delete); latente porque los recibos son inmutables en la práctica. (b) índice compuesto para
  `listByClientAndMonth` — **corregido fix-wave-4**: esta nota decía "hoy filtra en memoria sobre el
  resultado de `listByMonth`" para AMBOS adapters, lo cual es cierto SÓLO para los in-memory (dobles de
  test); el adapter Prisma real filtra con un WHERE/JOIN (`receipt: { clientGrId }` sobre `appliedDate`
  para aplicaciones, `receipt: { clientGrId, fechaRecibo }` para items desde fix-wave-4 W2), no en memoria.
  El índice compuesto que faltaría (si Fase 3 lo hace notar al volumen real) es
  `(clientGrId, appliedDate)` en `FinanceReceiptApplication` y `(clientGrId, fechaRecibo)` en
  `FinancePaymentReceipt` (NO `(clientGrId, fecha)` en `FinanceReceiptItem` — ese cut se abandonó, ver W2).
  (c) semántica exacta de `itemsSynced` (¿recibos, o líneas persistidas?) sin unificar entre delta/backfill.
  (d) `grInvoiceId` con `tipo` null en `mapGrReceipt.ts` — comportamiento no verificado contra un caso real.
  (e) test RBAC 1.55 (`ListAllPermissionsWithModule.test.ts`) pendiente desde fix-wave-1, no tocado por esta
  ronda.
- **Deuda declarada, fix-wave-1 (Fase 2)** — 2 revisores adversariales (uno con mutation testing real sobre
  `financeGrowth.routes.test.ts`) encontraron 4 🟡 (D/C/B/A, todos cerrados esta ronda) + 8 🔵. De los 🔵:
  **E** (orden no determinístico de `GET /config/plan-prices`), **F** (`PUT /config/plan-prices/:planCode` sin
  `planName`) y **G** (sin test de payload parcial en `PUT /config/targets`) quedaron **cerrados** esta ronda
  (ver HTTP Contract arriba). Quedan abiertos, deliberadamente:
  - **(f) Huérfanos de `FinanceTechnologyCost`/`FinancePlanPrice` PRE-EXISTENTES al fix D no se limpian ni se
    exponen.** El fix D (existencia contra catálogo → `404`) cierra la puerta a NUEVOS huérfanos vía `PUT`, pero
    no toca filas que ya pudieran existir de un typo/rename anterior a esta ronda — no hay endpoint para
    listarlas ni borrarlas. Riesgo bajo en la práctica (Fase 2 recién sale de fix-wave, sin uso en prod
    todavía), pero si esta ronda se archiva con datos de prueba cargados manualmente, revisar antes de Fase 3.
  - **(f bis) `PUT /api/contract-technologies/:id` (rename) sigue sin propagar a `FinanceTechnologyCost.technologyName`.**
    Es un agujero DISTINTO de la deuda #2 (falta de FK): incluso con FK, un rename sin cascada rompería el join
    salvo que la FK apunte por `id` en vez de por `name` — que es exactamente lo que resolvería esto de raíz.
    Decisión: no implementar un cascade ad-hoc en `UpdateContractTechnology` (acoplaría el módulo de catálogo de
    tecnologías al módulo de finanzas, cross-cutting que el resto del código evita). La solución correcta es la
    deuda #2 en sí — migrar `FinanceTechnologyCost`/`FinancePlanPrice` a clave por `id` (FK real) en vez de
    clave natural — momento en el que un rename deja de poder romper nada. Documentado, no forzado esta ronda.
  - **(g) H — `PrismaPlanRepository.list()` no filtra por `status`,** por lo que `GET /config/plan-prices`
    también lista planes dados de baja. Cosmético (ruido en la UI de config, ningún número de negocio se ve
    afectado). No corregido: `ListPlans` (el use case hermano para el catálogo de planes) TAMPOCO filtra por
    `status` — introducir el filtro solo acá crearía una inconsistencia nueva entre las dos vistas del mismo
    catálogo. Si se corrige, debe ser una decisión de producto sobre AMBOS use cases a la vez, no un parche
    aislado en finance-growth.
  - **(h) I — `inflationBaseYearMonth` no valida plausibilidad** (un ancla `'0000-01'` pasa el formato). Por
    Decision 3 el mes ancla no necesita fila propia hoy, así que no es bug de Fase 2 — el guard de plausibilidad
    (ej. rechazar años fuera de un rango razonable) requiere elegir un umbral arbitrario, que es mejor decidir
    en Fase 4 cuando `GetFinanceOverview` (el consumidor real del ancla) exista y se sepa qué rango es plausible
    en la práctica, en vez de inventar uno ahora sin ese contexto.
  - **(i) — Flanco estructural: los 4 adapters Prisma de Fase 2
    (`PrismaFinanceTechnologyCostRepository`/`PrismaFinancePlanPriceRepository`/`PrismaFinanceTargetsConfigRepository`/
    `PrismaFinanceInflationIndexRepository`) tienen CERO cobertura de test y no son ejecutables sin una DB real
    en este harness.** Los hallazgos A (overflow de precisión) y E (orden de heap de Postgres) y el redondeo de
    escala salieron TODOS de ahí — son comportamientos de Postgres que ningún doble in-memory puede modelar sin
    reimplementar el motor. El fix de A cierra el síntoma (valida ANTES de llegar a Prisma), pero el adapter en
    sí sigue sin un solo test que ejercite `gte`/`lte` de string, el fallback a defaults del singleton, o el
    round-trip real de `Decimal`. No bloqueante para archivar Fase 2 (no hace falta levantar Postgres en CI para
    esto), pero cualquier fase futura que toque estos adapters debe asumir que están, en los hechos, sin probar.

- **Deuda declarada — rework Fase 3 (2026-07-27), motor de métricas — 2 revisores adversariales, 6 🔴 + 6 🟡
  cerrados; lo que sigue quedó abierto A PROPÓSITO:**
  - **(j) La causa raíz de F2 sigue sin resolverse: `'activated'` no lleva plan.** *(Nota fix-wave-3: esta
    entrada describe el estado PRE-fix-wave-2 — la Decision 1b/fix-wave-2, aplicada DESPUÉS de escribirse este
    párrafo, ya resolvió la cobertura anclando en `PppoeService.profile`; ver ese fix-wave-3's sección de
    deuda declarada para el detalle de qué quedó vigente y qué no. Se deja el texto original sin reescribir
    para no perder el registro histórico de la decisión.)* El fix de esta ronda hace el
    síntoma VISIBLE (`unpricedContractsActive`/`unpricedContractsPct`/`unpricedPlanChangeEvents`) y CORRECTO
    (nunca trata "sin precio" como precio 0), pero NO resuelve por qué un contrato nunca-modificado no tiene
    plan conocido. Resolverlo de raíz exige elegir UNA de: (a) capturar el plan en el evento `'activated'`
    mismo (cambio de contrato en el punto de creación del evento, afecta a TODO consumidor de
    `ContractServiceEvent`, no sólo finance-growth), (b) resolver el plan retroactivamente contra un mapeo de
    perfil RADIUS/PPPoE (una fuente de datos nueva, con su propio riesgo de reconciliación), o (c) aceptar el
    hueco y documentarlo como parte permanente del contrato de la métrica. Ninguna de las tres es una decisión
    chica — se deja para que la próxima ronda de spec/design la tome explícitamente, con el volumen real de
    contratos afectados medido en producción (esta ronda no tuvo acceso a ese número).
  - **(k) J2 (N+1 de la atribución Capa B) — SÓLO el índice compuesto se agregó** (`FinancePaymentReceipt
    (clientGrId, fechaRecibo)`, migración `20261024000200`); el patrón de query en sí
    (`BuildFinanceMonthlySnapshot`'s `computeAttributionForMonth`, una query `listByClientAndMonth` POR
    CLIENTE) sigue sin batchear. Arreglarlo bien requiere un método de puerto nuevo (`listAmountsGroupedByClientForMonth`
    o similar) implementado en AMBOS adapters (Prisma vía `groupBy`, in-memory vía reduce) — un cambio de
    contrato de puerto que esta ronda no forzó para no inflar el diff de un rework ya grande. Sigue siendo un
    job nocturno, no un endpoint interactivo — el índice mitiga el costo por query mientras tanto.
  - **(l) J1 se resolvió con un trigger MANUAL, no un scheduler resumible.** `BackfillFinanceMonthlySnapshots`
    (`POST /sync/backfill-snapshots`) es síncrono, cap de 240 meses por request, sin `SyncState` propio — un
    operador (o un script) debe invocarlo explícitamente en chunks para cubrir los 163 meses de historia. Una
    versión totalmente automática (su propio carril en `FinanceReceiptIngestScheduler`, o un scheduler
    hermano con cursor persistido) es la mejora natural, pero es una PIEZA DE INFRAESTRUCTURA NUEVA — el mismo
    criterio que motivó no forzar (a) arriba.
  - **(m) J3 se resolvió sólo del lado de PERSISTENCIA + el endpoint YA EXISTENTE.** `FinanceSnapshotScheduler`
    ahora escribe su estado a `SyncStateRepository` (entidad `finance-snapshot-job`) y `GET /sync/status` ya lo
    expone (campo `snapshotJob`) — no hizo falta crear infraestructura nueva porque el router de Fase 1 ya
    existía. Sin deuda residual conocida en este punto.
  - **(n) F10/F11 (🔵, sin cerrar esta ronda)**: un contrato cortado por mora (`IP-REDUCCION`, sin precio)
    pesa 0 en el reparto de cobranza Capa B, haciendo que el otro contrato del mismo cliente absorba el 100%
    del cash — degrada `attributionConfidence` justo para los clientes deudores, el peor momento para que la
    atribución sea menos confiable. Y `orphanClientCount`/`findLastCollectedAmount` (este último YA NO EXISTE
    tras el rework — el nuevo modelo no necesita lookback de cash para el churn) tenían un patrón de recómputo
    redundante en el modelo viejo; el nuevo modelo sólo conserva el conteo de huérfanos, sin el lookback.
  - **(o) J4/J5/J6 (🔵, sin cerrar esta ronda)**: `BuildFinanceCohortSnapshot.execute()` sigue haciendo 3
    upserts separados (edades 3/6/12) — un fallo a mitad deja la cohorte incompleta por una noche
    (autocorregible la noche siguiente, anotado no resuelto). Reentrancia del guard `inFlight` intra-proceso
    sigue sin test directo (sólo el skip por lock ocupado). Auditabilidad: el snapshot guarda sólo agregados —
    reconstruir "¿por qué el churn de marzo fue X%?" exige re-derivar contra los eventos; el rework no agregó
    un log/tabla de detalle por contrato (hubiera sido una tabla nueva, deliberadamente fuera de alcance).

- **fix-wave-3 (2026-07-27) — re-review CON ARITMÉTICA VERIFICADA (escenarios ejecutados contra el código
  real, no sólo leídos): 2 🔴 bloqueantes + 3 acotados, los 5 corregidos esta ronda:**
  - **🔴 1 — el loop de PLATA no excluía planes de enforcement (el de CONTEOS y `resolvedPlanCodeAt` sí).**
    `mrrUpgradeArs`/`mrrDowngradeArs` leían `e.oldPlan`/`e.newPlan` sin el guard `isEnforcementPlan` que
    `deriveDirection` (conteos) y `resolvedPlanCodeAt` (mrrInicial/mrrFinal) ya tenían. Alcanzable desde la UI
    (`IP-REDUCCION`/`IP-BAJA` son filas normales del catálogo `Plan`, editables vía
    `GetFinancePlanPrices`/`UpdateFinancePlanPrice`). Medido: un solo evento con `IP-REDUCCION` priceada
    producía un `mrrDowngradeArs` fantasma de 10000 (gap -10000); a escala (200 eventos en el mes) el gap
    medía -3.000.000. **Fix**: guard `isEnforcementPlan(oldPlan) || isEnforcementPlan(newPlan)` en el loop de
    plata, contado en el campo nuevo `enforcementPlanChangeEventsExcluded` (nunca en silencio, nunca mezclado
    con `unpricedPlanChangeEvents` — ahí el precio SÍ puede ser resoluble, la exclusión es por el código en
    sí). Ver `BuildFinanceMonthlySnapshot.ts` y sus tests "fix-wave-3 🔴 1".
  - **🔴 2 — `collectionRatePct` mezclaba poblaciones ⇒ podía superar 100% con una base que pagó exacto.**
    Numerador `revenueTotalArs` (Capa A, cash de TODO el universo, incluye clientes SOLO-TV — decisión LOCK)
    sobre denominador `mrrFinalArs` (MRR contratado, SÓLO internet). Medido: 1 contrato de internet (MRR
    10000) que paga 10000 exacto + 1 cliente TV-only que paga 40000 ⇒ `collectionRatePct: 500` (la verdad es
    100). **Fix**: numerador cambiado a `revenueInternetAttributedArs` (Capa B, ya calculado un par de líneas
    arriba para `arpuArs`/`attributionPct`) — misma población que el denominador. `revenueTotalArs` en sí
    (Capa A, expuesto aparte) no cambió.
  - **🟡 3 — el resultado no era reproducible entre corridas.** `PrismaPppoeServiceRepository
    .findCurrentProfilesByContractIds` hacía `findMany({ where })` sin `orderBy` (orden de heap de Postgres,
    reacomodable tras un `UPDATE`/`VACUUM`), y el desempate de `pickCurrentPppoeService` (rank →
    `createdAt` desc) no rompía un empate genuino de `createdAt` (filas insertadas en el mismo milisegundo por
    un script de import masivo) — un empate así se resolvía por la ESTABILIDAD de `Array.sort` sobre el orden
    de entrada, no determinístico si ese orden venía de Postgres. Medido: mismas filas, distinto orden de
    entrada ⇒ MRR 10000 vs 15000 para el MISMO mes. **Fix**: `pickCurrentPppoeService` (domain, compartido por
    los dos adapters) generalizado a `T extends Pick<PppoeService, 'status'|'createdAt'|'id'>` con un
    desempate FINAL por `id` — determinístico sin importar el orden de entrada — + `orderBy:
    [{createdAt:'desc'},{id:'asc'}]` en el adapter Prisma como defensa en profundidad adicional (mismo
    criterio que ya usa `list()`).
  - **🟡 4 — el residuo del bridge no tenía ninguna señal cuando no cerraba.** Un extremo sin precio, un
    evento `'modified'` perdido por el `try/catch` best-effort de `ChangePppoePlanService`, o cualquier caso
    futuro no previsto, dejaban un gap (medido: -15000) sin NINGUNA bandera — `unpricedContractsActive: 0` en
    ese mismo caso. **Fix**: campo nuevo `bridgeResidualArs = mrrFinal - (mrrInicial+new+upgrade-downgrade-
    churn)`, `0` en el caso sano (asertado en el test de los 9 movimientos), el valor real del hueco en
    cualquier otro caso (asertado ahora en el test F2/C1 de precio irresoluble, que antes montaba el caso
    pero nunca verificaba la identidad). Migración aditiva
    `20261024000300_finance_snapshot_bridge_residual_enforcement` (junto con `enforcementPlanChangeEventsExcluded`
    del fix 🔴1).
  - **🔵 5a — el backfill manual no tenía techo temporal hacia adelante.** `BackfillFinanceMonthlySnapshots`
    validaba formato, `from<=to` y el cap de 240 meses, pero no `to <= mes actual` — un `to: 2030-12`
    congelaría decenas de snapshots en cero que `GetFinanceOverview` leería como una caída real. **Fix**:
    guard nuevo contra `arYearMonth(now())` (reloj inyectable, default `() => new Date()`, sólo para tests).
  - **🔵 5b — la proyección de plan traía el `password` del RADIUS de TODOS los PPPoE a memoria.**
    `findCurrentProfilesByContractIds` hacía `findMany` sin `select` — el propio puerto ya declara la
    convención opuesta para `findByUsernames` ("la proyección OMITE `password` a nivel de TIPO"), y este
    método se llama una vez por mes × hasta 163 meses en un backfill completo. **Fix**: `select: { id,
    contractId, profile, status, createdAt }` — mismo fix que el `orderBy` de 🟡3, mismo método.

  **Documentado, NO arreglado esta ronda (decisión pendiente del usuario o deuda de bajo riesgo):**
  - **LIMITACIÓN EXPLÍCITA — `FinancePlanPrice` no tiene historia de precios.** `planCode` es la clave, un
    ÚNICO `estimatedMonthlyPrice` vigente — sin `validFrom`/vigencia por período. El bridge resuelve el MRR
    contratado de CUALQUIER mes pasado contra el precio ACTUAL. Medido: el mismo contrato da
    `mrrFinalArs(2019-06) = 42000` y `mrrFinalArs(2026-06) = 42000` para el mismo plan, cuando el precio real
    de 2019 rondaba los $700 — con la inflación argentina, el MRR contratado histórico valuado a precios de
    hoy es **ficción**, congelada en `FinanceMonthlySnapshot` hasta el próximo backfill de ese mes. **El
    backfill histórico NO debe correrse** (más allá de una ventana reciente donde los precios cargados sean
    representativos) hasta que el usuario elija entre: (a) agregar historia de precios (`validFrom`) a
    `FinancePlanPrice`, (b) limitar el backfill histórico a una fecha de corte con precios representativos, o
    (c) aceptar la ficción con el número explícitamente etiquetado en la UI. Ver también spec.md, Requirement
    "Monthly snapshots must be backfillable on demand...".
  - **`TransferPppoe` y la resolución retroactiva de plan.** Mover un `PppoeService` de un contrato a otro
    hace que `resolvedPlanCodeAt` para meses ANTERIORES a la transferencia también resuelva contra el
    `profile` actual (rebobinado sólo por la historia de `'modified'` del contrato DESTINO, que no tiene los
    eventos del contrato ORIGEN) — el caso típico de titularidad (destino es un contrato NUEVO, sin historia
    previa) no tiene efecto observable porque el destino no tenía meses pasados que recomputar, pero un
    `TransferPppoe` hacia un contrato EXISTENTE con historia propia sí podría contaminar meses pasados de ese
    contrato con un plan que en ese momento no tenía. No medido en producción esta ronda (bajo volumen
    esperado de este caso); documentado como riesgo, no arreglado.
  - **Multi-PPPoE por contrato — `pickCurrentPppoeService` elige un ganador, `contractId` no es `unique`.**
    Un contrato con más de un `PppoeService` (multi-servicio, o una fila stale de un re-provision que creó un
    username nuevo en vez de reusar el viejo) sólo aporta el precio del GANADOR del desempate al MRR
    contratado — el resto de sus servicios reales quedan invisibles al bridge, subvaluando el MRR de ese
    contrato. Mismo criterio de desempate en ambos adapters (fix 🟡3 lo hizo determinístico, no lo hizo
    "sumar todos"). No arreglado: sumar todos los `PppoeService` de un contrato activo cambiaría la semántica
    de "un contrato = un plan" que el resto del bridge asume, y requiere una decisión de producto sobre qué
    significa el MRR de un contrato multi-servicio.
  - **Deriva de artefactos corregida esta ronda (sin cambio de comportamiento, sólo de documentación)**:
    spec.md, Requirement "Contract-modification listing reuses..." ahora aclara explícitamente que aplica a
    los CONTADORES kbps-based, no a `mrrUpgradeArs`/`mrrDowngradeArs` (price-sign, a propósito — ver Decision
    1b arriba); la deuda **(j)** de este mismo documento ("el hueco del contrato nunca-modificado sigue
    abierto") describía un estado PRE-fix-wave-2 — la Decision 1b (`PppoeService.profile` + fix-wave-2) ya lo
    resolvió, y **(j)** en sí queda como registro histórico de la deuda original, no como estado actual; la
    tabla de Use Cases (`BuildFinanceMonthlySnapshot`) ahora incluye `PppoeServiceRepository`, que faltaba
    pese a estar inyectado desde fix-wave-2.

- **fix-wave-4 (2026-07-27) — Fase 4, re-review CON ARITMÉTICA VERIFICADA (escenarios ejecutados contra el
  código real, la Fase 4 completa): 4 🔴 + 9 🟡, TODOS corregidos esta ronda + los 🔵 baratos (14, 14b, 15, 16,
  17) — ver abajo (🔵18 y el passthrough `pppoe:read`) lo que queda documentado como deuda:**

  - **🔴 1 — `realSeriesTruncatedAt` no podía describir un hueco no-contiguo.** Medido: `base=2026-03`,
    `from=2026-01`, `to=2026-06`, IPC cargado sólo en 2026-03/04 ⇒ el conjunto de meses con valor real era
    `{02, 03, 04}` (NO contiguo desde el inicio del rango), con `{01, 05, 06}` sin valor —
    `truncatedAt: "2026-01"` (la convención de reporte de un hueco backward) escondía que 02/03/04 SÍ tenían
    valor. **Decisión tomada: reemplazar por `realSeriesMissingMonths: string[]`** (opción (a) del fix wave,
    no la (b) de dejarlo como campo informativo) — un solo marcador NUNCA puede describir más de un corte, y
    la lista es tan barata de construir como el marcador (`allMonths.filter(m => !chainedIndexByMonth.has(m))`,
    ver `GetFinanceOverview.execute`). `buildChainedIndex` se simplificó en el proceso: ya NO calcula ni
    devuelve ningún marcador de truncamiento — el `Map` de índices encadenados es la única fuente de verdad,
    y el llamador deriva la ausencia directamente de sus keys. Esto también cierra 🟡13 gratis: un hueco
    cronológicamente ANTERIOR a `from` (necesario sólo para encadenar `base`→`from`) ya no podía "filtrarse"
    como una coordenada fuera de rango, porque `realSeriesMissingMonths` sólo enumera meses de `[from, to]` —
    nunca de fuera. Contrato **BREAKING**: `realSeriesTruncatedAt: string | null` → `realSeriesMissingMonths:
    string[]` en `GET /overview`.
  - **🔴 2 — `GET /cac` devolvía `altasDelMes: []` para altas REALES con `technology: null`, sin ninguna
    señal.** `Contract.technology` es `null` para la MAYORÍA de los contratos derivados de GR (documentado en
    `ContractRepository.findFinanceDetailsByIds`) — la comparación estricta `!== canonicalName` las excluía
    en silencio de TODAS las tecnologías. Medido: 5 altas reales de marzo, cash cobrado, costo configurado ⇒
    `{"cacArs":30000,"altasDelMes":[]}`, leído como "cero ventas" cuando la verdad es "5 ventas sin
    clasificar". **Fix**: campo nuevo `altasDelMesSinTecnologia: number` (cuenta las altas del mes, dedupeadas
    por contrato, cuyo `technology` es `null` — nunca las de OTRA tecnología, esas están correctamente
    excluidas). **Y 🟡6 en el mismo fix**: el match de tecnología era case-SENSITIVE mientras
    `ContractTechnologyRepository.getByName` (que resuelve `canonicalName`) ya es case-insensitive —
    `"fibra"` contra catálogo `"Fibra"` se tragaba la venta en silencio; normalizado con `.toLowerCase()` en
    ambos lados de la comparación. Contrato **BREAKING (campo agregado)**: `altasDelMesSinTecnologia: number`
    nuevo en `GET /cac`.
  - **🔴 3 — `GET /motivos-baja` colapsaba a `$0` en todas las filas en el estado real de prod.**
    `FinancePlanPrice` vacía (387/387 contratos sin precio, medido) ⇒ 3 bajas "Precio" + 10 "Mudanza" salían
    ambas en `mrrPerdidoArs: 0`, el orden DESC colapsaba a orden de inserción, y la razón de ser del endpoint
    (rankear por plata, no por cantidad) desaparecía sin señal — el docblock afirmaba "same honesty rule as
    `unpricedContractsActive`" pero ese SÍ es un campo expuesto y acá no había ninguno. **Fix**: campo nuevo
    `bajasSinPrecio: number` POR MOTIVO (no sólo un total global) — se eligió per-row porque permite ver, para
    CADA motivo del ranking, si su `mrrPerdidoArs` es confiable o no; un total global solo no distinguiría
    cuál de los N motivos está más afectado. Contrato **BREAKING (campo agregado)**: `bajasSinPrecio: number`
    nuevo en cada fila de `motivos` de `GET /motivos-baja`.
  - **🔴 4 — la ventana de "churn temprano" se medía desde el 1° del mes calendario de la alta, no desde la
    alta misma.** `RankEarlyChurnByVendor` computaba `cutoff = yearMonthToDateRange(addMonthsToYearMonth(
    arYearMonth(altaDate), windowMonths)).start` — flooreaba la alta a su MES antes de sumar meses, perdiendo
    hasta 30 días de ventana según el día del mes de la alta. Medido: alta `2026-01-31`, baja 160 días
    después (`2026-07-10`) — DENTRO de los 6 meses reales desde el día 31 (cutoff real `2026-07-31`), pero
    FUERA del cutoff buggeado (`2026-07-01`) ⇒ `earlyChurnPct: 0` cuando debía contar. Subestimaba
    sistemáticamente el churn temprano, pegando más fuerte en vendedores que cierran a fin de mes — justo los
    que la métrica existe para exponer. **Fix**: función nueva `addCalendarMonthsToDate` (`financeDates.ts`) —
    suma meses calendario sobre la fecha REAL (con clamp de día en transición largo→corto mes, mismo criterio
    que `IngestGestionRealOrders.monthsBack` pero forward + UTC), usada directamente sobre `new
    Date(alta.createdAt)`. Sin cambio de forma en el contrato (el bug era puramente de cálculo).

  **🟡 de la misma tanda (agregan campos al contrato, corregidos junto con los 🔴 para no dejar una segunda
  ronda de drift):**
  - **🟡 5 — altas inmaduras contaban como "0% churn" y diluían el denominador.** Medido: 10 altas maduras (5
    churnearon = 50% real) + 10 altas de la semana pasada (ninguna tuvo tiempo de churnear) ⇒ el denominador
    `altasTotal: 20` reportaba `earlyChurnPct: 25`, hundiendo en el ranking al vendedor cuyas ventas más
    recientes simplemente no maduraron aún. **Decisión: `altasMaduras` como DENOMINADOR** (no sólo expuesto
    para que el FE decida) — "maduro" = la ventana ya cerró (`now >= cutoffInstant`) O el veredicto ya está
    sellado porque churneó temprano (un churn ya observado es definitivo, sin importar si el resto de la
    ventana técnicamente no transcurrió). Se justifica encadenar el DENOMINADOR (no sólo exponer el dato)
    porque el mismo principio de "nunca adivinar" que gobierna `GetFinanceCohorts` (null cuando la cohorte
    no llegó a esa edad) aplica acá: una tasa calculada sobre datos que todavía no pueden tener un veredicto
    es una tasa inventada, no una tasa real con ruido. Cuando `altasMaduras: 0`, `earlyChurnPct` es `null`
    (nunca un `0%` adivinado). Contrato **BREAKING**: `altasMaduras: number` nuevo, `earlyChurnPct: number` →
    `number | null` en `GET /vendors/early-churn`.
  - **🟡 6 — ver 🔴2 (case-insensitive del filtro de tecnología), cerrado en el mismo fix.**
  - **🟡 7 — `costConfigured: true` no distinguía "cargado" de "fila de ceros".** Las 3 columnas de
    `FinanceTechnologyCost` son `@default(0)` — una fila creada y nunca completada es indistinguible de una
    tecnología genuinamente gratuita. **Decisión: campo nuevo `costIsZero: boolean`** (`true` sólo cuando
    `costConfigured` es `true` Y `cacArs === 0`) — se prefirió a la alternativa de redefinir `costConfigured`
    (que hubiera roto la semántica ya establecida "existe una fila o no") porque agregar un campo nuevo deja
    el contrato existente intacto y el FE decide libremente cómo combinarlos (`costConfigured && costIsZero`
    = "cargado pero en cero, revisar"; `!costConfigured` = "nunca cargado"). Contrato **BREAKING (campo
    agregado)**: `costIsZero: boolean` nuevo en `GET /cac`.
  - **🟡 8 — `activated` + `reactivated` del mismo contrato se contaban DOS VECES** en
    `RankEarlyChurnByVendor` y `RankNetGrowthByNode` (`ComputeCacAndPayback` YA deduplicaba explícitamente
    por este caso desde su fix-wave original) — el mismo mes podía mostrar N altas en `/cac` y N+k en
    `/vendors/early-churn`/`/nodes/growth`. **Fix**: mismo criterio de dedup (Set por `contractId`, quedándose
    con el evento cronológicamente más temprano) replicado en los 3 use cases. Sin cambio de forma (el bug
    era de conteo, no de campos).
  - **🟡 9 — `GET /cohorts` devolvía el `[]` mudo que `/overview` ya había aprendido a no devolver.** Estado
    real de prod: el backfill de `FinanceCohortSnapshot` nunca corrió. **Fix**: campo nuevo
    `monthsWithoutCohortSnapshot: string[]`, mismo patrón que `monthsWithoutSnapshot` de `/overview` — un mes
    ausente de `cohorts` Y presente en esta lista significa "nunca computado"; un mes ausente de esta lista
    pero con `originalCount: 0` significa "computado, cero altas ese mes". Contrato **BREAKING (campo
    agregado)**: `monthsWithoutCohortSnapshot: string[]` nuevo en `GET /cohorts`.
  - **🟡 10 — `/motivos-baja` no normalizaba el motivo.** `"Contrato"`/`"  Contrato  "` y `"Precio"`/`"precio"`
    (texto libre de GR, sin vocabulario fijo) armaban filas separadas, partiendo la plata perdida entre ellas.
    **Fix**: agrupado por una clave `trim().toLowerCase()`, conservando el PRIMER casing visto como valor de
    display (nunca reescribe lo que el operador tipeó, sólo deja de tratar espacios/casing como motivos
    distintos). De paso, `.trim()` ANTES del fallback `||` — un `motivoBaja: "   "` (no-vacío, truthy bajo
    `||` solo) pasaba sin caer al siguiente eslabón de la cadena.
  - **🟡 11 — el `||` del vendedor no manejaba whitespace-only.** Mismo patrón que 🟡10 pero en
    `RankEarlyChurnByVendor`: `vendedor: "   "` armaba su propio bucket en vez de agrupar bajo "sin vendedor".
    **Fix**: `.trim()` antes del `||`.
  - **🟡 12 — `monthlyRatePct <= -100` rompía la matemática encadenada.** Verificado escribiendo y leyendo:
    `-100` ⇒ `chainedIndex = 0` ⇒ `mrrFinalRealArs: Infinity`, que sobrevivía en la respuesta SÓLO porque
    `JSON.stringify(Infinity) === "null"` — el tipo `number | null` del DTO es una mentira en runtime para
    cualquier consumidor que no sea `res.json` (un export CSV futuro, por ejemplo). `-150` invertía el signo
    de toda la cadena. **Fix**: guard de una línea en `UpdateFinanceInflationIndex` — rechaza `<= -100`.

  **🔵 baratos, corregidos esta ronda (no cambian la forma del contrato salvo donde se indica):**
  - **🔵 14 — el test "4.12/4.13" de `RankEarlyChurnByVendor` era tautológico.** El fixture (A: 50 altas/60%
    vs B: 20 altas/5%) hacía que A ganara por CUALQUIERA de los dos criterios (volumen O tasa) — no
    discriminaba el bug que decía cubrir. **Fix**: reescrito con el caso discriminante confirmado por la
    review (A: 10 altas/80% vs B: 50 altas/10% — A gana por tasa a pesar de tener 5x menos altas).
  - **🔵 14b — cobertura de contrato en los tests de ruta.** `/vendors/early-churn`, `/nodes/growth` y
    `/motivos-baja` sólo tenían tests de wire con respuesta VACÍA (`[]`) — el shape de las FILAS (lo que la
    Fase 5 va a tipar) nunca se asertaba sobre HTTP. **Fix**: un test no-vacío por endpoint, `toEqual` exacto
    sobre la fila completa. También: el test de `/overview` fijaba `churnRevenuePct: 0` (un valor que un `??
    0` hubiera dejado pasar igual) — agregado un test dedicado que siembra `null` explícito y verifica que
    sobrevive a la respuesta HTTP sin coerción.
  - **🔵 15 — `maxPaybackMonths: 0` no tenía guard de `>= 1`.** Un payback de 0 meses no es un valor de
    negocio real — degenera el cutoff de "temprano" a la fecha exacta de la alta (ventana vacía) y el umbral
    de `lossMaking` a "cualquier payback es pérdida". **Fix**: `UpdateFinanceTargets` ahora exige `>= 1`
    (antes `>= 0`).
  - **🔵 16 — empates sin desempate determinístico en los 3 rankings.** `Array.sort` sobre un `Map` iterado
    con valores empatados (`earlyChurnPct`, `netGrowth`, `mrrPerdidoArs`) no garantiza el mismo orden entre
    corridas. **Fix**: desempate secundario determinístico en los 3 (ASC por `vendedor`/`networkSiteId`
    — nulls al final —/`motivo`, según corresponda).
  - **🔵 17 — sin límite de ancho de rango (`1990-01..2026-12` ⇒ 444 meses).** **Fix**: `assertYearMonthRangeWidth`
    (`financeDates.ts`, cap de 240 meses/20 años — mismo cap que `BackfillFinanceMonthlySnapshots` ya usa para
    su propio rango) aplicado a los 5 endpoints de lectura (`/overview`, `/cohorts`, `/vendors/early-churn`,
    `/nodes/growth`, `/motivos-baja`).

  **Documentado, NO arreglado esta ronda (deuda de bajo riesgo o requiere una decisión de producto):**
  - **🔵 18 — una cohorte con `originalCount: 0` reporta `pct: 0`** en vez de `null` (división por cero
    evitada, pero el "0%" es indistinguible de una cohorte real con 0% de supervivencia). No arreglado:
    requeriría volver `CohortSurvivalPoint.pct` nullable, un cambio de forma adicional que esta ronda no
    forzó porque el caso (`originalCount: 0` con el mes SÍ computado) es un edge case sin evidencia de
    ocurrir en prod — una cohorte mensual sin ninguna alta es infrecuente pero no imposible; se deja
    documentado para que la Fase 5 decida si vale la pena el cambio de forma.
  - **`GET /api/pppoe/activation-history` (passthrough de `/contract-changes`) monta bajo el guard
    `pppoe:read`, NO `finance:read`.** Confirmado en esta ronda — un usuario con `finance:read` pero SIN
    `pppoe:read` come `403` en ese endpoint específico, la única excepción a "los 6 endpoints de finance-growth
    usan el guard `finance:*`". Documentado para que la Fase 5 lo sepa ANTES de tipar el cliente HTTP
    (necesita manejar el `403` de ese endpoint como un caso separado, o la Fase 5/6 debe decidir si agregar
    `finance:read` como guard alternativo ahí — decisión de producto, no de esta fix wave).
