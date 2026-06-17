# Tasks: PPPoE Management (Fase B)

> TDD estricto (test primero). **Apply en worktree** `feat/pppoe-management`, **encadenado sobre Fase A**
> (branch desde `feat/pppoe-foundation`, o tras mergear A a main). Cross-repo: la UI es trabajo FE aparte.

## Pre-requisitos
- [ ] Definir encadenamiento: worktree desde `feat/pppoe-foundation` (que trae el modelo `PppoeService`) o mergear A a main primero.
- [ ] Credenciales del user `prominense` cargadas server-side (`ROUTER_API_USER`/`ROUTER_API_PASSWORD`).
- [ ] Acceso Sur `10.64.10.2`: documentado que NO aprovisiona hasta resolver la ruta.

## Adapter RouterOS (base compartida con Fase C)
- [ ] Port `src/domain/ports/PppoeRouterGateway.ts` (`listSecrets`/`createSecret`/`updateSecret`/`removeSecret`; declarar `listActiveSessions`/`removeActiveSession` para C).
- [ ] Errores de dominio: `RouterUnreachableError`, `PppoeUsernameTakenError` (+ los de not-found).
- [ ] **(test primero)** `InMemoryRouterGateway` (fake, store por nas) + tests.
- [ ] `RouterOsGateway` (node-routeros): conexión por `NasTarget`, credenciales server-side, timeout, traducción de error → `RouterUnreachableError`.
- [ ] `node-routeros`: de `devDependency` → `dependency` (runtime).

## Use cases (TDD con fakes: repo in-memory + InMemoryRouterGateway)
- [ ] **(test primero)** `CreatePppoeService` — DB `pending` → `createSecret` → `enabled`; username dup → `PppoeUsernameTakenError`; router caído → `pending`+error; reintento idempotente.
- [ ] **(test primero)** `UpdatePppoeService` — router primero, luego DB; router caído → DB sin cambios.
- [ ] **(test primero)** `MovePppoeServiceToRouter` — crea destino → baja origen → `nasId`=destino; destino caído → aborta sin cambios.
- [ ] **(test primero)** `DeactivatePppoeService` — `disabled=yes` + `status='disabled'` (soft).
- [ ] `ListPppoeByContract` / `GetPppoeService` (lectura).

## HTTP + RBAC
- [ ] DTO `src/application/dto/pppoe.dto.ts` (zod) — `PppoeServiceDto` SIN `password` + schemas de body.
- [ ] Rutas `src/infrastructure/http/routes/pppoe.routes.ts`: `GET/POST /api/contracts/:contractId/pppoe`, `PATCH/DELETE /api/pppoe/:id`, `POST /api/pppoe/:id/move`. Guards `pppoe.read`/`pppoe.manage`.
- [ ] Errores → shapes del design (502/409/422/404).
- [ ] Permisos `pppoe.read`/`pppoe.manage`: catálogo RBAC + migración seed idempotente + expuestos al `/me`.
- [ ] Wiring `app.ts` (+ **composition test** anti "feature muerta").

## Config
- [ ] `ROUTER_API_USER`/`ROUTER_API_PASSWORD` en `config.ts` (fail-fast) + `env.example`. Password nunca en DTO.

## Verificación
- [ ] `npm test` verde + `tsc --noEmit` limpio.
- [ ] DIP: ningún use case importa `node-routeros`.
- [ ] Seam test: ruta → use case real → repo in-memory + fake gateway (no mockear el use case).
- [ ] Migración de permisos: dry-run rolled-back vs prod.
- [ ] Wire contract BE↔FE documentado (endpoints + DTO campo por campo) para el equipo FE.

## Frontend (coordinado, `ipnext-frontend` — change aparte)
- [ ] UI de carga/gestión de PPPoE por contrato (form: username/password/profile/router/IP; lista; mover; baja). Consume los endpoints; gateada por `pppoe.read`/`pppoe.manage`.

## Salida de la fase
- [ ] CRUD de PPPoE funcional con aprovisionamiento consistente; `adapter RouterOS` listo → la Fase C (cortes) se monta encima reusando `removeActiveSession` + `updateSecret(profile=IP-REDUCCION)`.
