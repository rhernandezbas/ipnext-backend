# Proposal: Finance Growth Dashboard

## Intent

Hoy no existe forma de responder "¿estamos creciendo de verdad o solo facturando más pesos por inflación?".
El sidebar "Finanzas" (Dashboard/Transacciones/Facturas/Notas de crédito/Facturas proforma/Pagos/Historial y
Vista Previa/Payment statements/Dunning/Planes de pago) es herencia MUERTA de Splynx — confirmado por el
usuario que NO se usa — y no hay ninguna vista de altas/bajas, churn, ni de costo de venta/instalación.

Esto **NO es "un dashboard con gráficos"**: es la construcción de **unit economics de un ISP** — bridge de
MRR, churn de contratos vs. de ingresos, CAC/payback por tecnología, cohortes de retención, y el hallazgo de
más valor: churn temprano por vendedor (expone comisión+instalación pagada sobre un cliente que se cae a los
2 meses). Va como **sección PROPIA** nueva en el sidebar, no adentro del cementerio Finanzas.

La verdad contable son los **recibos de cobranza de Gestión Real (GR)** — no un catálogo de precios de lista
ni la facturación emitida (que GR no expone, ver abajo) — porque son la plata que REALMENTE entró, con
descuentos y precios especiales reales incluidos. El problema es que hoy no existe ningún mirror histórico de
cobranza en el sistema (ver Approach → Fase 1), así que antes de mostrar un solo gráfico hay que construirlo.

**Pivot verificado en vivo (2026-07-26)**: la exploración original asumía que extender el sync per-client de
`Invoice` a todos los estados GR alcanzaba como fundación de datos. Una verificación EN VIVO contra la API real
de GR invalidó esa premisa y cambia la métrica base del change — ver "Hallazgos verificados en vivo" más abajo
y Decision 0 en `design.md`. En síntesis: **no existe un endpoint de facturación emitida en GR** (17 nombres de
action probados, todos inexistentes), así que la métrica base de este change es la **COBRANZA REAL** (cash
collected) reconstruida desde el action `recibos`, no la facturación. Esto se documenta explícitamente como
decisión y como limitación: cobranza ≠ facturación, el timing del pago puede desfasar un mes contra otro.

## Scope

### In Scope
- **Fase 1 (fundación de datos, parte de ESTE change, no un change aparte) — REESCRITA tras verificación en
  vivo (2026-07-26)**: `cuentas.invoices[]` (el endpoint per-client que alimenta `Invoice`) resultó ser SOLO
  deuda abierta — un cliente al día devuelve CERO facturas (medido: 6/6 activos con `invoices=0`) — así que
  iterar los 5.327 clientes activos no aporta nada. La fundación de datos pasa a ser el **ingest global
  incremental del action `recibos`** por rango de fechas (`DD-MM-AAAA` obligatorio — GR responde HTTP 500 con
  ISO), paginado por `offset`, **repensado como GOTEO CONTINUO de todo el día** (decisión LOCK del usuario,
  2026-07-26 — ver `design.md` Decision 4): un presupuesto de requests ÚNICO y COMPARTIDO entre dos carriles
  con prioridad —el carril DELTA (recibos recientes, prioridad ABSOLUTA, cadencia de minutos) y el carril
  BACKFILL (histórico, camina newest→oldest desde el mes actual hasta el piso configurable, una página GR por
  turno, SOLO cuando el delta no tiene trabajo pendiente)—, nunca el batch nocturno de "N meses por corrida"
  de la versión anterior de este plan (163 meses de historia a 1 mes/noche eran ~5,4 MESES de calendario;
  medido en vivo: el backfill completo son solo ~7.172 requests en total, ~44/mes de historia). Ambos
  carriles son resumibles vía el `SyncStateRepository` ya existente (molde
  `SyncGestionRealContractsDelta`/`ArmGrContractsBackfill`/`BackfillGrContractsBatch` — sin puerto nuevo), con
  throttle adaptativo (backoff/recuperación automática) reusando el retry-on-5xx de `GestionRealClient`.
  Cada recibo trae `aplicaciones[]` (a qué comprobante se aplicó la plata; identidad `{tipo}-{sucursal}-
  {numero}`, EXACTAMENTE `Invoice.grInvoiceId`) — se persisten recibos + aplicaciones, se excluyen los
  recibos con anulación real (`fecha_anulacion` ≠ centinela `"00-00-0000 00:00:00"`), y se normalizan los
  nodos GR que son dict keyed-by-id (mismo criterio que `parseServiceOrdersResponse`/`clientesObj` ya
  existentes en `GestionRealClient.ts`). El sync per-client `RefreshDebtorBalances` SOBREVIVE sin reescritura
  de fondo: solo se le agrega el estado `4` (Incobrable) a `DEBTOR_LIKE_STATUSES` (hoy `2,3,6`) — sigue
  cubriendo el conjunto CHICO de deudores/inactivos/incobrables/bajas (75 deudores medidos, no miles) para las
  facturas IMPAGAS, que es justo lo único que ese endpoint puede dar.
- **Métrica base = COBRANZA REAL (cash collected), no facturación emitida.** No existe endpoint de
  facturación/comprobantes emitidos en GR (17 nombres de action probados en vivo, todos inexistentes:
  `ventas`, `facturas`, `facturacion`, `libro_iva`, `cuenta_corriente`, etc.). Se documenta como decisión Y
  como limitación explícita: cobranza ≠ facturación emitida, el timing del pago desfasa un mes contra otro
  (ej. una factura de junio cobrada en julio cuenta como cobranza de julio).
- Catálogo de clasificación de tipos de comprobante GR (`grType`) en revenue/contra/excluido, para netear
  notas de crédito sin asumir el vocabulario completo — ahora poblado desde `FinanceReceiptApplication.grType`
  (cada aplicación de recibo trae su propio `tipo`); verificado en vivo con al menos 4 códigos reales:
  `FB`(mayoría), `FA`, `FX`, `ID`.
- Modelo de **dos capas** de atribución cobranza-cliente → MRR-contrato (ver `design.md` — es la decisión de
  arquitectura más importante del change).
- Configuración editable: costo de venta, costo de instalación y costo mensual de servicio **por tecnología**;
  precio estimado **por plan** (para atribución multi-contrato y simulación de CAC); metas (churn objetivo,
  payback máximo, meta de altas del mes); índice IPC mensual cargable a mano.
- Motor de métricas: bridge de MRR, churn (contratos + ingresos), cohortes de retención 3/6/12 meses, CAC +
  payback con alerta de venta a pérdida, ranking de churn temprano por vendedor, crecimiento neto por
  nodo/AP, ranking de motivos de baja por plata perdida, listado de modificaciones de contrato (reusa
  `ListInternetServiceHistory`, no se reinventa la derivación de dirección).
- Snapshots mensuales precomputados (job nocturno) para que el panel no recalcule agregados sobre toda la
  historia en cada request.
- Permisos granulares nuevos, módulo RBAC `finance` (deliberadamente separado de `billing`, que sigue siendo
  el módulo del cementerio Splynx).
- FE: sección nueva, settings de los valores configurables, gráficos con los tokens del design system.

### Out of Scope
- **Facturación emitida (accrual)**: no existe endpoint GR para reconstruirla (verificado en vivo, 17 nombres
  probados) — queda fuera de alcance por imposibilidad técnica, no por elección. Ver limitación documentada
  arriba y en `design.md` Decision 0.
- Persistir `items[]` del recibo (medios de pago detallados: transferencia/caja/destino) — la dimensión de
  canal de cobro ya sale gratis del campo `recaudador` a nivel de recibo; modelar cada medio de pago no agrega
  valor a las métricas de este change y se puede agregar después sin tocar el motor (extensión documentada).
- Reescribir o revivir cualquiera de las páginas Splynx del sidebar Finanzas (`billing.*`).
- Migrar/deprecar `ServicePlan` (tabla legacy de tarifas Splynx) — se documenta como no-fuente, no se toca.
- **Costo de instalación REAL** derivado de `ContractInstalledItem` + inventario (EPIC #38) — el diseño deja
  la puerta abierta (campo de extensión documentado en `design.md`), pero Fase 1-5 usan el costo ESTIMADO
  configurable, no el consumo real de materiales.
- Cruce automático con `noc-alerts-hub` (nodo con más churn vs. nodo con más alertas) — el diseño no lo
  cierra, pero no se implementa en este change.
- Cualquier escritura hacia GR (todo este change es de LECTURA de facturas/contratos; el alta/baja real sigue
  pasando por los flujos existentes).
- Reemplazar la fuente GR por otra cosa — sí se **aísla detrás de un port** (deuda declarada abajo) para que
  ese reemplazo futuro sea posible sin tocar el motor de métricas.

## Capabilities

### New Capabilities
- `finance-growth`: bridge de MRR, churn (contratos/ingresos), cohortes, CAC/payback, ranking vendedor/motivo
  de baja, crecimiento por nodo, configuración de costos/metas/inflación, sync completo de facturas GR.
  (Fases 1-5, ver Approach.)

### Modified Capabilities
None a nivel de spec vigente. Se agrega el módulo RBAC `finance` (nuevo, no modifica el catálogo de
`billing`/`monitoring`/etc.) y se **extiende** — sin cambiar su contrato — el comportamiento de refresco de
balances (Fase 1 generaliza el estado que hoy solo cubre deudores).

## Approach — Fases (orden = dependencia de datos, no valor cosmético)

| Fase | Entrega | Depende de |
|------|---------|-----------|
| **1 — Ingest global de cobranza (recibos GR)** | Goteo continuo todo el día: presupuesto de requests COMPARTIDO entre carril delta (reciente, prioridad absoluta, cadencia de minutos) y carril backfill (histórico newest→oldest, 1 página GR/turno hasta el piso configurable), ambos resumibles con throttle adaptativo; persiste `FinancePaymentReceipt` + `FinanceReceiptApplication`; extiende `RefreshDebtorBalances.DEBTOR_LIKE_STATUSES` con `4` (Incobrable); catálogo de clasificación `grType` (auto-alta `unclassified` sobre `FinanceReceiptApplication.grType`); config singleton de pacing/piso de backfill. | Ninguna |
| **2 — Configuración (settables)** | `FinanceTechnologyCost` (fila por tecnología), `FinancePlanPrice` (fila por plan), `FinanceTargetsConfig` (singleton: churn objetivo, payback máx, meta de altas, mes base IPC), `FinanceInflationIndex` (fila por mes). CRUD + RBAC `finance.*`. | Ninguna (paralelizable con Fase 1) |
| **3 — Motor de métricas** | Job nocturno que computa `FinanceMonthlySnapshot` (bridge, ARPU, nominal/real, churn) y `FinanceCohortSnapshot` (retención 3/6/12) a partir de `FinanceReceiptApplication` (cobranza neteada) + `ContractServiceEvent` + Fase 2. | 1, 2 |
| **4 — API de lectura** | Endpoints de overview/cohortes/CAC/ranking vendedor/crecimiento por nodo/motivos de baja, todos `finance.read`. Reusa `ListInternetServiceHistory` para modificaciones de contrato (sin duplicar). | 3 |
| **5 — FE** | Sección propia en el sidebar (fuera del cementerio Finanzas), pantallas de settings para lo configurable, dashboard con gráficos (tokens del design system, 4 estados, a11y). | 4 |

Fase 6 (deferred, **no en este change**): costo de instalación real desde `ContractInstalledItem` +
inventario — el modelo de Fase 2 deja el campo de extensión documentado.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | 10 modelos nuevos aditivos (ver `design.md` — Data Model): `FinanceInvoiceTypeClassification`, `FinanceReceiptSyncConfig`, `FinancePaymentReceipt`, `FinanceReceiptApplication`, `FinanceTechnologyCost`, `FinancePlanPrice`, `FinanceTargetsConfig`, `FinanceInflationIndex`, `FinanceMonthlySnapshot`, `FinanceCohortSnapshot`. NO toca `Invoice`/`Contract`/`ContractServiceEvent` (ver design Decision 0b — por qué `Invoice` queda intocado). |
| `src/application/use-cases/` | New | `SyncGrReceiptsBackfillBatch`/`SyncGrReceiptsDelta` (Fase 1, nuevos), CRUD de config (Fase 2), `BuildFinanceMonthlySnapshot`/`BuildFinanceCohortSnapshot` (Fase 3), queries de lectura (Fase 4). |
| `src/application/use-cases/RefreshDebtorBalances.ts` | Modified | Fase 1: `DEBTOR_LIKE_STATUSES` pasa de `['2','3','6']` a `['2','3','4','6']`. Única modificación a un use case existente en todo el change. |
| `src/domain/ports/` | New | `GestionRealPort.fetchReceipts(...)` (método nuevo en el port existente, no un port nuevo) + repos de los 9 modelos nuevos restantes; ninguno reemplaza `GestionRealPort`. |
| `src/infrastructure/adapters/{prisma,in-memory}/` | New | `Prisma{Entity}Repository`/`InMemory{Entity}Repository` por cada modelo nuevo. |
| `src/infrastructure/scheduling/` | New | `FinanceReceiptIngestScheduler.ts` + `bootstrapFinanceReceiptsIngest.ts` (molde `GestionRealSyncScheduler`/`bootstrapGestionRealSync.ts` — UN solo scheduler arbitra los carriles delta/backfill con presupuesto compartido, Decision 4b de `design.md`), `bootstrapFinanceSnapshotJob.ts`. |
| `src/infrastructure/http/app.ts` | Modified | Wiring de 2 routers nuevos + 2 jobs (ingest scheduler + snapshot nocturno); composition-root test nuevo (molde `inventory-composition-root.test.ts`). |
| `src/domain/entities/rbac.ts` | Modified | Módulo `finance` + acciones `manage_costs`/`manage_targets`/`manage_inflation` en `KNOWN_ACTIONS`/`RBAC_MODULES`. Aditivo, no reordena ni renombra nada existente. |
| `ipnext-frontend` | New | Sección propia, hooks, settings, gráficos. NO se toca el módulo Finanzas Splynx existente. |

**Splynx**: este change NO agrega dependencias de Splynx ni de `ServicePlan` (tabla legacy de tarifas).

## Deuda declarada

1. **Aislamiento del ingest de GR (gotcha obligatorio)**: el motor de métricas (Fases 3-4) lee EXCLUSIVAMENTE
   de tablas locales (`FinancePaymentReceipt`, `FinanceReceiptApplication`, `Contract`, `ContractServiceEvent`,
   los modelos de Fase 2/3) — nunca de `GestionRealPort` directamente. Solo `SyncGrReceiptsBackfillBatch`,
   `SyncGrReceiptsDelta` (Fase 1, nuevos) y `RefreshDebtorBalances` (existente, extendido) conocen GR. El día
   que GR se reemplace, se reescribe SOLO el ingest (detrás del port existente `GestionRealPort`); el motor de
   métricas no se toca. Se declara explícitamente para que nadie, en una fase futura, meta un `fetchClientBalance`/
   `fetchReceipts` dentro de un use case de métricas "para no esperar al sync".
2. **`FinanceTechnologyCost`/`FinancePlanPrice` usan clave natural (nombre/código), no FK dura** — mismo
   criterio que `Contract.technology` (free-text, no FK a `ContractTechnology`). Si una tecnología se
   renombra en `ContractTechnology`, el costo configurado para el nombre viejo queda huérfano (no se
   migra solo). Riesgo bajo (renombrar una tecnología es un evento raro) — documentado, no bloqueante.
3. **Atribución multi-contrato es una ESTIMACIÓN, nunca una verdad contable** — se expone el `%` de MRR
   atribuible en cada snapshot en vez de disimular el número. Ver `design.md` Decision 1.
4. **Snapshots nocturnos, no tiempo real** — el bridge/cohortes/nominal-real se actualizan una vez por noche;
   el panel siempre muestra "as of" la última corrida. Aceptable para un dashboard de gestión mensual: nadie
   necesita el churn de HACE 3 minutos.
5. **Cobranza ≠ facturación emitida (limitación estructural, no un bug)** — GR no expone facturación emitida
   (verificado en vivo, 17 nombres probados). Toda métrica de "revenue"/MRR de este change es CASH COLLECTED,
   nunca accrual. El desfasaje de timing (una factura de junio cobrada en julio cuenta en julio) es aceptado y
   documentado; no se intenta reconstruir el momento de emisión.
6. **`FinanceReceiptApplication.grInvoiceId` y `Invoice.grInvoiceId` comparten la misma clave natural
   (`{tipo}-{sucursal}-{numero}`) sin FK entre tablas** — es la misma decisión de `gr-invoices-sync` (clave
   natural, no FK dura), extendida a un segundo consumidor. Si GR cambiara esa composición de identidad algún
   día, ambos lados quedan huérfanos simultáneamente; riesgo compartido, no nuevo, no bloqueante.
7. **Un recibo anulado DESPUÉS de haber sido ingestado por el backfill no se re-visita automáticamente** — el
   backfill pagina hacia atrás una página por turno y avanza de mes una sola vez que lo completa; si GR marca
   una anulación semanas después sobre un recibo de un mes ya backfilleado, el dato queda desactualizado hasta
   un re-run manual de ese mes. En la muestra verificada (100 recibos), 0 anulados — riesgo bajo, mitigación:
   re-run manual acotado por mes si se detecta drift (no requiere re-arrastrar todo el histórico).

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| ~~BLOQUEANTE — alcance real de `cuentas.invoices[]`~~ **RESUELTO en vivo (2026-07-26)**: es SOLO deuda abierta, cero facturas para clientes al día. Ya no es un riesgo — cambió el diseño de Fase 1 (ver Decision 0, `design.md`) en vez de mitigarse. | — | N/A — resuelto por rediseño, no por spike. |
| ~~BLOQUEANTE — vocabulario real de `grType`~~ **RESUELTO en vivo (2026-07-26)**: se observaron 4 códigos (`FB`,`FA`,`FX`,`ID`) en 100 recibos reales, confirmando que el catálogo de filas auto-completable era la decisión correcta (no hay lista cerrada). | — | Ya mitigado por diseño (`FinanceInvoiceTypeClassification`), sin cambios. |
| ~~Duración del backfill histórico~~ **REDUCIDA drásticamente por el rediseño de pacing (2026-07-26)**: con el modelo anterior (1 mes/corrida nocturna) hubiera sido ~5,4 meses de calendario para 163 meses de historia; con el goteo continuo (default `requestIntervalMs=20000` → ~1 req/20s) el backfill completo (medido: ~7.172 requests totales, ~44/mes) termina en **~1,7-2 días** de calendario, compitiendo por el presupuesto compartido con el carril delta (que le gana la prioridad, pero consume una fracción chica del presupuesto — ver `design.md` Decision 4b). | Bajo | El carril delta corre en PARALELO desde el minuto 1 con prioridad absoluta (no depende del backfill) — los meses recientes están al día en minutos; Fase 3 solo exige 3 meses consecutivos para su success criteria, alcanzable en horas, no meses. El ritmo (`requestIntervalMs`) es configurable si hace falta acelerar o ser más conservador con GR. |
| Volumen del ingest de recibos (~58k/año, cientos de miles históricos) puede generar muchas llamadas GR paginadas por `offset` (100/página) durante el backfill | Medio | Reusa el retry/backoff ya existente en `GestionRealClient`; paceo configurable (`FinanceReceiptSyncConfig`); resumible por diseño (molde `BackfillGrContractsBatch`/`ArmGrContractsBackfill`) — un crash a mitad de mes retoma esa página, no reprocesa desde cero. |
| **Recibo anulado después de ser backfillado** no se re-visita automáticamente (deuda #7) | Bajo (0 anulados en la muestra verificada) | Re-run manual acotado por mes si se detecta drift; no bloqueante. |
| **Forma exacta del nodo raíz de `recibos`** (dict keyed-by-id como `items`/`aplicaciones`, o array plano) no se confirmó explícitamente en la verificación en vivo del addendum | Bajo — NO-BLOQUEANTE | El parser se escribe defensivo para ambos casos desde el día 1 (mismo criterio que `parseServiceOrdersResponse`/`clientesObj`, ya probado en el repo); se confirma con el primer sync real de Fase 1 sin bloquear el arranque de la implementación. |
| Snapshots nocturnos = ventana de datos "stale" durante el día si alguien edita un costo/meta | Bajo | Documentado como comportamiento esperado (deuda #4); el settings screen puede mostrar "próxima recomputación: <hora del job>". |
| Inflación: mes sin IPC cargado rompe la cadena de deflactación | Medio | Diseño explícito de "fail loud": la serie REAL se trunca en el primer mes faltante y el payload devuelve `realSeriesTruncatedAt`, nunca interpola en silencio (ver `design.md` Decision 3). |
| RBAC: nuevo módulo `finance` puede confundirse con `billing` en la UI de gestión de permisos | Bajo | Label explícito "Finanzas — Crecimiento" en el catálogo (`RbacModule.label`), distinto de "Facturación" (`billing`). |

## Rollback Plan

- Todas las migraciones son aditivas (7 tablas nuevas, 0 columnas nuevas en tablas existentes) → rollback =
  `down` que dropea las tablas nuevas.
- Los 2 jobs nocturnos (sync Fase 1, snapshot Fase 3) están detrás de su propio config singleton — apagarlos
  (`enabled=false` o desmontar el bootstrap) no afecta ningún flujo existente (GR, PPPoE, tickets, etc.).
- Los 2 routers nuevos (`/api/finance/growth/*`) se desmontan sin tocar `app.ts` fuera de esas líneas.
- FE: la sección nueva es un ítem de sidebar aparte; ocultarlo detrás de `finance.read` ausente lo apaga sin
  tocar el resto de la navegación.

## Success Criteria

- [ ] Fase 1: el backfill de recibos avanza de forma resumible (sobrevive un restart a mitad de página) y
  camina newest→oldest; el carril delta corre con cadencia de minutos y tiene PRIORIDAD ABSOLUTA sobre el
  backfill en el presupuesto de requests compartido (el backfill cede su turno mientras el delta tiene
  trabajo pendiente); el ritmo se degrada automáticamente ante fallas de GR y se recupera solo;
  `RefreshDebtorBalances` cubre también estado `4` (Incobrable); un `grType` de aplicación nunca visto se
  auto-alta como `unclassified` sin romper el sync; ningún recibo con anulación real se persiste.
- [ ] Fase 2: costo por tecnología, precio por plan, metas y al menos 1 mes de IPC son editables desde la UI
  y persisten; RBAC bloquea la edición sin `finance.manage_costs`/`manage_targets`/`manage_inflation`.
- [ ] Fase 3: el snapshot mensual reconstruye el bridge de MRR (altas+upgrades−downgrades−bajas = MRR final)
  a partir de COBRANZA real (no facturación emitida) para al menos 3 meses consecutivos con delta al día, y
  expone el `%` de MRR atribuible por contrato.
- [ ] Fase 4: los endpoints de lectura devuelven series nominal y real (deflactada), con `realSeriesTruncatedAt`
  correcto cuando falta un mes de IPC.
- [ ] Fase 5: el ranking de churn temprano por vendedor es visible y distinto del ranking simple de altas
  (el caso que motivó el pedido).
- [ ] Ninguna ruta nueva es accesible sin el permiso `finance:*` correspondiente (verificado en BE, no solo
  oculto en FE).

## Hallazgos verificados en vivo (2026-07-26) — reemplazan las 2 preguntas bloqueantes anteriores

Medido con llamadas reales de solo lectura a `https://api.gestionreal.com.ar/`. Ver
`design.md` Decision 0 para el detalle completo.

1. **`cuentas.invoices[]` es SOLO deuda abierta, no historial** (6 clientes activos → 0 facturas; 5 deudores →
   2-3 facturas recientes). Resuelve la ex-pregunta BLOQUEANTE #1 — la respuesta OBLIGÓ a rediseñar Fase 1
   (ingest de `recibos`) en vez de simplemente confirmarla.
2. **El vocabulario de `grType` tiene al menos 4 códigos reales** (`FB`, `FA`, `FX`, `ID`, en 100 recibos de
   muestra), no solo `FB`. Resuelve la ex-pregunta BLOQUEANTE #2 — confirma (no cambia) que el catálogo de
   filas auto-completable era la decisión correcta desde el principio.
3. **No existe endpoint de facturación emitida** — 17 nombres de action probados, todos error 91 (acción
   inexistente). Consecuencia: la métrica base pasa de facturación a cobranza real (ver Scope arriba).
4. **`cuenta_corriente` y `remitos_venta`, documentados en la skill `gestion-real-ipnext`, NO existen** en la
   API real (error 91 "No Se indicó la Acción"). La doc de la skill está desactualizada en esos dos — es una
   tarea aparte, fuera de este change.

## Preguntas abiertas (para design / confirmación del usuario)

Ninguna queda BLOQUEANTE tras la verificación en vivo. Las 2 preguntas bloqueantes originales se resolvieron
arriba. Quedan solo NO-BLOQUEANTES:

1. **NO-BLOQUEANTE**: el nombre del ítem de sidebar — se usa "Crecimiento Financiero" como placeholder en
   `design.md`/`tasks.md`; el usuario puede preferir otro (ej. "Unit Economics", "Crecimiento").
2. **NO-BLOQUEANTE**: ¿la comisión de venta (% del abono) varía por tecnología (como el resto de los costos)
   o es un único valor global? Este proposal la modela POR TECNOLOGÍA (mismo criterio que costo de venta/
   instalación/servicio) por consistencia, pero es reversible a global en Fase 2 sin tocar Fases 3-5.
3. **NO-BLOQUEANTE**: la forma exacta del nodo raíz de la respuesta de `recibos` (dict keyed-by-id, como
   `items`/`aplicaciones` y como `clientes` en `clientes_consulta`, o array plano) no se confirmó explícitamente
   en la muestra del addendum. El parser se escribe defensivo para ambos casos desde el día 1 (mismo criterio
   que `parseServiceOrdersResponse`) — se confirma con el primer sync real de Fase 1, sin bloquear el diseño
   ni el arranque de la implementación.
