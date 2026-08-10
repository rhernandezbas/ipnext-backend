# W1a — matriz de cumplimiento del spec `task-general-status`

Artefacto de la tarea **W1a.18** (que estaba tildada sin entregable) + **FIX-9(e)** de la
fix wave. Mapea **cada scenario del spec delta** a los tests que lo prueban, con archivo y
nombre exacto, para que "cumple el spec" sea verificable y no una afirmación.

Spec: `openspec/changes/ipnext-tecnicos/specs/task-general-status/spec.md`
Diseño: `openspec/changes/ipnext-tecnicos/design.md`
Rama: `fix/task-close-atomic`

**El spec tiene 7 scenarios reales**, no 8 como decía `design.md` (desvío ya reportado en
el commit del apply). Los 7 están cubiertos.

---

## Requirement: ScheduledTask includes generalStatus, isClosed and closureOrigin (MODIFIED)

### 1. Scenario: Response shape includes closureOrigin

| | |
|---|---|
| **Estado** | ✅ cubierto |
| **Test principal** | `src/__tests__/infrastructure/PrismaSchedulingRepository.toTask.closureOrigin.test.ts` → `Scenario: Response shape includes closureOrigin — a closed row carries origin=%s VERBATIM (no constant, no default)` (`it.each` sobre `app` / `iclass` / `staff`) |
| **Refuerzos** | mismo archivo → `the three origins produce three DIFFERENT DTOs (a constant mapper would collapse them)`; `legacy row (closed BEFORE this migration): NO closureOrigin key → null, never undefined` |
| **Invariante "null salvo closed"** | Lo garantiza el camino de ESCRITURA, no el mapper: `src/__tests__/infrastructure/PrismaSchedulingRepository.reopenClearsClosure.test.ts` + `src/__tests__/infrastructure/InMemorySchedulingRepository.reopenClearsClosure.test.ts` (FIX-1) |
| **Nota fix wave** | La versión original de este test era tautológica (metía `null`, asserteaba `null`). Reescrita con fixtures discriminantes. |

### 2. Scenario: Open task has null closureOrigin

| | |
|---|---|
| **Estado** | ✅ cubierto |
| **Test** | `src/__tests__/infrastructure/PrismaSchedulingRepository.toTask.closureOrigin.test.ts` → `Scenario: Open task has null closureOrigin — and the open DTO differs from a closed one` |
| **Refuerzo (creación)** | `src/__tests__/application/closurePlumbing.test.ts` → `seedTask abierta NO puebla closureDetails` |
| **Refuerzo (reapertura)** | `src/__tests__/application/reopenClearsClosure.test.ts` → `SetTaskGeneralStatus closed → open: closureOrigin null + detalles borrados + status_changed` |

---

## Requirement: Closing generalStatus is atomic across ALL writers (ADDED)

### 3. Scenario: Two concurrent closers — only the first wins

| | |
|---|---|
| **Estado** | ✅ cubierto |
| **Test** | `src/__tests__/infrastructure/InMemorySchedulingRepository.closeTaskIfOpen.test.ts` → `two concurrent closers (app vs iclass) — exactly one wins, the other sees the winner` |
| **Adapter Prisma** | `src/__tests__/infrastructure/PrismaSchedulingRepository.closeTaskIfOpen.test.ts` → `count===1 → won: …` y `count===0 → lost: … with the WINNER origin/resultCode` (asserta el `where: { id, generalStatus: { not: 'closed' } }`) |
| **"en la MISMA operación"** | `InMemorySchedulingRepository.closeTaskIfOpen.test.ts` → `winner writes generalStatus=closed, isClosed=true and closureOrigin in the SAME operation` |
| **Una unidad de trabajo (FIX-5)** | `PrismaSchedulingRepository.closeTaskIfOpen.test.ts` → `runs the guard AND the re-read inside ONE $transaction, on the tx client` |
| **Revert-probe** | Revertir `closeTaskIfOpen` a `getTask` + `updateTask` pone en rojo el test de concurrencia (dos ganadores) — ejecutado en el apply (W1a.17) |

### 4. Scenario: Preexisting staff↔ingest race is closed by the same guard

| | |
|---|---|
| **Estado** | ✅ cubierto |
| **Test** | `src/__tests__/application/IngestClosedServiceOrders.closedByFlow.test.ts` → `wave-1a: staff already closed the task with a DIFFERENT resultCode moments before this ingest run — cron does NOT overwrite, logs closure_conflict` |
| **Contraparte CloseIClassServiceOrder** | `src/__tests__/application/closurePlumbing.test.ts` → `como PERDEDOR: el resultCode viaja como loserResultCode al closure_conflict` |
| **Garantía estructural** | `src/__tests__/staticSource/taskClosureGuard.test.ts` — ningún `updateTask(...)` ni escritura directa a Prisma cierra por fuera del guard (endurecido en FIX-7: cubre `isClosed:true`, parseo balanceado y los call sites de `prisma.scheduledTask.update`) |

### 5. Scenario: Idempotent no-op stays a no-op under the new guard

| | |
|---|---|
| **Estado** | ✅ cubierto |
| **Test principal** | `src/__tests__/application/closureIdempotency.test.ts` → `segundo POST {status:closed} → mismo closureOrigin, mismo closedAt, mismo closedByUserId, sin eventos nuevos` |
| **Con ganador iclass** | mismo archivo → `re-cerrar una tarea que ganó IClASS tampoco reescribe el origen` |
| **D8 clásico** | `src/__tests__/application/SetTaskGeneralStatus.test.ts` → `no-op when status is unchanged → no activity event (D8)` |
| **A nivel repo** | `src/__tests__/infrastructure/InMemorySchedulingRepository.closeTaskIfOpen.test.ts` → `closing an already-closed task is a no-op: closed=false, existingOrigin of the previous winner, no double write` |

---

## Requirement: A result-code discrepancy across origins is logged, never silently dropped (ADDED)

### 6. Scenario: Later IClass result differs from the app's — logged and recorded as an activity, not applied

| | |
|---|---|
| **Estado** | ✅ cubierto |
| **Test** | `src/__tests__/application/applyTaskClosure.test.ts` → `loser with a DIFFERENT resultCode — logs [task-closure-conflict] + emits closure_conflict activity with both values` (asserta el `metadata` completo) |
| **End-to-end por el ingest** | `src/__tests__/application/IngestClosedServiceOrders.closedByFlow.test.ts` → `wave-1a: staff already closed the task with a DIFFERENT resultCode …` |
| **"no se aplica"** | mismo test: `expect(task!.closureOrigin).toBe('staff')` tras la corrida del cron |
| **El recorder existe en PROD** | `src/__tests__/staticSource/closureRecorderWiring.test.ts` (FIX-2) — sin esto la activity sólo existía en los tests |
| **Códigos realmente distintos** | `src/__tests__/application/applyTaskClosure.conflictSemantics.test.ts` → `CONTRASTE: códigos realmente distintos SIGUEN siendo conflicto …` |

### 7. Scenario: Matching result codes across origins — no discrepancy logged, no activity created

| | |
|---|---|
| **Estado** | ✅ cubierto |
| **Test** | `src/__tests__/application/applyTaskClosure.test.ts` → `loser with the SAME resultCode — idempotent duplicate: no log, no activity` |
| **Variaciones cosméticas (FIX-4b)** | `src/__tests__/application/applyTaskClosure.conflictSemantics.test.ts` → `it.each`: `case + punto final`, `espacios extremos`, `espacios internos colapsados` |
| **Perdedor sin código (FIX-4a)** | mismo archivo → `staff cierra a mano (resultCode null) una tarea que iclass ya cerró → sin log, sin activity` |
| **Tarea inexistente (FIX-4c)** | mismo archivo → `closeTaskIfOpen sobre un id que no existe → closed=false, task=null, silencio total` |
| **Una sola vez por OS (FIX-4d)** | `src/__tests__/application/IngestClosedServiceOrders.conflictOnce.test.ts` → `un bump de iclassUpdatedAt sobre una OS ya espejada NO vuelve a registrar el conflicto` |

---

## Cobertura que EXCEDE al spec (deuda arreglada en la fix wave)

Estos no salen de un scenario del spec, pero son invariantes que el spec asume:

| Invariante | Test | Fix |
|---|---|---|
| Reabrir limpia los 4 campos de cierre (repo, ambos adapters) | `PrismaSchedulingRepository.reopenClearsClosure.test.ts`, `InMemorySchedulingRepository.reopenClearsClosure.test.ts` | FIX-1 |
| Reabrir limpia los 4 campos (use case + vía legacy `isClosed:false`) | `src/__tests__/application/reopenClearsClosure.test.ts` | FIX-1 |
| El recorder llega a los 3 cron/backfill | `src/__tests__/staticSource/closureRecorderWiring.test.ts` | FIX-2 |
| `UpdateTask` no cierra y después responde 404 | `src/__tests__/application/UpdateTask.closureOrder.test.ts` | FIX-3 |
| `closedAt` / `closedByUserId` / `resultCode` — por escritor | `src/__tests__/application/closurePlumbing.test.ts` | FIX-6 |
| Los helpers in-memory no mienten (`seedTask` cerrada, `deleteTask`) | `src/__tests__/application/closurePlumbing.test.ts` | FIX-6 / LOW-3 |
| El guard estático caza `isClosed:true`, paréntesis anidados y escrituras directas a Prisma | `src/__tests__/staticSource/taskClosureGuard.test.ts` | FIX-7 |
| `dismissed`: comportamiento del predicado, pineado y documentado | `src/__tests__/infrastructure/closeTaskIfOpen.dismissed.test.ts` | FIX-8 |
| `UpdateTask` strippea `generalStatus`/`isClosed` del rest | `src/__tests__/application/closureIdempotency.test.ts` | FIX-9(d) |

## Fuera de alcance de W1a (verificado, no arreglado)

- **El push a IClass no tiene fence** (AD-2): dos operadoras pueden pushear el cierre de la
  misma OS con resultados distintos. El guard atómico cierra la ventana LOCAL únicamente.
  Documentado en el docstring de `CloseIClassServiceOrder` (FIX-9b).
- **`CloseTaskFromField`** (wave 1b) todavía no existe; su obligación de pre-chequear
  `dismissed` quedó anotada en `design.md` y en el docstring del port (FIX-8).
