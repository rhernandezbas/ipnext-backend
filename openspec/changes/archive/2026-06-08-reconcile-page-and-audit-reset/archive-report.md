# Archive Report — reconcile-page-and-audit-reset (#35)

**Archived**: 2026-06-08. Deployed to prod. No remaining work.

## Disparador
Tras deployar el #34 (map-reduce), correr el reprocess NO rescataba las OS que degeneraban — ya habían quemado sus 3 `auditAttempts` pre-#34 → `listPendingSideEffects` las excluye → el #34 nunca corría en ellas. Además, el usuario pidió control fino sobre el "Reconciliar" (que era todo-o-nada).

## Parte 1 — Reset de auditAttempts (SHIPPED, BE PR #81)
Migración data-only `20260610000000_reset_burned_audit_attempts`: `UPDATE "IClassServiceOrder" SET "auditAttempts"=0 WHERE "auditDone"=false AND "auditAttempts">=3`. Espeja el reset de `auditDone` del #20. Idempotente, sin cambio de schema. Re-incluye las OS rendidas → el próximo reprocess las re-audita con el map-reduce del #34. **Aplicó en prod** (deploy verde, "All migrations successfully applied").

## Parte 2 — Página de Reconciliar 1x1/batch (SHIPPED, BE PR #82 + FE PR #56)
Capability nueva `iclass-closure-reconcile`.
- **BE**: extraído `reconcileOne(task, begin, now, counts)` de `BackfillClosedServiceOrders` (el batch ahora delega — byte-idéntico, test de paridad) + `computeWindow()` para compartir la ventana sin exponer privates. `ReconcileTaskClosure(taskId)` síncrono 200 (`getTask` → `TaskNotFoundError`→404 → `reconcileOne` una vez → counts). `ListInFlightTasks` → `InFlightTaskDto`. Rutas `GET /closure/in-flight` (200 list) + `POST /closure/reconcile/:taskId` (200 sync), gate `iclass.manage`. El batch sigue `POST /closure/backfill` (202).
- **FE**: página `/admin/scheduling/iclass/closure/reconcile` (gate `iclass.manage`, lazy) con lista de las "Registrado en IClass", botón Reconciliar **por fila (1x1)** + "Reconciliar todas" (batch). La lista se refresca tras reconciliar (las cerradas salen del stage → desaparecen). OS sin cierre reciente (>29 días) → "no se encontró cierre reciente". Hooks `useInFlightTasks` + `useReconcileTask`. impeccable.

## Ciclo SDD
Part 1 fast-tracked (migración standalone). Part 2: explore → propose → spec ∥ design → tasks → apply BE∥FE → verify → deploy. BE suite 2553/0, FE 2002/0, ambos typechecks limpios. 15/15 scenarios.

## Desviaciones (aceptables)
- BE: `computeWindow()` helper en vez de exponer `lookbackDays`/`now` privates.
- FE: `InFlightTask` omite `customerCode` (no es columna de la página; el BE DTO igual lo lleva).
- El verify-agent quedó en loop de polling sin veredicto limpio → el orquestador confirmó las suites a mano (BE 62/62 targeted + tsc, FE 57/57 targeted + typecheck) antes de deployar.

## Efecto en prod
Parte 1 destrabó la auditoría (las degeneradas vuelven a ser pendientes → #34 las rescata). Parte 2 da control fino: reconciliar 1x1 o batch desde una página, viendo cuáles faltan.
