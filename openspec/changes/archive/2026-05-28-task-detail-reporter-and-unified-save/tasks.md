# Tasks: Reporter on Create + Unified Save in Task Detail

> Strict TDD activo: cada bloque RED → GREEN → (REFACTOR si aplica). FE vive en repo aparte (`ipnext-frontend`) — sus tareas se trazan acá igual.

## Phase 1: Backend — Reporter on Create (repo: ipnext-backend) ✅

- [x] 1.1 RED — `sessionAdminLookup = new StubLookup('admin-1')` introducido; `buildApp` y `buildEnrichedApp` default + el test ad-hoc de REQ-STAGE-DEFAULT-1 pasaron a usarlo; 2 tests FK-error (assignee/watcher ghost) ajustados a `StubLookup('admin-1')` explícito.
- [x] 1.2 RED — Test REQ-CREATE-9 + 9b (null explícito) agregados; fallaban (null !== 'admin-1').
- [x] 1.3 RED — Test REQ-CREATE-10 agregado; pasa trivialmente con el código viejo (body explícito ya gana), queda como guard de regresión.
- [x] 1.4 RED — Test REQ-CREATE-11 agregado; fallaba (devolvía 201, esperaba 404).
- [x] 1.5 GREEN — `scheduling.routes.ts` POST `/`: `reporterId: data.reporterId ?? req.user?.id ?? null`.
- [x] 1.6 VERIFY — Suite BE completa: 1055/1055 verde (9 skipped pre-existentes). `tsc --noEmit` sin errores. Tests del route: 71/71 (67 + 4 nuevos).

## Phase 2: Frontend — Single Save (repo: ipnext-frontend, page detalle) ✅

- [x] 2.1 RED — `DescriptionEditor.test.tsx` reescrito: nueva API `onChange(html, isDirty)`, sin botón propio. 4 fails RED confirmados.
- [x] 2.2 GREEN — `DescriptionEditor.tsx` refactor a controlled: removido `handleSave`/botón/`saveStatus`; conservado TipTap; `applyTaskVariables` movido al unified save del page padre.
- [x] 2.3 RED — `SchedulingTaskDetailPage.test.tsx`: mock de `TaskTabs` expone `desc-change-btn`; nuevo test "unified save: edit description + datos submit → 1 updateTask con ambos"; nuevo test "datos sin edit description no manda field description".
- [x] 2.4/2.5 GREEN — `SchedulingTaskDetailPage.tsx`: lift `descriptionHtml` a state; `handleDescChange`; `handleFormSubmit` incluye `description` SÓLO si `descDirty`, con `applyTaskVariables` aplicado. `TaskDetailsTab.tsx`: prop `descriptionEditor.onChange` (sin `onSave`/`isSaving`). `TaskTabs.test.tsx` ajustado.
- [x] 2.6 VERIFY — Suite FE completa: 1141/1141 verde (+9 net vs baseline 1132). Sin regresiones.

## Phase 3: Frontend — Reporter Column (repo: ipnext-frontend, page lista) ✅

- [x] 3.1 RED — `TasksTableView.reporterColumn.test.tsx` nuevo: 4 tests (nombre resuelto, fallback `—` para null, fallback `—` para id desconocido sin leak del uuid, columnheader "Reporter"). 4 fails RED confirmados.
- [x] 3.2 GREEN — `TasksTableView.tsx`: prop `admins?: Admin[]`, entrada en `ALL_TASK_COLUMNS` ({key:'reporterName', label:'Reporter'}) con render que resuelve `admins.find(a => a.id === t.reporterId)?.name ?? '—'`. Import de `Admin`. 4/4 verde.
- [x] 3.3 GREEN — `SchedulingTasksPage/index.tsx`: `admins={technicians}` agregado al render de `TasksTableView`. (DEFAULT_VISIBLE_COLUMNS ya espeja `ALL_TASK_COLUMNS.map(c => c.key)` — la columna nueva entra al default automáticamente.)
- [x] 3.4 VERIFY — Suite FE 1145/1145 verde (+4 vs P2 1141). Sin regresiones.

## Phase 4: Commit, Deploy, Verify ✅

- [x] 4.1 BE — Commit `bb0d1cbe feat(scheduling): default reporter to authenticated user on task create` (route + test + carpeta SDD).
- [x] 4.2 BE — Push con gate del usuario. Deploy verificado. Tarea #4501 creada en prod con reporterId populado por el BE.
- [x] 4.3 FE — Commit `a1e35cc feat(scheduling): unified save in task detail + Reporter column in tasks list`. Más 4 follow-up fixes (`7bd1ed5` backfill localStorage, `fdcafbd` error toast, `12a6589` "" → null, `a4cce51` useAdmins para columna Reporter).
- [x] 4.4 FE — Push con gate. Playwright verificó: (a) detalle un solo botón guarda descripción + Datos en una llamada, (b) lista muestra columna Reporter populada para tareas nuevas, (c) tareas viejas con "—" como esperado.

## Phase 5: SDD Close ✅

- [x] 5.1 `sdd-verify` ejecutado — Verdict PASS (0 CRITICAL / 0 WARNING / 2 SUGGESTION no-bloqueantes).
- [x] 5.2 `sdd-archive` ejecutado (este paso) — REQ-CREATE-9/10/11 sincronizados al main spec; carpeta movida a `openspec/changes/archive/2026-05-28-task-detail-reporter-and-unified-save/`.
