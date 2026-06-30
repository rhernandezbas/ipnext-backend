# Tasks: Gestión FULL de PPPoE (tab en Gestión de Red)

> TDD estricto: test que falla primero, después el código. Gates (suite + tsc) corridos por el orquestador. Review adversarial antes de push. Push con OK del usuario, change por change (BE y FE independientes).

## Fase 0 — Setup
- [ ] 0.1 Worktree BE: `ipnext-backend/.claude/worktrees/pppoe-full-mgmt-be`, branch `feat/pppoe-full-management` desde el SHA de `main`, junction `node_modules`. Verificar HEAD == SHA.
- [ ] 0.2 Worktree FE: `ipnext-frontend/.claude/worktrees/pppoe-full-mgmt-fe`, branch `feat/pppoe-full-management` desde el SHA de `main`, junction `node_modules`. Verificar HEAD == SHA.

## Fase 1 — BE: listado con huérfanos (`includeUnassigned`)
- [ ] 1.1 (test) `PrismaPppoeServiceRepository`/in-memory: `listAllPaginated({ includeUnassigned })` incluye huérfanos cuando `true`, los excluye cuando `false`/ausente (default = comportamiento viejo).
- [ ] 1.2 (test) `ListAllPppoeServices`: propaga el flag; huérfanos salen con `clientId/customerName = null`; `total` cuenta acorde.
- [ ] 1.3 (green) Implementar el flag en repo Prisma + in-memory + use case.
- [ ] 1.4 (test+green) `GET /api/pppoe?includeUnassigned=true` parsea el query y lo pasa al use case (gate `pppoe.read`). Test de ruta con use case REAL + repo in-memory (no mock).
- [ ] 1.5 (test) Pin del comportamiento viejo: `GET /api/pppoe` sin el flag NO trae huérfanos (protege `InternetServicesPage`).

## Fase 2 — BE: crear con contrato opcional (`CreatePppoeStandalone`)
- [ ] 2.1 (test) Crear sin contrato → orchestrator.createUser llamado + espejo con `contractId = null`.
- [ ] 2.2 (test) Crear con contrato → espejo con `contractId` + asociación/activación por el camino existente.
- [ ] 2.3 (test) Username duplicado → rechazo 409/422, sin crear nada.
- [ ] 2.4 (test) Falla del orchestrator → NO se inserta fila en el espejo.
- [ ] 2.5 (green) Implementar `CreatePppoeStandalone` + `POST /api/pppoe` (gate `pppoe.manage`, DTO sin password).

## Fase 3 — BE: recrear username (`RenamePppoeUsername`)
- [ ] 3.1 (test) Happy path: crea nuevo (preserva password/plan/framedIp/mac/status) → borra viejo → `UPDATE username` mismo row (preserva `contractId`/`id`).
- [ ] 3.2 (test) Username destino ya existe → aborta sin tocar nada.
- [ ] 3.3 (test) `deleteUser(viejo)` falla tras crear el nuevo → el viejo SOBREVIVE, devuelve `status: 'partial'`.
- [ ] 3.4 (test) Preserva MAC/suspend (re-aplica setMac/suspend en el nuevo).
- [ ] 3.5 (green) Implementar `RenamePppoeUsername` + `POST /api/pppoe/:id/rename` (gate `pppoe.manage`). Cuidar orden de montaje vs catch-all `/:id`.

## Fase 4 — BE: wiring + gate
- [ ] 4.1 Inyectar los use cases nuevos en `app.ts`; verificar wiring a mano contra el design (anti-W6).
- [ ] 4.2 Gate BE (orquestador): suite Jest completa + `tsc --noEmit` limpio.

## Fase 5 — FE: API + hooks (aditivo)
- [ ] 5.1 (test+green) `pppoe.api.ts`: `list({ includeUnassigned })`, `createStandalone(body)`, `rename(id, newUsername)`.
- [ ] 5.2 (test+green) Hooks: extender `useAllPppoe` con `includeUnassigned`; `useCreatePppoeStandalone`; `useRenamePppoe`. Reusar `usePppoe` (update/move/deactivate/credentials/pin/unpin).

## Fase 6 — FE: tab + tabla (ui-ux-pro-max PRIMERO)
- [ ] 6.0 Correr `ui-ux-pro-max` (`search.py "tabla gestión PPPoE filtros acciones" --design-system`) y anclar tokens/estados ANTES de escribir UI.
- [ ] 6.1 (test) `PppoeManagementTab`: render tabla con `useAllPppoe({ includeUnassigned: true })`; paginación; filtro NAS round-trip (select de `useNasServers`); search debounced; filtro status.
- [ ] 6.2 (green) `GestionRedPage`: agregar `{ key: 'pppoe', label: 'PPPoE' }` a `TABS` + render condicional (aditivo, no tocar otros tabs). Gate `pppoe.read`.
- [ ] 6.3 (green) `PppoeManagementTab.tsx` + `.module.css`: tabla (Username · Cliente/⚠ · Plan · Estado `StatusBadge` · IP · NAS · Acciones) + `Pagination`. Huérfanos con ⚠.

## Fase 7 — FE: acciones y modales (ui-ux-pro-max)
- [ ] 7.1 (test+green) Modal Crear (NAS req + plan `usePlans` req + username/password + IP fixed/pool + **cliente/contrato opcional**).
- [ ] 7.2 (test+green) Editar fila (password/plan/IP/status) vía `PATCH`.
- [ ] 7.3 (test+green) Cambiar username: modal con **warning explícito** ("recrea el secret, el CPE debe reconfigurarse"); maneja `status: 'partial'`.
- [ ] 7.4 (test+green) Mover NAS; suspender/reactivar; baja (con confirmación).
- [ ] 7.5 (test+green) Revelar password on-demand (`usePppoeCredentials`, botón ojo, gate `pppoe.manage`).
- [ ] 7.6 Gate de permisos en FE: `Can` en acciones de escritura; tab bajo `pppoe.read`.
- [ ] 7.7 Gate FE (orquestador): suite Vitest completa + `tsc` limpio.

## Fase 8 — Verify + review + entrega
- [ ] 8.1 `sdd-verify`: matriz de spec-compliance (cada scenario con su test verde).
- [ ] 8.2 Review adversarial (foco: recrear-username/rollback, wiring app.ts, contrato BE↔FE campo por campo, pin del comportamiento viejo del listado, leak de password). Fix wave + re-review hasta CLEAN.
- [ ] 8.3 Verificación Playwright en la app real (`/admin/networking/routers/list`, tab PPPoE): crear/editar/rename/mover/baja + limpiar datos de prueba.
- [ ] 8.4 Commits convencionales por repo (BE y FE independientes), `git add` por path explícito.
- [ ] 8.5 Push con OK del usuario, change por change; seguir el run en `gh` hasta verde. Sincronizar `main` local (BE+FE) == `origin`.
- [ ] 8.6 Actualizar la card del BACKLOG a ✅ EN PROD con los PRs; `sdd-archive`.
