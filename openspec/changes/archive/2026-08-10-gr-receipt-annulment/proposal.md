# Proposal — `gr-receipt-annulment`

## Intent

Que el espejo de recibos de Prominense **converja** a lo que dice Gestión Real, en vez de
quedarse con la foto de un solo instante. Hoy el espejo escribe una vez y no vuelve nunca:
lo que GR publica o modifica después queda afuera **para siempre**.

La card pedía arreglar "el recibo anulado que queda visible". El probe en vivo del
2026-08-10 encontró que **el agujero verdadero es otro y está abierto hoy en producción**:
el cliente que paga por un medio de acreditación lenta **nunca ve su pago** en "Mis pagos".

---

## Problema

### 1. Lo que decía la card — no se pudo confirmar (y eso importa)

La ingesta saltea los recibos anulados en el parser (`GestionRealClient.ts:811`,
`if (isRealAnnulment(...)) continue;`), así que un recibo anulado **después** de haber sido
espejado se queda `anulado = false` en la base y sigue visible.

Se salió a buscar el caso real. **No apareció** (medido, 2026-08-10):

| Sonda | Resultado |
|---|---|
| 2.821 recibos listados en GR (11 días, mayo→agosto) | **0** con `fecha_anulacion` poblada |
| diff de 2.342 recibos espejados contra el listado de GR | **0** desaparecidos del listado |
| espejo `FinancePaymentReceipt`, 2026-05-01 → hoy (17.020 filas) | **0** con `anulado = true` |

El placeholder de "no anulado" es `"00-00-0000 00:00:00"`, siempre.

⇒ **No hay evidencia positiva de anulación disponible hoy.** Las anulaciones son rarísimas,
o GR no las expone por este endpoint. El fix de anulación de este change es **DEFENSIVO**:
si algún día aparece una, cazarla. **No se puede validar contra un caso real** — decisión
consciente, no un descuido. Lo que sí se puede probar es el mecanismo (fixtures + revert
probe), no el fenómeno.

### 2. La causa raíz gorda (medida): el delta pierde los confirmados tarde

**GR publica el recibo recién cuando se CONFIRMA, con `fecha_recibo` retroactiva.**

Día 05-08-2026, contado el 2026-08-10:

```
GR:      299 recibos con fecha_recibo = 05-08
espejo:  197
faltan:  102  (34,1 %)
```

Los 102 faltantes **tienen todos `fecha_confirmacion` posterior**:

| `fecha_confirmacion` | Recibos | Retraso |
|---|---:|---|
| 06-08 | 45 | +1 día |
| 07-08 | 26 | +2 días |
| 08-08 | 31 | +3 días |

Los 197 presentes: **todos confirmados el mismo día**. La correlación es perfecta.

`SyncGrReceiptsDelta` colapsa su cursor a un `fechaHasta` plano cuando termina de paginar
(`SyncGrReceiptsDelta.ts:110-114`), y la corrida siguiente lo lee como `fechaDesde` — es
decir, **re-escanea ~1 día de solapamiento y nunca vuelve a pedir un rango más viejo**. Todo
recibo cuyo clearing tarde más que ese solapamiento (SIRO, PagoFácil, débito automático)
**se pierde del espejo para siempre**. También se detectó 1 faltante del 01-07 (id 345867),
o sea que no es un efecto de un solo día.

Consecuencia HOY, en prod, sin ninguna anulación de por medio:

- **Portal**: `GET /api/portal/payments` no muestra el pago. El cliente que pagó por débito
  automático abre "Mis pagos" y no está.
- **Dashboard de finanzas**: la caja cobrada del mes queda **subcontada** por esos recibos.

### 3. El tercer agujero: el dashboard no filtra `anulado` en absoluto

`PrismaPortalPaymentsReader.ts:46` es el **único** lector que filtra
(`where: { clientGrId, anulado: false }`). El dashboard **no filtra nada**:

| Lector | `WHERE` hoy | Lo consume |
|---|---|---|
| `PrismaFinanceReceiptItemRepository.listByMonth` | `receipt: { fechaRecibo: {gte, lt} }` | `BuildFinanceMonthlySnapshot.ts:369` (caja cobrada) |
| `PrismaFinanceReceiptItemRepository.listByClientAndMonth` | idem + `clientGrId` | `BuildFinanceMonthlySnapshot.ts:493`, `ComputeCacAndPayback.ts:202` |
| `PrismaFinanceReceiptApplicationRepository.listByMonth` | `receipt: { fechaRecibo: {gte, lt} }` | `BuildFinanceMonthlySnapshot.ts:373` (`unclassifiedAmountArs`) |
| `PrismaFinanceReceiptApplicationRepository.listByClientAndMonth` | idem + `clientGrId` | atribución Fase 3 |

Sin este filtro, marcar `anulado = true` correctamente **no cambia nada en el dashboard**:
la plata anulada se seguiría contando para siempre. Esto es exactamente la **deuda #7**
aceptada en `openspec/changes/finance-growth-dashboard/proposal.md:164-168,178` — este
change la cierra.

---

## Medido vs asumido

| Afirmación | Estado |
|---|---|
| 0 anulaciones observables en 2.821 recibos / 3 meses | **MEDIDO** (2026-08-10) |
| Placeholder de no-anulado = `"00-00-0000 00:00:00"` | **MEDIDO** |
| 34,1 % de faltantes en el día 05-08, 100 % explicados por confirmación tardía | **MEDIDO** |
| Cola de retraso de confirmación: +1 a +3 días | **MEDIDO — pero CENSURADO A DERECHA**: la muestra se corta el 08-08. Un recibo del 05-08 que confirme el 20-08 no podía aparecer en esa medición. El +3 es un **piso**, no un techo |
| ~5.000 recibos/mes (~170/día promedio); 299 el 05-08 fue **pico** de principio de mes | **MEDIDO** (jul-2026 = 5.162 en el probe de `portal-payments`; espejo = 17.020 en 101 días = 168/día) |
| Latencia de `recibos`: 1.019-1.251 ms/llamada | **MEDIDO** (docblock fix-wave-3 R10) |
| El faltante **total** mayo→hoy | **NO MEDIDO**. El 34 % es de UN día pico; no se extrapola |
| GR expondría `fecha_anulacion` al re-consultar un recibo ya anulado | **ASUMIDO / NO VERIFICABLE HOY** — no hay ningún caso anulado para probarlo |

---

## Qué NO está roto

- El **upsert es idempotente** por `grReceiptId` (`PrismaFinancePaymentReceiptRepository.ts:20-46`,
  `@id` en `schema.prisma:2657`), y lo mismo items / aplicaciones / retenciones. Re-escanear
  un rango ya escaneado es **gratis y seguro**: reescribe las mismas filas.
- El manejo del **sobre de error de GR** (`parseReceiptsResponse` tira si `error != "0"`,
  `GestionRealClient.ts:784-788`) está bien y **no se toca**. Este archivo tiene historial de
  un parser que degradaba errores a datos vacíos y terminó borrando facturas (FIX-1,
  2026-08-04, documentado en `GestionRealClient.ts:416-441`).
- La **arbitración del scheduler** (`FinanceReceiptIngestScheduler`) ya está construida para
  exactamente esta forma: presupuesto compartido, carriles con prioridad, backoff propio,
  lock `finance-receipts-ingest`. Sumar un carril es extender un patrón, no inventarlo.
- El **rebuild nocturno de snapshots** ya recomputa el mes corriente **y el anterior**
  (`FinanceSnapshotScheduler.ts:109-118`), justamente para "absorber caja que llegó tarde".
  La pieza que falta no es el rebuild: es que la caja **llegue**.

---

## Propuesta, pieza por pieza

### 1. Carril de reconciliación por ventana (lo nuevo de verdad)

Un tercer carril en `FinanceReceiptIngestScheduler` — prioridad **delta > reconcile >
backfill** — que re-consulta a GR una ventana móvil de **N días hacia atrás** y re-upsertea,
una página por tick, con la misma forma de cursor reanudable que ya usan los otros dos
(`"{fechaDesde}:{fechaHasta}:{offset}"`, SyncState propio `finance-receipts-reconcile`).

Ese único pase resuelve **las dos cosas**:

- **caza los confirmados tarde** (el problema medido y activo), y
- **si algún día un recibo vuelve con `fecha_anulacion` real, lo marca `anulado = true`**
  (el problema defensivo).

**Dimensionamiento de N — con criterio, no con un número lindo.** El techo medido de la cola
(+3 días) está censurado, así que no sirve como cota. El criterio que sí cierra es otro:

> **La ventana de reconciliación debe ser ≥ la ventana de rebuild de snapshots.**

El scheduler de snapshots recomputa mes corriente + mes anterior. Un recibo reparado fuera de
esa ventana **no cambia el dashboard** aunque lo espejemos (habría que rebuildear a mano).
Peor caso: el día 1 de un mes, el mes anterior empieza 31 días atrás. ⇒ **N = 35 días** por
defecto, configurable. Invariante limpia y auditable: *todo recibo que el carril repara cae
en un mes que esa misma noche se recomputa*.

### 2. El parser deja de saltear los anulados

`GestionRealClient.ts:811` — sacar el `continue` y dejar fluir el recibo con su bandera:
llevar `fechaAnulacion` de verdad (hoy se descarta, se escribe `fechaAnulacion: null` en la
línea 825) hasta `mapGrReceipt.ts:33`, que pasa de hardcodear `anulado: false` a derivarlo de
`isRealAnnulment(...)`.

**Corrección al framing de la card**: el skip **no está en el mapper**. Un recibo anulado
nunca llega al mapper hoy. Tocar solo `mapGrReceipt.ts` no haría absolutamente nada.

**El sobre de error no se toca.** Solo el skip.

### 3. Los lectores del dashboard filtran `anulado`

Agregar `anulado: false` a la cláusula `receipt: { ... }` de los **cuatro** métodos de la
tabla de arriba (items y aplicaciones, `listByMonth` y `listByClientAndMonth`), más sus
equivalentes in-memory. Sin esto, las piezas 1 y 2 son decorativas para el dashboard.

Esto cierra la deuda #7; al archivar corresponde tachar esa fila de la tabla de riesgos de
`finance-growth-dashboard`.

### 4. Catch-up del pasado — **con lo que ya existe, cero código nuevo**

Los huecos de mayo→hoy ya son permanentes: el delta nunca vuelve a pedir esos rangos, y el
backfill no re-barre un mes que ya cerró. Se reparan **operativamente**, con dos endpoints
que ya están construidos, testeados y cableados:

1. **`POST /api/finance/growth/sync/rearm-backfill`** (`RearmFinanceReceiptsBackfill`, permiso
   `finance:sync`) — resetea el cursor del backfill a `{mesCorriente}:0` y lo hace caminar de
   nuevo mes a mes hacia atrás hasta `backfillFloorYearMonth`. Con el piso en `2026-05`
   (el que fijó `portal-payments`), eso re-barre **exactamente** ago→jul→jun→may. Idempotente
   por `grReceiptId`. Y como corre **después** de la pieza 2, de paso retro-marca cualquier
   anulado que GR exponga en ese rango.
   **Costo**: ~4 meses × ~5.000 recibos = ~20.000 → ~200 páginas → **~67 min** de carril.
2. **`POST /api/finance/growth/sync/backfill-snapshots`** para `2026-05..2026-08` — recomputa los
   snapshots mensuales para que el dashboard refleje la caja reparada (el rebuild nocturno
   solo toca los dos meses más recientes).

⚠️ **Gotcha operativo, verificar ANTES de disparar**: `rearm-backfill` camina hasta
`backfillFloorYearMonth`. Si en prod el piso está por debajo de `2026-05`, el re-arm
**re-camina años** (~330.000 recibos ≈ 18 h de carril). Leer el piso vivo primero y, si hace
falta, subirlo temporalmente. Sigue siendo cero código.

### 5. `isRealAnnulment`: endurecer sin volarse la página entera

`financeDates.ts:40-74` es **fail-open** por diseño (fix-wave-1 F10): un valor no vacío que no
parsea como fecha DD-MM-YYYY se trata como "no anulado", con un `console.warn` y nada más. El
punto ciego está **explícitamente testeado** hoy: `isRealAnnulment('2026-06-15 10:00:00')`
(ISO) → `false` (`financeDates.test.ts:86`). Si GR driftea a ISO, **toda anulación real pasa
a contarse como plata cobrada, en silencio**.

Fail-closed a lo bestia **no sirve**: el throw sube por `parseReceiptsResponse` → `execute()`
y **una sola fecha rara en una página bloquea las otras 99** y dispara el backoff de GR.
Radio de explosión desproporcionado.

Propuesta de tres capas:

1. **Aceptar también ISO** (`YYYY-MM-DD [HH:MM:SS]`), que es el drift plausible. El centinela
   de todos-ceros ya está generalizado a cualquier orden/ancho (`financeDates.ts:63`) — eso
   queda como está.
2. **Residuo → lado seguro por fila**: no vacío, no todo-ceros, no parseable en ninguno de los
   dos formatos ⇒ **`anulado = true`** + warn ruidoso. GR no llena ese campo por gusto: si
   escribió algo, algo pasó. No contamos plata que no podemos verificar. Es la fila la que se
   marca, **no la página la que se cae**.
3. **Guard sistémico**: si una proporción alta de una página cae en el residuo, es drift del
   **centinela** (p.ej. GR pasa a `"0000-00-00 00:00:00"`), no anulaciones — y la regla (2)
   volcaría el espejo entero a `anulado = true`, dejando el portal en blanco y la caja en
   cero. En ese caso **se tira y no se persiste**, misma disciplina que el sobre de error. El
   umbral exacto es de la fase de diseño.

### 6. Contrato del portal: **sin campos nuevos**

Excluir los anulados del listado es **aditivo** y ya era el intent documentado (PAY-1.5, spec
archivada `portal-payments`): la fila deja de aparecer, nada más. `PortalPaymentDto` expone
`{date, amounts, method, appliedTo}` — **no** se agrega `id` ni `status`. Exponer un estado
"anulado" implicaría UI en `ipnext-customer-app` que hoy no existe: sería un campo inerte que
nadie puede ver (patrón "feature sin perilla"). Si más adelante se quiere, es aditivo y va
como change coordinado con la app.

El efecto secundario **bueno** de la pieza 1: los pagos de acreditación lenta **empiezan a
aparecer** en "Mis pagos", con ≤ (cadencia del carril) de demora tras la confirmación en GR.
Ese es el arreglo que el cliente ve.

---

## Presupuesto de llamadas a GR

Pacing compartido del carril de recibos: 20 s/tick ⇒ **4.320 ticks/día**. Hoy el delta usa
~288 (cada 5 min) y el backfill, una vez `done`, es un no-op — **el carril está ocioso ~93 %
del tiempo**.

| Ventana | Recibos/barrido | Páginas | Tiempo de carril |
|---|---:|---:|---:|
| 7 días | ~1.200 (pico ~2.100) | 12-21 | 4-7 min |
| 15 días | ~2.550 (pico ~4.500) | 26-45 | 9-15 min |
| **35 días ← recomendado** | ~5.950 (pico ~10.500) | 60-105 | 20-35 min |

| Cadencia (ventana 35 d) | Llamadas/día | % del carril | Demora máx. para el cliente |
|---|---:|---:|---|
| 1×/día | ~105 | 2,4 % | ~24 h |
| **4×/día (cada 6 h) ← recomendado** | ~420 | 9,7 % | ~6 h |
| 24×/día | ~2.520 | 58 % | ~1 h |

Con la recomendada: delta + reconcile = ~708 ticks/día = **16 % del carril**. Contra el resto
de GR (`RefreshDebtorBalances`: 5.582 llamadas/h en el carril rápido + 9.082/día en el lento
≈ 143.000/día) esto es **+0,3 %**. No pisa nada. El carril de recibos tiene lock y backoff
propios, separados de los carriles de balances.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **El fix de anulación no se puede validar contra un caso real** (0 anulaciones medidas). Se codea contra un fenómeno que nadie vio | Declarado como defensivo. Tests con fixtures + revert probe que exija **PRESENCIA** de la fila antes de assertear su exclusión — un probe cuyo assert clave sea una ausencia da verde contra el mundo pre-fix, donde la fila nunca existió |
| **La cola de confirmación está censurada a derecha**: N=35 puede seguir dejando afuera un outlier | La invariante "ventana ≥ ventana de rebuild de snapshots" acota el daño al caso que sí importa. `reconcileWindowDays` es config en DB, subible sin deploy. Métrica sugerida: contar cuántos recibos repara cada barrido y con qué antigüedad — si aparecen reparaciones pegadas al borde de la ventana, la ventana quedó corta |
| **Volcar el espejo entero a `anulado = true`** si GR driftea el centinela | Guard sistémico de la pieza 5.3: se tira la página, no se persiste |
| **Tocar el parser que ya borró facturas una vez** | Se toca **solo** el `continue` de la línea 811. El sobre de error queda intacto. Los tests de regresión F1/F2/F11/F12 de `GestionRealClient.receipts.test.ts` quedan como red |
| **`rearm-backfill` con el piso mal puesto** = 18 h de carril | Verificación explícita del piso vivo antes de disparar (pieza 4) |
| **El carril nuevo demora al delta** (el pago de hoy tarda más en verse) | Prioridad absoluta del delta, sin cambios. El reconcile toma el turno que hoy desperdicia un backfill `done` |
| **Snapshots viejos quedan desalineados** tras el catch-up | `POST /sync/backfill-snapshots` acotado a `2026-05..2026-08`, one-shot |
| Tests que **pinean el bug**: `mapGrReceipt.test.ts:28` (`anulado === false`) y `GestionRealClient.receipts.test.ts:101-112` ("excludes a receipt whose fecha_anulacion...") | Se reescriben deliberadamente y se deja constancia de por qué; no se borran en silencio |

---

## Decisiones abiertas

**Bloqueantes — piden OK explícito antes de codear:**

- **D1 — Semántica del residuo de `isRealAnnulment` (pieza 5.2).** ¿El valor no parseable pasa
  a `anulado = true` (no contamos plata que no podemos verificar; riesgo: un pago real
  desaparece de "Mis pagos") o se mantiene el fail-open actual (riesgo: plata fantasma en el
  dashboard para siempre)? **Recomendación: `anulado = true` + guard sistémico.** Hoy la
  decisión es inerte (el bucket está vacío); solo se activa bajo drift de formato — pero es
  semántica de plata de cara al cliente y no la decido solo.
- **D2 — Ejecución del catch-up (pieza 4).** Confirmar `backfillFloorYearMonth` vivo y avalar
  el disparo de `rearm-backfill` (~67 min de carril, cero código) + `backfill-snapshots` para
  `2026-05..2026-08`. Si el piso está por debajo de `2026-05`, ¿lo subimos temporalmente
  (cero código) o agregamos un piso por request (código nuevo en un endpoint ya cerrado)?
  **Recomendación: subirlo temporalmente.**

**No bloqueantes — quedan para diseño, con recomendación puesta:**

- **D3 — Ventana y cadencia**: 35 días / cada 6 h. Son knobs en `FinanceReceiptSyncConfig`,
  editables en DB sin deploy; arrancar acá y ajustar con la métrica de reparaciones.
- **D4 — Dónde vive el carril**: tercer carril dentro de `FinanceReceiptIngestScheduler`
  (mismo lock, mismo presupuesto compartido) vs. scheduler propio. **Recomendación: tercer
  carril** — es la única forma de garantizar que el presupuesto de GR no se duplique por la
  ventana.
- **D5 — Umbral del guard sistémico** (pieza 5.3).

No hay ninguna otra decisión bloqueante: el resto del alcance está determinado por lo medido.

---

## Fuera de alcance

- **Cambiar la ventana de solapamiento del delta.** El delta sigue siendo el carril de baja
  latencia (hoy). Meterle la ventana adentro degradaría la frescura del pago del día y
  reescribiría toda la lógica de cursor testeada de la ruta crítica de plata.
- **Campos nuevos en `PortalPaymentDto`** (`id`, `status`, chip de "anulado"). Aditivo y
  posible más adelante, coordinado con `ipnext-customer-app`.
- **Revertir/borrar las `FinanceReceiptApplication` de un recibo anulado.** Con el filtro por
  el padre (`receipt: { anulado: false }`) quedan excluidas de las lecturas; borrarlas sería
  destruir evidencia.
- **Un tercer estado** tipo `pending`/`unconfirmed` para recibos "desaparecidos del listado".
  Medido: 0 desaparecidos. Una ausencia no discrimina anulación de un drift de paginación;
  sin evidencia positiva no se modela.
- **Tocar el manejo del sobre de error de GR** ni el guard de identidad
  `aplicaciones = items + retenciones`.
- **Un endpoint de consulta de recibo puntual.** No existe en la API de GR
  (`GestionRealPort.ts:83-102`): todo se hace por rango de fechas paginado.
- **Rate limiter global entre features de GR.** Cada feature se pacea sola hoy; cambiarlo es
  otro change.
