# Design — `gr-receipt-annulment`

Traduce el proposal a decisiones de implementación. Todo lo que sigue está leído contra el
código real del worktree (`fix/gr-receipt-annulment`), no contra el recuerdo del explore.

**La forma en una línea**: el parser deja de tirar los anulados, el mapper deriva la bandera,
un **tercer carril** re-consulta una ventana móvil a GR y re-upsertea, un **guard de página**
impide que un drift de formato vuelque el espejo entero, y los **cuatro lectores** del
dashboard aprenden a filtrar `anulado`.

---

## Decisión 1 — El carril vive DENTRO de `FinanceReceiptIngestScheduler`

Tercer carril en el scheduler que ya existe (D4 del proposal, recomendación confirmada). No
scheduler propio: el presupuesto de GR de recibos es UNO, el lock `finance-receipts-ingest`
es UNO, y el pacing/backoff compartido es lo que garantiza que la ventana no duplique la
presión sobre GR.

### El arbitraje hoy (leído, `FinanceReceiptIngestScheduler.ts:311-338`)

```ts
const deltaDue = await this.isDeltaDue(deltaCheckIntervalMs);
const starved  = this.deltaConsecutiveFailures >= this.currentDeltaStarvationThreshold;
const runDelta = deltaDue && !(starved && this.tickCount % 2 === 0);
if (runDelta) { … delta … }
… backfill …
```

Dos mecánicas separadas que hay que entender antes de tocar nada:

1. **`deltaDue`** (`isDeltaDue`, `:400-406`): el delta gana si tiene páginas pendientes
   (cursor compuesto), si nunca corrió, o si pasó `deltaCheckIntervalMs` desde su
   `lastRunAt`. Es decir: el delta NO monopoliza — cuando terminó su rango y todavía no
   pasaron 5 min, **cede el turno**. Ese turno cedido es el que hoy se come un backfill
   `done` (no-op, cero llamadas a GR): el 93 % de ociosidad que reporta el proposal.
2. **F4 anti-starvation** (`deltaStarvationThreshold = 3`): si el delta falla 3 veces
   seguidas, deja de llevarse TODOS los ticks por el mero hecho de estar "due" — en los
   ticks pares cede aunque siga due, para que la historia siga avanzando. No es un
   circuit-breaker que apaga el delta: es una **alternancia** (impares reintentan delta,
   pares van al otro carril).

### El arbitraje nuevo

```ts
const runDelta     = deltaDue     && !(deltaStarved     && this.tickCount % 2 === 0);
if (runDelta) { … delta … }

const runReconcile = reconcileDue && !(reconcileStarved && this.tickCount % 2 === 0);
if (runReconcile) { … reconcile … }

… backfill …
```

- **Prioridad delta > reconcile > backfill**, tal cual pide el proposal.
- El reconcile hereda la MISMA mecánica de F4, **con el mismo knob**
  (`deltaStarvationThreshold`, sin inventar uno nuevo): si el reconcile falla N veces
  seguidas, en los ticks pares cede al backfill. Sin esto, un reconcile roto que siempre
  está "due" (porque tiene páginas pendientes que nunca persisten) se queda con el 100 % de
  los turnos que el delta cede y **starvea al backfill**, que es exactamente el bug F4 en
  otra posición.
- **El delta no se toca.** `isDeltaDue`, su cursor, su ventana de solapamiento: idénticos.

### ¿Puede el reconcile starvear al backfill sin fallar?

Sí, durante un barrido. Un barrido de 35 días son ~60-105 páginas; a 20 s/tick son 20-35 min
en los que el backfill no toma turno. **Invariante de dimensionamiento**, explícita y
auditable:

> `páginas_del_barrido × requestIntervalMs  <  reconcileCheckIntervalMs`

Con 35 d / 6 h: 105 × 20 s = 35 min ≪ 6 h. Margen 10×. Si alguien pone la cadencia en 30 min
con ventana 35 d, el carril queda **permanentemente ocupado** y el backfill nunca corre. No
se defiende con un clamp (la relación depende del volumen de GR, que no conocemos en
tiempo de config): se defiende con **observabilidad** — al cerrar cada barrido el carril
loguea su duración y emite `WARN` si `duración >= reconcileCheckIntervalMs` (ver Decisión 9).

En régimen esto es inocuo: el backfill queda `done` y su `execute()` es un no-op de cero
llamadas a GR. El único momento en que compiten de verdad es el catch-up (ver Rollout).

### Efectos colaterales en el scheduler

| Qué | Cambio |
|---|---|
| `activeLane` (campo + `FinancePacingStatusDto.activeLane`) | union `'delta' \| 'reconcile' \| 'backfill' \| 'idle'` |
| `FinanceReceiptIngestTickResult` | `lane` gana `'reconcile'`; nuevo campo opcional `reconcile?: ReconcilePageResult` |
| `reconcileConsecutiveFailures` | contador PROPIO (nunca compartido — lección R4: un contador compartido deja que la recuperación de un carril enmascare la degradación sostenida de otro) |
| `worstConsecutiveFailures()` | suma el contador nuevo al `Math.max` |
| `trackGrHealth` | sin cambios de criterio, pero ver Decisión 4 (el error del guard NO debe culpar a GR) |

⚠️ **Deuda cruzada con el front**: `activeLane` viaja en `GET /sync/status`. Si el FE mapea
la lane a una etiqueta con un diccionario cerrado, `'reconcile'` va a renderizar vacío.
`sdd-tasks` debe verificarlo en `ipnext-frontend` y, si hace falta, dejarlo como change
coordinado. Es aditivo (no rompe el contrato), pero un label en blanco es exactamente el
tipo de "feature a medio conectar" que este repo ya pagó caro.

---

## Decisión 2 — Estado del carril: `SyncState` propio, cursor compuesto, ventana CONGELADA

Entidad nueva `finance-receipts-reconcile` en `SyncState`. Nada compartido con el delta ni
con el backfill (cursores independientes, fallos independientes, `itemsSynced` propio).

**Cursor**: `"{fechaDesde}:{fechaHasta}:{offset}"` — la misma codificación compuesta que ya
usa el delta mientras pagina. Dos diferencias deliberadas:

1. **Nunca colapsa a fecha plana.** El colapso del delta (`cursor = fechaHasta`) es
   justamente el mecanismo que causa el bug de los confirmados tarde. Acá el fin de barrido
   se marca con `cursor = null`.
2. **La ventana se congela al arrancar el barrido.** `fechaDesde`/`fechaHasta` se calculan
   UNA vez y viven en el cursor; si el barrido cruza la medianoche AR, las páginas siguen
   pidiendo el MISMO rango. Sin esto, el `total` de GR cambia a mitad de paginado y el
   offset apunta a otra cosa (se saltean o duplican recibos silenciosamente).

**Ciclo de vida**

| Estado | `cursor` | `isReconcileDue` |
|---|---|---|
| nunca corrió | (sin fila) | `true` |
| barrido en curso | `"05-07-2026:08-08-2026:300"` | `true` (páginas pendientes) |
| barrido cerrado | `null` | `now - lastRunAt >= reconcileCheckIntervalMs` |
| error | cursor SIN avanzar | `true` (páginas pendientes) → reintenta la misma página |

```ts
isReconcileDue = cfg.reconcileEnabled && (
  !prior || compositeCursorHasPendingPages(prior.cursor) ||
  !prior.lastRunAt || now - prior.lastRunAt >= cfg.reconcileCheckIntervalMs
);
```

`cursor === null` acá significa **ocioso**, no "desarmado" (backfill) ni "nunca sincronizó"
(delta). Es la tercera semántica del mismo valor en la misma tabla — se documenta en el
docblock del use case y se pinea con test, porque es una trampa de lectura.

**Cálculo de la ventana** (calendario AR, mismo huso que todo el módulo):

```ts
fechaHasta = grDateAr(now);
fechaDesde = grDateAr(now - (windowDays - 1) días);   // 35 ⇒ hoy + 34 hacia atrás
```

`windowDays` cuenta días de calendario **incluyendo hoy**. Con 35: `fechaDesde = hoy - 34`.

**Cursor corrupto**: mismo criterio F14 del delta — `parseCompositeCursor` devuelve `null` y
el carril **recalcula la ventana desde cero** (no re-deriva un rango basura que GR va a
rechazar en loop), con `console.warn`.

**Reutilización**: `parseCompositeCursor` y `deltaCursorHasPendingPages` hoy viven privados/
exportados dentro de `SyncGrReceiptsDelta.ts`. Se mueven a `financeReceiptCursors.ts`
(application) y `SyncGrReceiptsDelta` re-exporta `deltaCursorHasPendingPages` en una línea,
para no romper los imports de `GetFinanceSyncStatus` ni del scheduler. **Una sola
implementación del parseo de cursor** — dos copias es la receta de "el test certifica la
canónica y prod corre la otra".

**Idempotencia del re-upsert**: garantizada por construcción, `grReceiptId` es `@id`
(`schema.prisma:2657`), y las hijas usan ids sintéticos determinísticos
(`${grReceiptId}-${key}`, `-item-`, `-ret-`). Re-barrer un rango ya barrido reescribe las
mismas filas. Esto ya está probado en prod por el backfill.

---

## Decisión 3 — El flujo del anulado: parser → mapper → upsert

### 3.1 Parser (`GestionRealClient.parseReceiptsResponse`)

Dos líneas, y solo dos:

```diff
-    if (isRealAnnulment(raw.fecha_anulacion, key)) continue;
-
     ...
-      fechaAnulacion: null,
+      fechaAnulacion: str(raw.fecha_anulacion),
```

- El sobre de error (`:784-788`) **no se toca**. Los guards F1/F2/F11/F12 tampoco.
- El parser deja de decidir sobre el dominio: pasa el dato crudo y **el mapper decide**. Eso
  saca `isRealAnnulment` (regla de negocio, `application/`) de un adapter de
  `infrastructure/` — además de arreglar el bug, endereza la dependencia.
- Las hijas de un recibo anulado (`aplicaciones`/`items`/`retenciones`) **se parsean y se
  persisten igual**. No se destruye evidencia (fuera de alcance del proposal); quedan
  excluidas de las lecturas por el filtro del padre (Decisión 6).

### 3.2 Mapper (`mapGrReceipt.ts:33`)

```diff
-    anulado: false,
+    anulado: isRealAnnulment(r.fechaAnulacion, r.grReceiptId),
```

Se actualizan los docblocks que hoy afirman lo contrario: `mapGrReceipt.ts:18-24`,
`FinancePaymentReceiptRepository.ts:12-16` ("Always `false` in practice"),
`schema.prisma:2662-2663` ("nunca llega hasta acá"), y los comentarios
`"post-annulment-exclusion"` de `DeltaPageResult`/`BackfillPageResult`. Documentación que
miente es peor que documentación que falta.

### 3.3 Upsert — qué pisa y qué preserva

`PrismaFinancePaymentReceiptRepository.upsertBatch` (`:20-46`) ya escribe `anulado: r.anulado`
en el bloque `update`. **No hay que tocar el adapter**: el día que el mapper produzca `true`,
el re-upsert marca la fila. Hoy esa escritura es siempre `false` porque el anulado nunca llega.

| Campo | Re-upsert |
|---|---|
| `grReceiptId` | clave, nunca cambia |
| `clientGrId`, `recaudador`, `fechaRecibo`, `fechaConfirmacion`, `anulado`, `observaciones` | **se pisan con lo que dice GR** |
| `createdAt` | preservado (`@default(now())`, solo en `create`) |
| `updatedAt` | bump en cada re-upsert (`@updatedAt`) |

**Convergencia bidireccional, deliberada**: si GR "des-anula" un recibo, el espejo vuelve a
`anulado = false`. El espejo replica a GR, no acumula estados propios.

### 3.4 `updatedAt` churn — medido y ACEPTADO, no ignorado

Un barrido re-escribe ~5.950 recibos + sus hijas ≈ 20.000 filas; a 4 barridos/día son
**~80.000 UPDATEs/día**. Contra los ~800.000 que ya escribió el backfill de 163 meses, es
ruido. Nada lee `updatedAt` de estas cuatro tablas para lógica de negocio (verificado:
`PrismaPortalPaymentsReader` selecciona campos explícitos; los lectores del dashboard cortan
por `fechaRecibo`).

**Se descarta el diff-before-write** (leer la página, comparar, upsertear solo lo cambiado),
a pesar de que evitaría el churn:

1. Introduce una lectura que puede quedar stale y una rama que puede **saltear un cambio
   real en silencio** — la clase exacta de bug que este change existe para arreglar.
2. Parte la ruta de persistencia en dos: la que corren delta/backfill y la que corre el
   reconcile. "El concepto implementado dos veces" = el test certifica una y prod corre la
   otra.

Si el churn algún día molesta, la palanca es la **cadencia** (knob en DB), no una rama nueva.

---

## Decisión 4 — Guard sistémico: se calcula sobre la página mapeada, ANTES de cualquier escritura

### Definición exacta

```ts
// financeAnnulmentGuard.ts (application) — pura, sin I/O
const total    = mapped.length;
const annulled = mapped.filter((m) => m.receipt.anulado).length;

const fires =
  total > 0 &&
  annulled >= cfg.annulmentGuardMinCount &&        // piso ABSOLUTO
  annulled * 100 > cfg.annulmentGuardMaxPct * total; // estrictamente MAYOR, aritmética entera
```

| Pregunta | Respuesta y por qué |
|---|---|
| ¿% sobre qué universo? | Sobre la **página** (`total = mapped.length`). Una corrida del carril ES una página (un `execute()` = una página, invariante del módulo desde Decision 4b). Acumular por barrido exigiría estado cross-tick que hoy no existe y llegaría tarde: para cuando el barrido cierra, ya escribiste 60 páginas. |
| ¿Piso absoluto? | Sí, `annulmentGuardMinCount = 5`. Sin piso, una página tail de 3 recibos con 1 anulado (33 %) aborta el barrido y **lo deja trabado para siempre** — la anulación legítima y rara es justo el caso que el guard NO debe cazar. |
| ¿`>` o `>=`? | Estrictamente `>`. Con `maxPct = 5`: 5/100 pasa, 6/100 aborta. Frontera pineada con test. |
| ¿`total === 0`? | No dispara. Sin división por cero, y una página vacía ya tiene su propio guard (F12). |
| ¿Qué carriles? | **Los tres.** El mapper marca `anulado` en todos; el drift de formato entra por cualquiera. Helper compartido (Decisión 8). |

### Dónde corta

En el use case, entre `receipts.map(mapGrReceipt)` y el primer `upsertBatch`. Es decir:
**después del fetch, antes de TODA escritura** — ni recibos, ni aplicaciones, ni items, ni
retenciones, ni `invoiceTypes.upsertIfAbsent`, ni el `state.save` de éxito.

Tira `FinanceReceiptAnnulmentGuardError`. El `catch` externo que ya existe graba
`lastResult: "error: …"` **con el cursor sin avanzar** ⇒ la misma página se reintenta cada
vez que al carril le toca turno, fuerte y visible, hasta que un humano intervenga. Es el
mismo trato que el sobre de error de GR.

### Que el guard NO culpe a GR

`trackGrHealth` (`:391-397`) hoy distingue `FinanceReceiptPersistenceError` (GR contestó
bien, falló la escritura ⇒ resetea `grConsecutiveFailures`) de todo lo demás (⇒ escala el
backoff compartido). El guard cae hoy en "todo lo demás" y **clavaría el pacing en
`maxRequestIntervalMs` (300 s) por un problema que no es de GR** — el bug exacto de R8,
reintroducido.

Fix mínimo y honesto: una clase base marcadora.

```ts
export abstract class FinanceReceiptPostFetchError extends Error {}
export class FinanceReceiptPersistenceError    extends FinanceReceiptPostFetchError { … }  // sin cambios de comportamiento
export class FinanceReceiptAnnulmentGuardError extends FinanceReceiptPostFetchError { … }
```

`trackGrHealth` pasa a chequear `err instanceof FinanceReceiptPostFetchError`. Todo
`instanceof FinanceReceiptPersistenceError` existente sigue siendo `true` — cero regresión.

### Qué loguea

```
[finance-receipts-reconcile] ABORT anulados=63/100 (63%) umbral=5% min=5
  rango=05-07-2026..08-08-2026 offset=300
  muestra: 344174="0000-00-00 00:00:00", 344180="0000-00-00 00:00:00", 344191="—"
```

`console.error` (no `warn`: es una corrida abortada). La **muestra de hasta 5 valores crudos
de `fecha_anulacion`** es lo que convierte el incidente en un diagnóstico de 10 segundos: si
los tres valores son iguales, es drift del centinela; si son fechas variadas, son anulaciones
de verdad y hay que subir el knob.

### Cómo se observa

- `SyncState('finance-receipts-reconcile').lastResult` arranca con `error: ANULADOS …`.
- `GET /sync/status` → `degraded: true`, `consecutiveFailures > 0` (vía el contador propio
  del carril en `worstConsecutiveFailures`), y el bloque `reconcile` nuevo (Decisión 9).
- El pacing de GR **no** se degrada (esa es la mitad del punto).

---

## Decisión 5 — `isRealAnnulment` endurecido: tres capas

Hoy (`financeDates.ts:40-74`) es fail-open: lo que no parsea como `DD-MM-YYYY` cuenta como
"no anulado". El punto ciego está **testeado como comportamiento esperado**
(`financeDates.test.ts:86`: ISO → `false`).

1. **Aceptar ISO** `YYYY-MM-DD [HH:MM:SS]` además de `DD-MM-YYYY [HH:MM:SS]`. Desambiguación:
   si el primer componente tiene **4 dígitos**, se interpreta ISO (año primero); si no,
   DD-MM-YYYY. Los separadores `- / .` ya están soportados y siguen igual.
2. **Residuo ⇒ `true`** (D1 cerrada por el usuario): no vacío, no todo-ceros, no parseable en
   ninguno de los dos formatos ⇒ **anulado**, con `console.warn` ruidoso. GR no llena ese
   campo por gusto. La fila se marca; **la página NO se cae** (radio de explosión de una fila).
3. **Guard sistémico** (Decisión 4) para el caso en que el residuo deje de ser residuo.

El centinela de todos-ceros se chequea **antes** de la desambiguación de formato y queda
exactamente como está (`:63`, cualquier orden/ancho) — es el único caso KNOWN-GOOD y nunca
se advierte.

### Tabla entrada → salida

| `fecha_anulacion` | Hoy | Nuevo | Warn |
|---|---|---|---|
| `undefined` / `null` / no-string | `false` | `false` | no |
| `''`, `'   '` | `false` | `false` | no |
| `'00-00-0000 00:00:00'` (centinela medido) | `false` | `false` | no |
| `'00-00-0000'` | `false` | `false` | no |
| `'0000-00-00 00:00:00'` (drift ISO del centinela) | `false` | `false` | no |
| `'0/0/0'`, `'0.0.0'` | `false` | `false` | no |
| `'20-06-2026 12:00:00'` | `true` | `true` | no |
| `'20-06-2026'` | `true` | `true` | no |
| `'15/06/2026'` | `true` | `true` | no |
| **`'2026-06-15 10:00:00'` (ISO)** | **`false`** ⚠️ | **`true`** | no |
| `'2026-06-15'` | `false` ⚠️ | `true` | no |
| `'32-13-2026'` (DD-MM imposible) | `false` | **`true`** | **sí** |
| `'2026-13-45'` (ISO imposible) | `false` | **`true`** | **sí** |
| `'basura'`, `'N/A'`, `'-'` | `false` | **`true`** | **sí** |
| `'2026-2026-2026'` | `false` | **`true`** | **sí** |

Las tres filas marcadas ⚠️ son las que hoy contarían plata anulada como cobrada en silencio.

El mensaje del warn cambia: ya no dice "treated as NOT annulled (fail-open)" sino "**tratado
como ANULADO** — sin dato verificable no se cuenta la plata; si GR cambió de formato, revisar
YA porque el guard sistémico puede abortar la ingesta".

---

## Decisión 6 — Los cuatro lectores del dashboard filtran `anulado`

Sin esto, las decisiones 1-5 son decorativas para el dashboard: la plata anulada se sigue
contando. Es la **deuda #7** de `finance-growth-dashboard`.

| Adapter Prisma | Método | `where` nuevo |
|---|---|---|
| `PrismaFinanceReceiptItemRepository` | `listByMonth` | `receipt: { fechaRecibo: {gte, lt}, anulado: false }` |
| `PrismaFinanceReceiptItemRepository` | `listByClientAndMonth` | idem + `clientGrId` |
| `PrismaFinanceReceiptApplicationRepository` | `listByMonth` | idem |
| `PrismaFinanceReceiptApplicationRepository` | `listByClientAndMonth` | idem + `clientGrId` |

Y sus **gemelos in-memory** (`InMemoryFinanceReceiptItemRepository`,
`InMemoryFinanceReceiptApplicationRepository`), que ya resuelven el recibo padre para cortar
por `fechaRecibo` — agregar `&& !receipt.anulado` en el mismo `filter`. Los dos gemelos
tienen que quedar **idénticos en semántica** al Prisma: si divergen, los tests de use case
certifican un mundo que no es producción (es literalmente el bug W2 de este mismo archivo,
donde el in-memory replicaba el filtro equivocado y por eso no cazó la regresión).

`PrismaPortalPaymentsReader.ts:46` ya filtra — **no se toca**.

Índices: `FinancePaymentReceipt` tiene `@@index([fechaRecibo])` y
`@@index([clientGrId, fechaRecibo])`. `anulado` es un booleano de selectividad ~1 (0 filas
`true` hoy) — **no se agrega índice**; sería un índice muerto que solo cuesta escrituras.

---

## Decisión 7 — Knobs nuevos: migración aditiva + normalizador "basura al lado SEGURO"

### Migración

`prisma/migrations/20261109000000_finance_receipt_reconcile_lane/migration.sql`, generada con
`prisma migrate diff` (jamás SQL a mano). 100 % aditiva, `NOT NULL` + `DEFAULT`, sin
migración de datos:

```sql
-- AlterTable
ALTER TABLE "FinanceReceiptSyncConfig" ADD COLUMN "reconcileEnabled"         BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "FinanceReceiptSyncConfig" ADD COLUMN "reconcileWindowDays"      INTEGER NOT NULL DEFAULT 35;
ALTER TABLE "FinanceReceiptSyncConfig" ADD COLUMN "reconcileCheckIntervalMs" INTEGER NOT NULL DEFAULT 21600000;
ALTER TABLE "FinanceReceiptSyncConfig" ADD COLUMN "annulmentGuardMaxPct"     INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "FinanceReceiptSyncConfig" ADD COLUMN "annulmentGuardMinCount"   INTEGER NOT NULL DEFAULT 5;
```

Molde exacto: `20261023000300_finance_delta_starvation_threshold`. La fila singleton en prod
hereda los defaults ⇒ **el carril arranca prendido, con 35 d / 6 h, sin acción del operador**.

`FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` se actualiza con los mismos cinco valores (hoy es la
copia declarada del seed de la migración; si divergen, el fallback del `readConfigSafely` del
scheduler pasa a mentir).

### El normalizador

`PrismaFinanceReceiptSyncConfigRepository.get()` devuelve la fila **cruda**. Una fila
editada a mano por SQL puede traer cualquier cosa. Se agrega una función **pura** exportada
desde el port:

```ts
// domain/ports/FinanceReceiptSyncConfigRepository.ts
export function normalizeFinanceReceiptSyncConfig(raw: Partial<FinanceReceiptSyncConfig>): FinanceReceiptSyncConfig
```

llamada por **los dos** adapters (Prisma e in-memory) en su `get()`. Si solo la llamara el
Prisma, los tests correrían sobre reglas distintas a las de producción.

| Knob | Rango válido | Inválido cae a | Por qué ese es el lado SEGURO |
|---|---|---|---|
| `reconcileEnabled` | bool | `true` | apagar es una decisión EXPLÍCITA; un tipo raro no puede apagar la feature en silencio |
| `reconcileWindowDays` | `[1, 90]` | **35** | `0`/negativo ⇒ ventana vacía ⇒ **feature inerte y el bug vuelve sin que nada falle**. `>90` ⇒ presión sobre GR. El lado seguro es el valor dimensionado, NO un extremo del rango |
| `reconcileCheckIntervalMs` | `[600000, 86400000]` | **21600000** | demasiado chico ⇒ carril siempre ocupado ⇒ starva al backfill; demasiado grande ⇒ el pago tarda días en aparecer |
| `annulmentGuardMaxPct` | `[1, 100]` | **5** | **`100` = nunca abortar = el lado PELIGROSO** (vuelca el espejo entero). Ojo: acá el máximo del rango es el peor valor posible |
| `annulmentGuardMinCount` | `[1, 1000]` | **5** | `0` ⇒ el guard dispara con 0 anulados ⇒ el carril queda trabado para siempre; un número enorme ⇒ nunca aborta |

**El default coincide con el valor seguro en los cinco knobs — y eso es exactamente lo que
hace engañoso al patrón.** El chequeo que hay que hacer en el review no es "¿cae al default?"
sino, knob por knob: *¿cuál de los dos extremos del rango puede causar daño?* Acá:

- `reconcileWindowDays` → el extremo peligroso es el **bajo** (0 = inerte).
- `annulmentGuardMaxPct` → el extremo peligroso es el **alto** (100 = nunca aborta).

Son direcciones opuestas. Un clamp ingenuo (`Math.max(1, Math.min(90, v))`) convierte un
`0` en `1` y un `100` en `100`: en el primer caso "arregla" a un valor casi-inerte, en el
segundo honra el peor valor. Por eso la regla es **rechazar y volver al default**, no
clampear al borde.

### Sin endpoint HTTP — y eso está bien

`FinanceReceiptSyncConfig` no tiene endpoint (decisión ya tomada en `finance-growth`, ver el
docblock del port: "operational knob, edited by migration/DB"). Checklist de "feature sin
perilla" antes de dar esto por terminado:

1. ✅ La feature se enciende sola (default `true` en la migración) — no requiere ninguna acción.
2. ✅ El camino para ajustarla existe y está probado: `UPDATE "FinanceReceiptSyncConfig" SET …`
   sobre el singleton, el mismo que ya se usa para `enabled`/`backfillFloorYearMonth`.
3. ✅ El scheduler re-lee la config **en cada tick** (`readConfigSafely`) ⇒ el `UPDATE` tiene
   efecto sin redeploy.
4. ✅ El estado del carril es observable sin entrar a la DB (`GET /sync/status`, Decisión 9).

---

## Decisión 8 — UNA sola ruta de fetch→map→guard→persist para los tres carriles

`SyncGrReceiptsDelta` y `SyncGrReceiptsBackfillBatch` ya tienen el mismo cuerpo copiado
(map → 4 upserts → identity warnings → `invoiceTypes.upsertIfAbsent` → wrap en
`FinanceReceiptPersistenceError`). Un tercer carril sería la **tercera copia**.

Se extrae a `financeReceiptPageIngest.ts` (application):

```ts
/** map + guard sistémico. Tira FinanceReceiptAnnulmentGuardError. NO escribe nada. */
export function mapAndGuardReceiptPage(receipts, cfg, lane): MappedGrReceipt[]

/** las 4 upserts + identity warnings + auto-alta de grTypes, wrapped en FinanceReceiptPersistenceError */
export async function persistReceiptPage(mapped, repos, lane): Promise<void>
```

Lo que queda propio de cada carril es lo único que de verdad difiere: **la política de
cursor y de ventana**.

Riesgo asumido: es un refactor sobre la ruta de la plata. La red son los tests que ya
existen (`SyncGrReceiptsDelta.test.ts`, `SyncGrReceiptsBackfillBatch.test.ts`,
`finance-receipts-ingest-seam.test.ts` con los casos R1/F4/F5/F12/F14) — deben pasar **sin
tocarse**. Si un test de esos hay que modificarlo para que el refactor pase, el refactor
cambió comportamiento y hay que parar.

**Use case nuevo**: `SyncGrReceiptsReconcileWindow.ts` (verbo + sustantivo, un archivo).
Colaboradores idénticos a los otros dos + `syncConfig` (necesita `reconcileWindowDays` y los
knobs del guard). `itemRepo`/`retencionRepo` **obligatorios y no-trailing**, con el mismo
throw en el constructor (criterio R9): perder ese cableado tiene que romper el `tsc`, no
zerear la métrica de caja en silencio.

---

## Decisión 9 — Observabilidad: la métrica que hace FALSABLE la ventana de 35 días

El proposal deja abierto que la cola de confirmación está **censurada a derecha** (el +3 días
es un piso, no un techo). La única forma de saber si 35 días alcanza es medir **la antigüedad
de lo que el carril repara**.

Se agrega al port `FinancePaymentReceiptRepository`:

```ts
/** Cuáles de estos ids YA existen en el espejo. Una query, nunca N. */
existingIds(grReceiptIds: string[]): Promise<Set<string>>;
```

(Prisma: `findMany({ where: { grReceiptId: { in } }, select: { grReceiptId: true } })`. Método
**obligatorio** en la interfaz ⇒ ambos adapters lo implementan o no compila.)

El carril de reconcile lo llama una vez por página, **antes** de persistir, y loguea:

```
[finance-receipts-reconcile] page ok @300 nuevos=3 anulados=0 masViejoReparado=+9d
```

- `nuevos` = los que el delta perdió (confirmados tarde) — **la métrica del bug medido**.
- `masViejoReparado` = `hoy - fechaRecibo` del más viejo de los nuevos.
- **`WARN` cuando `masViejoReparado >= windowDays - 3`**: hay reparaciones pegadas al borde
  de la ventana ⇒ la ventana quedó corta ⇒ subir `reconcileWindowDays` (knob, sin deploy).
  Sin esta alarma el dimensionamiento de 35 días es incontrastable.

Al cerrar el barrido:

```
[finance-receipts-reconcile] sweep ok 05-07-2026..08-08-2026 paginas=61 duracion=21m
```

con `WARN` si `duracion >= reconcileCheckIntervalMs` (el carril no llega a terminar antes de
volver a arrancar ⇒ starva al backfill, ver Decisión 1).

`GetFinanceSyncStatus` gana un bloque `reconcile` (`lastRunAt`, `lastResult`, `itemsSynced`,
`sweepInProgress`, `windowFrom`, `windowTo`, `pageOffset`), derivado del cursor con la misma
convención que ya usa para delta y backfill. Aditivo en la respuesta de `/sync/status`.

---

## Wiring

| Archivo | Cambio |
|---|---|
| `bootstrapFinanceReceiptsIngest.ts` | construye `SyncGrReceiptsReconcileWindow` con los MISMOS repos Prisma + `syncConfig`, y lo pasa al scheduler |
| `FinanceReceiptIngestScheduler` (constructor) | nuevo parámetro `syncReconcile`, **posicional y OBLIGATORIO** (nunca opcional-trailing), + throw en el constructor si viene falsy |
| `app.ts` | **sin cambios** — ya recibe y propaga la instancia del scheduler |
| `main.ts` | **sin cambios** — ya hace `await bootstrapFinanceReceiptsIngest()` y `.start()` |
| `GetFinanceSyncStatus` | lee la entidad nueva |
| `financeGrowth.routes.ts` | sin rutas nuevas; solo el bloque `reconcile` que ya viene del use case |

### El pin del composition root — que verifique la DEPENDENCIA, no el texto

Lección W6 (feature muerta en prod por wiring no inyectado) + la lección del mata-mutantes
con agujero (un pin que matchea el NOMBRE en el fuente sobrevive a que le pasen la variable
equivocada). Tres capas, en orden de fuerza:

1. **Tipo (la más fuerte)**: parámetro obligatorio ⇒ un bootstrap que no lo pase **no
   compila**. Se pinea con un test de aridad explícito:
   ```ts
   // @ts-expect-error — syncReconcile es OBLIGATORIO: si esto deja de dar error de tipos,
   // alguien lo volvió opcional y un wiring perdido pasa a ser silencioso (F13/R9).
   new FinanceReceiptIngestScheduler(delta, backfill, state, lock, cfg);
   ```
   Si alguien afloja el tipo, el `@ts-expect-error` queda sin usar y **el test falla**.
2. **Runtime**: throw en el constructor si `syncReconcile` es falsy (caza el JS sin tipos).
3. **Texto** (complemento, nunca la única defensa): en
   `finance-growth-composition-root.test.ts`, slice desde `new SyncGrReceiptsReconcileWindow(`
   hasta su `);` de cierre — **nunca una ventana de N caracteres mágica** (la lección
   fix-wave-2: un comentario nuevo adentro de la llamada dejó ciegas dos aserciones) — y
   verificar que ahí aparecen `itemRepo`, `retencionRepo` y `syncConfig`; y que la llamada
   `new FinanceReceiptIngestScheduler(` menciona la variable `syncReconcile`.

Y la capa que realmente prueba que el carril **corre**: el test de seam del scheduler con los
tres use cases REALES, donde se asserta que a lo largo de N ticks el reconcile **fue
invocado** y dejó su `SyncState` escrito (ver Testing).

---

## Testing strategy

TDD estricto: rojo → verde → refactor. **Adapters in-memory siempre; jamás mockear Prisma**
(excepción establecida: los tests de `where` de adapters Prisma espían
`prisma.<tabla>.findMany` — molde `PrismaPortalPaymentsReader.test.ts` — porque el invariante
vive literalmente en el objeto `where` de la clase que corre en prod).

### Unitarios

| # | Archivo | Qué |
|---|---|---|
| U1 | `financeDates.test.ts` | tabla completa de la Decisión 5. **Se reescribe `:86`** (ISO → `false`) dejando constancia de por qué: pineaba el bug |
| U2 | `mapGrReceipt.test.ts` | `anulado` derivado. **Se reescribe `:28`** (`toBe(false)` incondicional) |
| U3 | `GestionRealClient.receipts.test.ts` | **se reescribe `:101-112`**: de "excludes" a "**incluye** el recibo anulado y le lleva `fechaAnulacion` cruda". Se agrega: sus `aplicaciones`/`items`/`retenciones` siguen viniendo |
| U4 | `financeAnnulmentGuard.test.ts` (nuevo) | tabla de frontera: 0/100 no; 5/100 **no** (`>` estricto); 6/100 sí; 3/4 (75 %) **no** (piso `minCount`); `total=0` no; recibos anulados presentes pero bajo umbral ⇒ se escriben con `anulado: true` |
| U5 | `syncConfigNormalizer.test.ts` (nuevo) | tabla de basura → seguro de la Decisión 7, corrida contra **los dos** adapters |
| U6 | `SyncGrReceiptsReconcileWindow.test.ts` (nuevo) | ciclo de vida del cursor: primer barrido calcula ventana; paginado; ventana congelada cuando el reloj cruza medianoche a mitad de barrido; cierre a `null`; cadencia; cursor corrupto → recalcula; `reconcileEnabled=false` ⇒ cero llamadas a GR |

### Seam completo (payload crudo → parser REAL → use case REAL → repo in-memory)

Molde `finance-receipts-ingest-seam.test.ts` con `RawPayloadGestionRealPort` — ese es el
único arnés del repo que ejercita el viaje entero. **Todo test del anulado va acá**, no en
un unitario del mapper: el bug vivía justo en la juntura parser↔mapper que un unitario no
cruza.

| # | Escenario |
|---|---|
| S1 | payload con `fecha_anulacion: '20-06-2026 12:00:00'` ⇒ el recibo **está** en el repo (`rows.size === 1`) **y** `anulado === true`, con sus hijas persistidas |
| S2 | **el flip** (LA invariante del change): barrido 1 persiste el recibo sano (`anulado:false`); barrido 2 trae el MISMO `grReceiptId` con `fecha_anulacion` real ⇒ la MISMA fila pasa a `anulado:true`. Ejercita el bloque `update` del upsert |
| S3 | inverso: re-upsert sano de una fila sana ⇒ sigue `false` (no hay flip espurio) |
| S4 | **confirmado tarde** (el bug medido): recibo con `fecha_recibo` de hace 5 días ausente del espejo ⇒ tras un barrido del reconcile, está |
| S5 | **guard**: página con 63/100 en residuo ⇒ `execute()` tira, `receiptRepo.rows.size === 0` (**cero escrituras**), cursor sin avanzar, `lastResult` empieza con `error:`, y `scheduler.status.effectiveIntervalMs` sigue en el base (GR no fue culpado) |
| S6 | **arbitraje** con los TRES use cases reales + scheduler real sobre ~40 ticks: el delta gana siempre que está due; el reconcile toma turnos cuando el delta no; el backfill **sigue progresando**; con el delta envenenado (molde `PoisonedApplicationRepo`) F4 se mantiene |

### Dashboard

| # | Qué |
|---|---|
| D1-D4 | cuatro tests de `where` sobre las clases Prisma REALES: `where.receipt.anulado === false` en `listByMonth`/`listByClientAndMonth` × item/application |
| D5 | `BuildFinanceMonthlySnapshot.test.ts`: un recibo anulado con items **no** entra en la caja cobrada del mes, y sus aplicaciones no entran en `unclassifiedAmountArs`. Fixture con **al menos 2 recibos** (uno sano, uno anulado) y montos distintos — un fixture degenerado de un solo elemento deja sobrevivir al mutante "el filtro no filtra" |

### Revert-probes — un mutante, un test que lo mata

| Mutante | Probe que lo mata | Por qué no es un probe de ausencia |
|---|---|---|
| se restaura el `continue` del parser | **S1** | S1 asserta **PRESENCIA primero** (`rows.size === 1`) y recién después `anulado === true`. Un probe que solo dijera "no aparece en el portal" daría verde contra el mundo pre-fix, donde la fila nunca existió |
| `mapGrReceipt` vuelve a `anulado: false` | S1 + S2 + U2 | S2 exige el **flip** de una fila que YA existe sana ⇒ imposible de satisfacer sin la derivación |
| se borra el guard | **S5** | sin guard se escribirían 100 filas ⇒ falla `rows.size === 0`. Asserta la ausencia de escritura sobre un repo que el mismo test demostró que sabe escribir (S1) |
| `annulmentGuardMaxPct = 100` (guard inerte) | U5 (el normalizador lo rechaza) + S5 con config default | |
| se saca `anulado:false` de un lector del dashboard | D1-D4 (Prisma real) + D5 (caja del mes) | D5 mata también la variante "lo sacaron solo del gemelo in-memory" |
| `reconcileWindowDays = 0` (feature inerte) | U5 (cae a 35) + U6 (con `0` en DB el carril igual pide un rango real de 35 días) | |
| `isRealAnnulment` vuelve a fail-open | U1 (ISO → `true`, basura → `true`) | |
| el carril no queda cableado | pin de aridad `@ts-expect-error` + throw de constructor + S6 (el reconcile fue **invocado** y escribió su `SyncState`) | |
| el reconcile starvea al backfill | S6 (`backfillState.itemsSynced > 0` tras N ticks) | |

**Regla de la fix-wave**: cada fix se aplica a la **clase**, no a la instancia. Si se agrega
`anulado: false` a un lector, hay que revisar a sus tres hermanos **y a los gemelos
in-memory** en el mismo commit. Y para cada probe: *¿falla si revierto el fix?* Si no falla,
el probe no sirve.

**Contrafáctico**: antes de cerrar, correr S1/S2/S5/D5 contra el código **PRE-fix**. Deben
fallar TODOS. Un probe nuevo que pasa contra el mundo viejo no está probando el fix.

---

## Rollout

Orden deliberado: **primero el código (inerte en prod), después el catch-up, después la
verificación**. El código es inerte porque hoy hay **0 filas con `anulado = true`** — el
filtro del dashboard no cambia un solo número hasta que aparezca una anulación real.

### 0. Pre-flight (ANTES de disparar nada)

```sql
SELECT enabled, "requestIntervalMs", "deltaCheckIntervalMs", "backfillFloorYearMonth",
       "reconcileEnabled", "reconcileWindowDays", "reconcileCheckIntervalMs",
       "annulmentGuardMaxPct", "annulmentGuardMinCount"
FROM "FinanceReceiptSyncConfig";
```

⚠️ **`backfillFloorYearMonth` DEBE ser `2026-05`.** Verificado vivo el 2026-08-10, pero se
re-verifica igual: si está por debajo, el re-arm re-camina años (~330.000 recibos ≈ 18 h de
carril). Si no es `2026-05`, subirlo temporalmente (cero código) y bajarlo después.

### 1. Deploy

`prisma migrate deploy` + código. El carril arranca solo (default `true`). Verificar a los
~2 min:

```sql
SELECT entity, cursor, "lastResult", "lastRunAt", "itemsSynced"
FROM "SyncState" WHERE entity LIKE 'finance-receipts%';
```

Debe aparecer la fila `finance-receipts-reconcile` con `lastResult` de página o de barrido.

### 2. Catch-up (cero código)

1. `POST /api/finance/growth/sync/rearm-backfill` (permiso `finance:sync`).
2. Camina ago→jul→jun→may: ~20.000 recibos ≈ 200 páginas ≈ **67 min de carril**.
   Como el reconcile tiene prioridad sobre el backfill, un barrido de reconcile lo puede
   demorar hasta ~1,7× (≈ 2 h en total). **Se deja correr**: apagar el reconcile durante el
   catch-up es un paso manual que alguien se puede olvidar de revertir, y el catch-up
   subsume la ventana del reconcile de todos modos.
3. Monitorear con la query del paso 1 (`finance-receipts-backfill` avanzando de mes).

### 3. Verificación en vivo — el diff del 05-08 tiene que dar 0

```sql
-- (a) el día pico medido: GR dice 299, el espejo decía 197
SELECT count(*) FROM "FinancePaymentReceipt"
WHERE "fechaRecibo" >= '2026-08-05' AND "fechaRecibo" < '2026-08-06';
-- esperado: 299
```

```sql
-- (b) fixture de verificación: los 102 ids faltantes conocidos, uno por uno
SELECT count(*) FROM "FinancePaymentReceipt" WHERE "grReceiptId" IN ( … 102 ids … );
-- esperado: 102 — un conteo agregado que dé 299 por otro camino NO alcanza
```

```sql
-- (c) el faltante suelto del 01-07 (otro día, prueba que no era efecto de un solo día)
SELECT "grReceiptId", "fechaRecibo", "fechaConfirmacion"
FROM "FinancePaymentReceipt" WHERE "grReceiptId" = '345867';
-- esperado: 1 fila
```

```sql
-- (d) el espejo NO se volcó a anulado
SELECT count(*) FROM "FinancePaymentReceipt" WHERE anulado = true;
-- esperado: 0 (o un puñado con explicación; si son miles, el guard falló — ver rollback)
```

(b) es el que vale: (a) puede dar 299 con 102 filas equivocadas. Los 102 ids del probe del
2026-08-10 son el fixture de verificación y hay que dejarlos escritos en las tasks.

### 4. Snapshots

`POST /api/finance/growth/sync/backfill-snapshots` acotado a `2026-05..2026-08`, one-shot. Recién
después de que (b) dé 102. Verificación: la caja cobrada de `2026-08` **sube** respecto del
valor previo al catch-up (anotarlo ANTES de disparar; si no cambia, la plata reparada no
llegó al dashboard y algo está mal en la cadena).

### 5. Régimen

A las ~6 h del deploy debe haber corrido un barrido completo:
`lastResult = 'sweep ok …'`. Chequear en los logs `masViejoReparado`: si aparecen valores
`>= 32d` (borde de la ventana), **subir `reconcileWindowDays`** por SQL.

### Rollback

| Qué falla | Cómo se corta |
|---|---|
| el carril presiona a GR más de lo esperado | `UPDATE "FinanceReceiptSyncConfig" SET "reconcileEnabled" = false;` — efecto en el próximo tick, sin deploy |
| todo el ingest de recibos | `enabled = false` (kill-switch preexistente) |
| el espejo se volcó a `anulado = true` | el guard debería haberlo impedido. Si igual pasó: `reconcileEnabled=false` + `UPDATE "FinancePaymentReceipt" SET anulado=false WHERE …` acotado + re-barrido. **Es recuperable** — el espejo se reconstruye desde GR |
| parser/mapper/filtro del dashboard | NO son revertibles por config (son código). Mitigación: son inertes mientras no haya filas `anulado = true`, y el guard es lo que impide que las haya de golpe |

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| **El anulado no se puede validar contra un caso real** (0 en 2.821 recibos medidos) | Declarado defensivo. Se prueba el MECANISMO (S1/S2 con fixtures + revert-probes que exigen PRESENCIA antes de assertear exclusión), nunca el fenómeno. Queda escrito que no se validó en vivo |
| **La cola de confirmación está censurada a derecha**: 35 d puede quedar corto | La invariante "ventana ≥ ventana de rebuild de snapshots" acota el daño al caso que mueve el dashboard. `masViejoReparado` + WARN de borde (Decisión 9) la hacen **falsable**; el knob se sube por SQL |
| **Refactor de la ruta de persistencia** (Decisión 8) sobre la ruta de la plata | Los tests existentes de delta/backfill/seam son la red y deben pasar **sin modificarse**. Si hay que tocarlos, el refactor cambió comportamiento ⇒ parar |
| **Tocar el parser que ya borró facturas una vez** (FIX-1, 2026-08-04) | Solo el `continue` y el `fechaAnulacion: null`. El sobre de error intacto. F1/F2/F11/F12 quedan como red |
| **El reconcile starvea al backfill** durante un barrido largo | Prioridad + F4 espejado + invariante de dimensionamiento + WARN de duración. En régimen el backfill es un no-op |
| **El guard traba el carril ante una ráfaga LEGÍTIMA de anulaciones** | Es el trade-off elegido (fail-loud > plata fantasma). El piso `minCount` evita el caso de 1-2 anulaciones; el log trae la muestra cruda para decidir en 10 s; el knob se sube por SQL sin deploy |
| **`activeLane: 'reconcile'` rompe una etiqueta del FE** | Verificar `ipnext-frontend` en tasks. Aditivo, no rompe el contrato, pero un label vacío es feature a medio conectar |
| **`rearm-backfill` con el piso mal puesto** = 18 h de carril | Paso 0 del rollout, bloqueante |
| **Tests que pinean el bug** (`mapGrReceipt.test.ts:28`, `financeDates.test.ts:86`, `GestionRealClient.receipts.test.ts:101`) | Se reescriben con comentario explicando por qué; **jamás se borran en silencio** |
| **`updatedAt` churn** (~80.000 UPDATEs/día) | Medido y aceptado (Decisión 3.4). Nada lo lee. La palanca es la cadencia |

---

## Fuera de alcance (heredado del proposal, sin cambios)

- Tocar la ventana de solapamiento del delta.
- Campos nuevos en `PortalPaymentDto` (`id`, `status`, chip de "anulado").
- Revertir/borrar las `FinanceReceiptApplication` de un recibo anulado.
- Un tercer estado tipo `pending`/`unconfirmed` para recibos desaparecidos (0 medidos).
- Tocar el sobre de error de GR ni el guard de identidad `aplicaciones = items + retenciones`.
- Endpoint HTTP para `FinanceReceiptSyncConfig` (la perilla es SQL, ver Decisión 7).
- Rate limiter global entre features de GR.
