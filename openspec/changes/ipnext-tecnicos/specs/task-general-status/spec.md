# Delta for task-general-status (Wave 1a)

Contexto verificado en código: HOY hay CUATRO escritores independientes de `generalStatus='closed'`, ninguno atómico (todos hacen `getTask` → chequeo en memoria → `updateTask`, sin `WHERE` de concurrencia):
1. `SetTaskGeneralStatus.ts:34` (endpoint staff dedicado, D8 idempotente por VALOR, no por origen)
2. `UpdateTask.ts:34` (compat legacy `isClosed`)
3. `IngestClosedServiceOrders.ts:379-380` (ingest automático IClass)
4. `CloseIClassServiceOrder.ts:101` (acción staff "cerrar desde Prominense", que además empuja a IClass)

Ninguno chequea `generalStatus !== 'closed'` de forma atómica (TOCTOU real entre el `getTask` y el `updateTask`) ni registra QUIÉN cerró. Con la app de técnicos entra un 5° escritor (`app`, wave 1b). Esta wave arregla la atomicidad para TODOS, no solo para el nuevo.

`closureOrigin` NO EXISTE hoy en `ScheduledTask` (`schema.prisma:1346-1460` revisado completo — confirmado ausente). Es un campo NUEVO.

## MODIFIED Requirements

### Requirement: ScheduledTask includes generalStatus, isClosed and closureOrigin

Every `ScheduledTask` response MUST include:

```ts
interface ScheduledTask {
  // ... existing fields
  generalStatus: 'open' | 'closed' | 'dismissed';  // existente
  isClosed: boolean;  // existente, derivado: generalStatus === 'closed'
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';  // Deprecated
  closureOrigin: 'app' | 'iclass' | 'staff' | null;  // NUEVO — null mientras generalStatus !== 'closed'
}
```

A nivel de columna (`schema.prisma`), `closureOrigin` es `String?` — NO un enum de Prisma — **nullable y SIN default a nivel de schema** (`closureOrigin String?`), siguiendo el mismo criterio que `generalStatus`/`priority`/`category` para el tipo (catálogos que pueden crecer; un cuarto origen como `'gr'` es plausible a futuro). Un default de columna sería incorrecto: le pondría un origen a toda tarea insertada, incluidas las abiertas, violando el propio invariante de esta sección. La escribe únicamente la escritura atómica (`closeTaskIfOpen`), y toda transición a un `generalStatus` distinto de `'closed'` la vuelve a `null`. El tipo CERRADO (`'app' | 'iclass' | 'staff'`) vive en TypeScript, que es donde el compilador lo exige. Las tareas cerradas ANTES de esta migración quedan con `closureOrigin=null` — no hay backfill retroactivo (rellenar con un origen inventado falsearía la auditoría).

(Previously: shape no incluía `closureOrigin` — no existía forma de saber QUIÉN cerró una tarea.)

**Scenario: Response shape includes closureOrigin**

- GIVEN any authenticated request that returns a `ScheduledTask`
- WHEN the response is received
- THEN `generalStatus` MUST be one of `'open' | 'closed' | 'dismissed'`
- AND `isClosed` MUST equal `generalStatus === 'closed'`
- AND `closureOrigin` MUST be `null` unless `generalStatus === 'closed'`

**Scenario: Open task has null closureOrigin**

- GIVEN task `t-1` with `generalStatus='open'`
- WHEN its DTO is read
- THEN `closureOrigin` is `null`

## ADDED Requirements

### Requirement: Closing generalStatus is atomic across ALL writers

El sistema DEBE (MUST) que TODO camino que cierre una tarea (`SetTaskGeneralStatus`, `UpdateTask` legacy, `IngestClosedServiceOrders`, `CloseIClassServiceOrder`, y el nuevo cierre de la app técnico) use una escritura condicional atómica equivalente a `UPDATE ... WHERE id = :id AND generalStatus != 'closed'` (un `updateMany`/`UPDATE` con predicado en la MISMA sentencia, no un `getTask` + `updateTask` separados) al setear `generalStatus='closed'`.

El sistema DEBE (MUST) que la escritura atómica setee `closureOrigin` (`'app' | 'iclass' | 'staff'`) en la MISMA operación que cierra.

El sistema NO DEBE (MUST NOT) permitir que un segundo escritor concurrente sobreescriba `generalStatus`/`closureOrigin` ya fijados por el primero que ganó la carrera (first-writer-wins).

#### Scenario: Two concurrent closers — only the first wins
- GIVEN task `t-1` con `generalStatus='open'`
- AND dos escritores (`app` e `iclass`) intentan cerrarla EN PARALELO, casi al mismo instante
- WHEN ambas escrituras corren
- THEN exactamente UNA logra la transición (la que ejecuta el `UPDATE` primero)
- AND `t-1.generalStatus` queda `'closed'` con el `closureOrigin` del que ganó
- AND el segundo escritor detecta 0 filas afectadas y NO pisa el resultado

#### Scenario: Preexisting staff↔ingest race is closed by the same guard
- GIVEN un operador mueve `t-1` a un stage `hecho` (`IngestClosedServiceOrders.ts:379`) casi simultáneo a que `CloseIClassServiceOrder` cierre la misma tarea desde el panel (`CloseIClassServiceOrder.ts:101`)
- WHEN ambas rutas corren
- THEN el mismo guard atómico decide un único ganador, igual que en el escenario app↔iclass — ya no hay un camino "menos protegido" entre los escritores preexistentes

#### Scenario: Idempotent no-op stays a no-op under the new guard
- GIVEN task `t-1` ya `generalStatus='closed'`
- WHEN `SetTaskGeneralStatus` recibe `{ status: 'closed' }` de nuevo
- THEN no hay escritura (D8 preexistente), sin evento nuevo, `closureOrigin` no cambia

### Requirement: A result-code discrepancy across origins is logged, never silently dropped

Cuando dos orígenes distintos aportan un resultado de cierre para la MISMA tarea (p. ej. el técnico cerró con `resultCode='A'` vía app y luego `IngestClosedServiceOrders` trae de IClass `resultCodeName='B'` para la misma SO), el sistema DEBE (MUST) registrar la discrepancia en DOS lugares — nunca sobreescribir en silencio el resultado ya persistido por el ganador de la carrera:

1. Un log estructurado en un ÚNICO punto (el helper de aplicación que envuelve `closeTaskIfOpen`, no repetido en cada uno de los 5 escritores): `[task-closure-conflict] task=<id> winner=<origin>/<resultCode> loser=<origin>/<resultCode> at=<iso>`.
2. Un `ScheduledTaskActivity` tipo `closure_conflict` (tabla append-only ya existente) con `metadata: { winnerOrigin, winnerResultCode, loserOrigin, loserResultCode }` — así la discrepancia queda CONSULTABLE, no solo un log que rota.

Ambos se emiten ÚNICAMENTE cuando el `resultCode` del perdedor DIFIERE del ganador — un cierre duplicado con el MISMO resultado no es una discrepancia, es idempotencia, y no genera ni log ni activity.

Precisión de "DIFIERE" (fix wave, FIX-4 — sin esto la regla generaba ruido que enterraba las discrepancias reales):

- Si el PERDEDOR no aporta `resultCode` (`null`), NO hay discrepancia. No trajo un resultado que pueda contradecir a nadie; es el caso cotidiano del staff cerrando a mano desde el panel (los dos caminos de staff siempre pasan `null`).
- Con AMBOS `resultCode` no nulos, la comparación es NORMALIZADA (trim + minúsculas + puntuación final + espacios internos colapsados: el mismo `normalizeResultCode` que ya usa el resolver de códigos del ingest). IClass devuelve el mismo código con variaciones cosméticas y eso NO es una discrepancia.
- Si la tarea NO EXISTE, no hay ni log ni activity: no hay ganador cuyo resultado contradecir.
- Un perdedor CON código sobre un ganador SIN código SÍ es discrepancia.
- El ingest la registra sólo en la PRIMERA transición de la OS a cerrada; los reprocesos por bump de `iclassUpdatedAt` sobre una OS ya espejada no la repiten.

#### Scenario: Later IClass result differs from the app's — logged and recorded as an activity, not applied
- GIVEN `t-1` fue cerrada por `app` con `resultCode='INSTALACION_OK'` (`closureOrigin='app'`)
- AND más tarde `IngestClosedServiceOrders` procesa la SO ligada y trae `resultCodeName='REAGENDADO'` de IClass
- WHEN el ingest corre
- THEN se registra un log de discrepancia con ambos valores
- AND se crea un `ScheduledTaskActivity` tipo `closure_conflict` con `metadata: { winnerOrigin: 'app', winnerResultCode: 'INSTALACION_OK', loserOrigin: 'iclass', loserResultCode: 'REAGENDADO' }`
- AND `t-1.generalStatus`/`closureOrigin`/el resultado ya persistido NO cambian

#### Scenario: Matching result codes across origins — no discrepancy logged, no activity created
- GIVEN `t-1` cerrada por `app` con `resultCode='INSTALACION_OK'`
- AND IClass reporta el mismo `resultCodeName='INSTALACION_OK'` para la SO ligada
- WHEN el ingest corre
- THEN no se registra discrepancia
- AND no se crea ningún `ScheduledTaskActivity` tipo `closure_conflict`

## Aditivo, solo-crece
`closureOrigin` es NUEVO y nullable — tareas cerradas ANTES de esta wave quedan con `closureOrigin=null` (no hay backfill retroactivo del origen histórico, ese dato no existe). El guard atómico es un cambio de IMPLEMENTACIÓN de los 4 escritores existentes, no de su contrato HTTP externo — `POST /api/scheduling/:id/status` sigue aceptando el mismo body.
