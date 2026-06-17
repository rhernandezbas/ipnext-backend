# Tasks: PPPoE Enforcement (Fase C)

> TDD estricto. **Apply en worktree** `feat/pppoe-enforcement`, **encadenado sobre Fase B**
> (branch desde `feat/pppoe-management`). On-demand: SIN scheduler. UI = trabajo FE aparte (ver backlog).

## Pre-requisitos
- [ ] Worktree desde `feat/pppoe-management` (trae el adapter RouterOS validado + el modelo).
- [ ] Confirmar mapeo estado GR → acción: `late`→`reduce`, `baja`/incobrable→`block` (para `target='debtors'`).

## Modelo
- [ ] Migración aditiva: `enforcedState` en `PppoeService` (default `'active'`) + tabla `ServiceCutBatch` (id, action, status, total, doneCount, failedCount, result JSON, createdAt, finishedAt). SQL via `migrate diff` (sin DB local). Dry-run rolled-back vs prod.
- [ ] Entidad `pppoeService.ts`: + `enforcedState`. Entidad `ServiceCutBatch`.
- [ ] Port `ServiceCutBatchRepository` + adapter Prisma + in-memory. Extender `PppoeServiceRepository` para setear `enforcedState` (o usar upsert existente).

## Use cases (TDD: repo in-memory + InMemoryRouterGateway + InMemoryNasRepository)
- [ ] **(test primero)** `EnforcePppoeService` — `reduce`/`block`/`restore`; conserva `profile` comercial; kick; idempotente; router caído→502 sin mentir.
- [ ] **(test primero)** `PreviewEnforcement` — `{total, byRouter, sample}` SIN tocar router ni DB.
- [ ] **(test primero)** `RunBulkEnforcement` — agrupar por router (`mapWithConcurrency`, 1 carril/router + N en paralelo), throttle inyectable, best-effort (item falla→`failed`, sigue), backoff, progreso en `ServiceCutBatch`, resumible (no reprocesa hechos), `PgAdvisoryLock` (no doble batch).

## Infra
- [ ] `ServiceCutRunner` (fire-and-forget on-demand, molde `CancelTvJobRunner` + `PgAdvisoryLock`). **NO scheduler/cron.**
- [ ] Config `ROUTER_REDUCED_PROFILE` (default `IP-REDUCCION`) + env.example.

## HTTP + RBAC
- [ ] DTOs: `PppoeServiceDto` + `enforcedState` (sigue sin password); DTOs de preview/batch/progreso (zod).
- [ ] Rutas en `pppoe.routes.ts`: `POST /api/pppoe/:id/enforce`, `POST /api/pppoe/enforce/preview`, `POST /api/pppoe/enforce/bulk` (202+jobId), `GET /api/pppoe/enforce/bulk/:id`. Mapeo errores (502/404/422).
- [ ] Permiso `pppoe.cut`: catálogo RBAC + migración seed idempotente + expuesto al `/me`.
- [ ] Wiring `app.ts` + **composition test** (anti feature-muerta).

## Verificación
- [ ] `npm test` verde + `tsc --noEmit` limpio (orquestador corre el gate, no confía en sub-agentes).
- [ ] DIP: use cases no importan `node-routeros`/Prisma.
- [ ] **Dry-run contra router real**: `reduce`→`restore` de un secret de PRUEBA en un router (verificar profile cambia y vuelve, sesión sin tocar real).
- [ ] Dry-run migración (enforcedState + ServiceCutBatch + pppoe.cut) vs prod.

## Frontend (futuro, coordinado — ver backlog)
- [ ] Página de cortes PPPoE on-demand (preview + confirmación + progreso) con skill `impeccable`, patrón de páginas existentes, gate `pppoe.cut`.

## Salida de la fase
- [ ] Cortes individuales + masivos **on-demand** funcionando (preview→bulk→progreso). Épico `pppoe-service` (BE) COMPLETO → verify full + merge A+B+C a prod (push=prod, OK del usuario).
