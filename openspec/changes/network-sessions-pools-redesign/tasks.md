# Tasks: Rediseño Sesiones activas + Pools IP (filtros + paginado server-side)

> TDD estricto (test primero, red → green → refactor). Apply en **worktree BE** (`feat/network-sessions-pools-redesign`) + **worktree FE** coordinado.
> Orden de dependencias: **BE sesiones → BE pools (verify ipKind) → FE sesiones → FE pools → verificación → deploy coordinado BE→FE (gated por OK del usuario)**.
> ⚠️ NO push sin OK. Deploy = push a `main` por repo (push=prod). BE primero, FE después (el envelope condicional lo hace tolerante).
> ⚠️ NO tocar `openspec/changes/pppoe-move-nas/` (sesión paralela). NO tocar código fuente hasta la fase apply.

## 0. Pre-flight (verificaciones antes de codear)
- [ ] 0.1 Confirmar la URL real: `GET /api/radius/sessions` (mount `/api/radius` en `app.ts:1812` + router `/sessions`). El pedido dice `/api/sessions` — es incorrecto; el real es `/api/radius/sessions`. Documentado en design D1.
- [ ] 0.2 Confirmar consumidores del contrato array a preservar: `radius.routes.test.ts:151-156` (`Array.isArray` + `toHaveLength(15)`), `RadiusSessionUseCases.test.ts`, `listRadiusSessions.terminated.test.ts`, hook FE `useRadiusSessions`.
- [ ] 0.3 Verificar si `ipKind` ya viaja en el body de `GET /ip-pools` (la ruta hace `res.json(pools)` y `ListIpPools` arrastra `...pool`). Decide si el toque de BE en pools es Verify-only o Modified.

## 1. BE — DTO paginado de sesiones
- [ ] 1.1 Crear `src/application/dto/radius-session.dto.ts` con `RadiusSessionDto` (mapeo explícito 1:1 del entity, SIN devolver la entity cruda), `RadiusSessionsStats { total, active, idle }`, y `PaginatedRadiusSessionsDto { data, total, page, limit, hasNext, stats }`. Contrato campo por campo per design.md (lección W6).

## 2. BE — `ListRadiusSessions` con filtros + paginado + stats (TDD: test primero)
- [ ] 2.1 **(test primero)** `execute()` **sin params** → sigue devolviendo `RadiusSession[]` (back-compat). Test verde = no rompe consumidores.
- [ ] 2.2 **(test primero)** `execute({ page, limit })` → `PaginatedRadiusSessionsDto` con shape completo. `limit` default 50, cap 200; `page` default 1 (mismo cap que `ListRadiusEvents`).
- [ ] 2.3 **(test primero)** `search` — matchea `username` OR `customerName` OR `ipAddress` OR `macAddress`, case-insensitive, substring. Test con sesión sin contrato (`customerName=null` no matchea, no rompe).
- [ ] 2.4 **(test primero)** `nasId` — filtra por `session.nasId` (= nasIp en la fuente real). Test con las 3 NAS del in-memory.
- [ ] 2.5 **(test primero)** `status` — filtra `active`/`idle`. El in-memory emite `idle` (filas i>12) → test determinista. (En prod la fuente solo emite `active` — design D4, no bloquea.)
- [ ] 2.6 **(test primero)** `stats` — `total`/`active`/`idle` sobre el set filtrado por search+nasId, **ignorando** `status` (patrón `countsByReason`). Test: con `status=active`, `stats.idle` sigue reflejando los idle del set.
- [ ] 2.7 **(test primero)** combinación `search`+`nasId`+`status`+`page`+`limit`: `total` correcto (matchea TODOS los filtros), página correcta, `hasNext = page*limit < total`, **orden estable** (username ASC) cross-página.
- [ ] 2.8 Implementar (green): enriquecer (como hoy) → filtrar search/nasId → calcular stats → aplicar status → orden estable → paginar → mapear a DTO. Refactor. **NO** agregar métodos al port; filtrado en memoria (design D2). **NO** importar infra/Prisma en el use case (DIP).

## 3. BE — Ruta `GET /api/radius/sessions` (validación + ruteo array vs envelope)
- [ ] 3.1 **(test primero)** ruta sin params → 200 `Array.isArray(res.body)` (back-compat; el test existente `:151-156` debe seguir verde).
- [ ] 3.2 **(test primero)** ruta con `?page=1&limit=50` → 200 envelope (`res.body.data` array, `res.body.total` number, `res.body.stats` presente).
- [ ] 3.3 **(test primero)** validación: `page=0`/`page=abc` → 400; `limit=-1` → 400; `status=foo` → 400 (`VALIDATION_ERROR`). Reusar `parseIntPositive` + `Set` de valores válidos, patrón de `radius.routes.ts` (events/audit).
- [ ] 3.4 **(test primero)** RBAC: sin auth → 401; sin `network.read` → 403 (preservar gate actual).
- [ ] 3.5 Implementar la ruta (green): parsear/validar params; si NINGÚN param → `execute()` array; si hay params → `execute({...})` envelope. Handler async con `try/catch`→`throw` explícito (Express 4). Refactor.
- [ ] 3.6 **Composition test** (anti feature-muerta): ruta real → `ListRadiusSessions` real → `InMemoryRadiusSessionRepository` + `InMemoryPppoeServiceRepository` (o `InMemoryRadiusOrchestratorGateway`). **NO mockear el use case** (lección #28).

## 4. BE — Wiring `app.ts`
- [ ] 4.1 Verificar que `app.ts:1812` pasa `listRadiusSessions` a `createRadiusRouter` (ya lo hace). Confirmar que la ruta le pasa los params al `execute`. Sin nuevos repos (el wiring de `ListRadiusSessions` en `:1232` no cambia). Wiring verificado contra el diseño (lección W6).

## 5. BE — Pools: `ipKind` en el contrato (Verify o aditivo mínimo)
- [ ] 5.1 **(test primero)** test de la ruta `GET /ip-pools`: el body incluye `ipKind` (`cgnat`|`public`|`null`) por pool. Si ya viaja → Verify-only (no toca código BE). Si falta → exponerlo en el mapper/DTO de la ruta (aditivo, read-only, sin romper `assignedCount|null`).
- [ ] 5.2 Confirmar que el manejo de `assignedCount === null` de `ListIpPools` **NO se altera** (NUNCA null→0). Test de regresión del null.

## 6. FE — Tab Sesiones activas (worktree FE, ui-ux-pro-max OBLIGATORIA)
- [ ] 6.0 **ARRANCAR** corriendo en el repo FE: `python .claude/skills/ui-ux-pro-max/scripts/search.py "networking admin table filters pagination KPIs active sessions" --design-system`. Leer el design-system antes de escribir cualquier componente. CSS Modules + tokens de `src/tokens/variables.css` (NO Tailwind).
- [ ] 6.1 `src/types/` — agregar `PaginatedRadiusSessions` (data/total/page/limit/hasNext/stats) espejando el DTO del BE.
- [ ] 6.2 `useRadiusSessions(params)` — acepta `{ search, nasId, status, page, limit }`, incluye los params en el `queryKey`, consume el **envelope** (siempre manda `page`/`limit` → siempre envelope). El badge del tab lee `stats.total`.
- [ ] 6.3 `GestionRedPage.tsx` tab Sesiones: filtros = search **debounced 300ms** (patrón `useSearch`/useRef) + `select` NAS (poblado con los `nasId` presentes) + `select` estado (active/idle). Cambio de filtro → **reset a page=1**.
- [ ] 6.4 Tabla **paginada** con el componente `Pagination` (molecules, `{currentPage, totalPages, onPageChange}`) — mismas 7 columnas (cliente linkeado + ⚠ sin contrato, usuario, IP, MAC, ↓/↑ Mbps, estado). KPIs de cabecera (total/active/idle) de `stats`.
- [ ] 6.5 Estados loading/error/empty ("Sin sesiones para los filtros seleccionados"). Accesibilidad: contraste ≥4.5:1, touch ≥44px, focus visible, aria en badges de estado.
- [ ] 6.6 Tests FE (Vitest): filtros disparan el request con los params correctos; paginación; badge = stats.total; empty state; typecheck.

## 7. FE — Tab Pools IP (redesign FE-only, ui-ux-pro-max OBLIGATORIA)
- [ ] 7.0 **ARRANCAR** corriendo en el repo FE: `python .claude/skills/ui-ux-pro-max/scripts/search.py "networking IP pools grouped collapsible KPIs usage bar" --design-system`. Leer el design-system antes de escribir componentes.
- [ ] 7.1 `src/types/network.ts` `IpPool` — agregar `ipKind: 'cgnat' | 'public' | null`.
- [ ] 7.2 Filtros: por NAS (select), por tipo (dynamic/static), por ipKind (cgnat/public), + el filtro de texto actual (name/rangeStart/rangeEnd) **debounced**. Filtros FE puros (sin request nuevo).
- [ ] 7.3 Grupos **colapsables** por router con subtotales por grupo. Orden por **% de uso descendente** dentro del grupo; pools con `assignedCount === null` **al final** (sin % 0).
- [ ] 7.4 KPIs de cabecera: IPs totales / asignadas / libres **excluyendo** `assignedCount === null` del agregado + badge **"N sin dato"**. NUNCA `assignedCount ?? 0` en un agregado (design D5).
- [ ] 7.5 **PRESERVAR** `NoData` (—, `role="img"`/`aria-label`) + `UsageBar` (semáforo azul <90% / ámbar ≥90% / rojo 100%) tal cual. No romper el patrón null/NoData/UsageBar.
- [ ] 7.6 Tests FE (Vitest): filtros; colapsable; KPIs null-safe (con al menos un pool `assignedCount=null` → excluido del total + "1 sin dato"); orden por uso con null al final; typecheck.

## 8. Verificación
- [ ] 8.1 `npm test` (BE) verde + `tsc --noEmit` limpio. Suite FE (Vitest) verde + typecheck.
- [ ] 8.2 DIP: `ListRadiusSessions` no importa Prisma/axios/Express; el DTO en `application/dto/`. `application/` limpia.
- [ ] 8.3 **Review adversarial** (2 revisores, judgment-day / opus):
  - R1 Contrato/Paginación (BE): envelope condicional back-compat; `total` vs `stats.total`; orden estable; validación de params; tests `Array.isArray` intactos; wiring vivo.
  - R2 FE/Estado-filtros: debounce + reset page; badge = stats.total; KPIs pools null-safe; NoData/UsageBar preservados; orden con null al final; accesibilidad; ui-ux-pro-max aplicada.

## 9. Salida de fase — deploy gated
- [ ] 9.1 Merge del worktree BE a `main` + push (= prod). **Requiere OK explícito del usuario.** El BE nuevo es back-compat (sin params = array) → el FE viejo sigue andando.
- [ ] 9.2 Merge del worktree FE a `main` + push (= prod). El FE nuevo consume el envelope. Deploy verde.
- [ ] 9.3 Smoke en prod: tab Sesiones filtra+pagina; badge = total real; tab Pools filtra/colapsa/ordena; KPIs null-safe correctos.
- [ ] 9.4 Actualizar BACKLOG + engram (`sdd/network-sessions-pools-redesign/*`) con el resultado en prod. `sdd-archive` del change.
