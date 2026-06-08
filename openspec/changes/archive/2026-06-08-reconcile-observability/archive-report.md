# Archive Report — reconcile-observability (#37)

**Archived**: 2026-06-08. Deployed (BE PR #84 + FE PR #57, both green). No migration. Multi-repo.

## Disparador
Investigando la discrepancia del #36 (4 OS cerradas pero clavadas = parte de las `failed=6` del reconcile), se descubrió que el `catch` de `BackfillClosedServiceOrders.reconcileOne` (línea ~92) **tragaba el error entero** (`catch {` sin bindear `err`), solo contaba `failed++`. Encontrar el por qué de un fallo requería arqueología manual (IClass API + DB de prod). Además, la página de Reconciliar (#35) no mostraba la cantidad de in-flight.

## Cambio (2 partes)
- **BE (observabilidad)**: el `catch` de `reconcileOne` bindea el error y loguea `[backfill] task <sequenceNumber> FAILED: <message>` antes de contar `failed`. Aislamiento intacto (no re-throw). Cubre el batch Y el 1x1 (`ReconcileTaskClosure`) que comparten `reconcileOne`.
- **FE**: la página de Reconciliar muestra un pill sutil `{n} en Registrado en IClass` al lado del título, tomado de `items.length` (la lista renderizada → no driftea). Oculto en lista vacía. impeccable (neutro tenue, el número con el peso; el acento indigo queda para las acciones).

## Ciclo SDD
propose → spec (design skippeado, trivial) → tasks → apply BE∥FE → verify (a mano: BE 2578/0 + tsc, FE 2004/0 + typecheck) → deploy. 6 scenarios.

## Archivos
BE: `BackfillClosedServiceOrders.ts` (catch) + test. FE: `InFlightTasksTable.tsx` + `.module.css` + test.

## Nota
El verify-agent del FE quedó esperando su propio full-suite (como en #35) → el orquestador confirmó las suites a mano antes de deployar. Patrón recurrente: verificar el trabajo del sub-agente antes de confiar.

## Efecto
La próxima vez que una tarea falle en el reconcile, el motivo sale en los logs (`[backfill] task X FAILED: ...`) — cero arqueología. Y el usuario ve la cantidad de in-flight directo en la página.
