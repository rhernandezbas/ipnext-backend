# Tasks: PPPoE Enforcement (Fase C)

> TDD estricto. **Apply en worktree** `feat/pppoe-enforcement`, **encadenado sobre Fase B**
> (branch desde `feat/pppoe-management`). On-demand: SIN scheduler. UI = trabajo FE aparte (ver backlog).
>
> **Estado: APPLY COMPLETO** (2026-06-17). Loop EPIC #38 corrido: codear → verify (tsc+suite) →
> review adversarial 3 focos opus → fix wave (7 fixes) → re-review CLEAN. Pendiente: dry-runs pre-merge.

## Pre-requisitos
- [x] Worktree desde `feat/pppoe-management` (trae el adapter RouterOS validado + el modelo).
- [x] Confirmar mapeo estado GR → acción: `late`→`reduce`, `baja`/incobrable→`block` (confirmado por el usuario).

## Modelo
- [x] Migración aditiva: `enforcedState` en `PppoeService` (default `'active'`) + tabla `ServiceCutBatch` (id, action, status, total, doneCount, failedCount, result JSON, createdAt, finishedAt). SQL via `migrate diff` (sin DB local). → `20260731000000_pppoe_enforcement_model`.
- [x] Entidad `pppoeService.ts`: + `enforcedState` + `EnforcementAction` + `enforcedStateForAction`. Entidad `serviceCutBatch.ts`.
- [x] Port `ServiceCutBatchRepository` + adapter Prisma + in-memory. `PppoeServiceRepository`: + `setEnforcedState` + `listByClientStatus` (resolver de deudores via JOIN pppoe→contract→client).

## Use cases (TDD: repo in-memory + InMemoryRouterGateway + InMemoryNasRepository)
- [x] **`EnforcePppoeService`** — `reduce`/`block`/`restore`; conserva `profile` comercial; kick; idempotente; router caído→502 sin mentir. `restore` RESPETA la baja comercial (status=disabled no se re-habilita) y no manda profile vacío. (9 tests)
- [x] **`PreviewEnforcement`** — `{total, byRouter, sample, pppoeIds}` SIN tocar router ni DB (no recibe gateway). (4 tests)
- [x] **`RunBulkEnforcement`** — agrupar por router (`mapWithConcurrency`, 1 carril/router + N en paralelo), throttle inyectable, best-effort (item falla→`failed`, sigue), progreso COALESCED+SERIAL+best-effort (sin race ni O(n²)), resumible (idempotencia no reprocesa), persistido en `ServiceCutBatch`. (7 tests)

## Infra
- [x] `ServiceCutRunner` (fire-and-forget on-demand, molde `CancelTvJobRunner` + `DistributedLock`/`PgAdvisoryLock`, release defensivo). **NO scheduler/cron.** (4 tests)
- [x] Config `ROUTER_REDUCED_PROFILE` (default `IP-REDUCCION`) + `ROUTER_BULK_THROTTLE_MS` + `ROUTER_BULK_CONCURRENCY` + env.example.

## HTTP + RBAC
- [x] DTOs: `PppoeServiceDto` + `enforcedState` (sigue sin password); `ServiceCutBatchDto` + zod (`EnforcePppoeBodySchema`, `EnforceBulkBodySchema`).
- [x] Rutas en `pppoe.routes.ts`: `POST /api/pppoe/:id/enforce`, `POST /api/pppoe/enforce/preview`, `POST /api/pppoe/enforce/bulk` (202+jobId), `GET /api/pppoe/enforce/bulk/:id`. Mapeo errores (502/404/422/409). Auth STATEFUL (sessionRepo). (route tests)
- [x] Permiso `pppoe.cut`: catálogo RBAC (`KNOWN_ACTIONS`) + migración seed idempotente `20260731010000` + expuesto al `/me` (data-driven via ResolveUserPermissions).
- [x] Wiring `app.ts` + **composition test** ampliado (anti feature-muerta: use cases + runner + PgAdvisoryLock + auth stateful pineados).

## Verificación
- [x] `npm test` verde (4610/0) + `tsc --noEmit` limpio (orquestador corre el gate, no confía en sub-agentes).
- [x] DIP: use cases no importan `node-routeros`/Prisma.
- [ ] **Dry-run contra router real**: `reduce`→`restore` de un secret de PRUEBA en un router (verificar profile cambia y vuelve). ← PRE-MERGE.
- [ ] Dry-run migración (`20260731000000` + `20260731010000`) vs prod. ← PRE-MERGE.

## Limitaciones conocidas (documentadas, no bloqueantes — ver design.md)
- Drift router/DB: el no-op idempotente no re-aplica si el router fue cambiado por fuera (DB = fuente de verdad).
- Batch huérfano: si el container muere a mitad, la fila queda `running` (el lock se libera; re-correr es idempotente). Sin auto-resume/reaper (v1).
- `PgAdvisoryLock`: ventana de reconexión (<60s, pre-existente del adapter compartido).

## Frontend (futuro, coordinado — ver backlog)
- [ ] Página de cortes PPPoE on-demand (preview + confirmación + progreso) con skill `impeccable`, gate `pppoe.cut`.

## Salida de la fase
- [x] Cortes individuales + masivos **on-demand** implementados (preview→bulk→progreso). Apply COMPLETO + gate verde + review CLEAN.
- [ ] Épico `pppoe-service` (BE) → verify full + dry-runs + merge A+B+C a prod (push=prod, OK del usuario). ← PRE-MERGE.
