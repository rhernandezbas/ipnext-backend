# Proposal: Rediseño de los tabs "Sesiones activas" y "Pools IP" de Gestión de Red (filtros + paginado server-side)

## Intent

Rediseñar los dos tabs más pesados de `GestionRedPage.tsx` — **Sesiones activas** y **Pools IP** — para que sean usables a escala:

- **Sesiones activas (~2949 filas HOY renderizadas de una):** mover el **filtrado y el paginado al SERVER** (`GET /api/radius/sessions`). Nuevos params `search`, `nasId`, `status`, `page`, `limit`. El FE deja de traer y renderizar las ~3k filas: pide una página filtrada + KPIs de cabecera.
- **Pools IP (~30 pools):** rediseño **FE-only** (el paginado server-side NO aporta a esta escala — decisión documentada). Filtros por NAS / tipo (dynamic/static) / ipKind (cgnat/public), grupos colapsables por router con subtotales, KPIs de cabecera (IPs totales/asignadas/libres) que **excluyen los pools con `assignedCount === null`** y señalizan "N sin dato", orden por % de uso descendente dentro del grupo.

**Regla transversal (innegociable):** el manejo de `null`/NoData del fix de contadores (`gestion-red-radius-counters`, 2026-06-29) se **PRESERVA en todo el redesign**. `assignedCount === null` = "el NAS no respondió", NUNCA se convierte en `0`, NUNCA entra a un promedio/total como 0.

## Why

- **Sesiones no escala:** `GET /api/radius/sessions` → `ListRadiusSessions.execute()` (sin params) trae **TODO** el snapshot del orchestrator (`OrchestratorRadiusSessionRepository.fetchAll()` pagina el orchestrator de a 100 y junta ~3k objetos en memoria), enriquece por username en batch, y devuelve el array completo. El FE (`GestionRedPage.tsx:1169-1232`, hook `useRadiusSessions`) renderiza las ~2949 filas de una, agrupadas por NAS display-side, **sin filtros ni paginado**. Eso es un payload gigante + un DOM gigante en cada carga del tab.
- **El patrón server-side YA existe en este mismo router:** los tabs de auditoría (`GET /api/radius/events`, `/ne8000/audit`, `/auth-failures`, change `network-audit-pages`) ya usan `page`/`limit` con validación (`parseIntPositive`) y devuelven el **envelope canónico `{ data, total, page, limit, hasNext }`**. El redesign de sesiones **replica ese patrón ya probado**, no inventa uno nuevo.
- **Pools no necesita server-side:** ~30 pools caben holgados en un solo `GET`. El problema de pools es de **presentación** (agrupar, colapsar, filtrar, KPIs honestos con null), no de volumen. Server-side acá sería sobre-ingeniería (documentado como decisión en `design.md`).
- **El count del tab depende del array completo HOY:** el badge "2949" del tab Sesiones sale de `sessions.length` (`tabCounts.sesiones`, `GestionRedPage.tsx:747`). Si el endpoint pagina, el FE deja de tener el array completo → el `total` debe venir del server (campo `total` del envelope) para preservar el badge.

## Scope

### In Scope

**BE — `GET /api/radius/sessions` (params opcionales + envelope condicional):**
- Nuevos query params **opcionales**: `search` (matchea `username` OR `customerName` OR `ipAddress` OR `macAddress`, case-insensitive, substring), `nasId`, `status` (`active`|`idle`), `page`, `limit`.
- **Contrato (Decisión de diseño clave — ver `design.md` D1):** **params opcionales con envelope condicional back-compat.**
  - **Sin ningún param** → devuelve el **array legacy `RadiusSession[]`** (preserva los consumidores actuales y los tests `Array.isArray(res.body) === true`).
  - **Con cualquier param de paginación/filtro** → devuelve el **envelope `{ data, total, page, limit, hasNext, stats }`**.
  - El campo extra `stats` (KPIs por estado: total, active, idle) se calcula sobre el set **filtrado por search/nasId** (ignorando `status`, para que los KPIs por estado muestren el desglose completo) — patrón idéntico a `countsByReason` de `ListRadiusAuthFailures`.
- El use case sigue trayendo todo del orchestrator + enriqueciendo por username en batch (como HOY), pero **filtra + pagina EN EL BE** → payload chico al FE. La materialización de ~3k objetos ya ocurre hoy; no se agrega costo de memoria.
- Validación de params en la ruta (reusar `parseIntPositive`, validar el enum `status`), handler async con catch/`throw` explícito (Express 4).
- Wiring en `app.ts` verificado contra el diseño.

**BE — `GET /api/ip-pools` (aditivo mínimo para el filtro ipKind):**
- Exponer `ipKind` (`cgnat`|`public`|`null`) en el DTO/respuesta de pools. Existe en el entity `IpPool` (`domain/entities/network.ts:36`) pero **NO llega al FE hoy** (el `ListIpPools` lo arrastra vía `...pool`, pero verificar el mapper de la ruta y el tipo del FE). Es **read-only, aditivo, sin romper nada**. Si ya llega, se documenta y no se toca el BE para pools.
- El paginado de pools **NO se toca** (sigue array plano, ~30 pools).

**FE — Tab Sesiones activas (redesign):**
- Filtros: `search` debounced (300ms, patrón `useSearch`/useRef existente), `select` de NAS, `select` de estado.
- Tabla **paginada** con el componente `Pagination` existente (molecules) — las mismas 7 columnas actuales (cliente linkeado + ⚠ sin contrato, usuario, IP, MAC, ↓/↑ Mbps, estado).
- KPIs de cabecera (total, active, idle) del campo `stats` del envelope.
- El hook `useRadiusSessions` pasa a aceptar params y consumir el envelope; el badge del tab lee `total`.

**FE — Tab Pools IP (redesign FE-only):**
- Filtros: por NAS (select), por tipo (dynamic/static), por ipKind (cgnat/public) — el filtro de texto actual (name/rangeStart/rangeEnd) se conserva, **debounced**.
- Grupos **colapsables** por router con subtotales por grupo.
- KPIs de cabecera: IPs totales / asignadas / libres — **excluyendo pools con `assignedCount === null`** del agregado + badge "N sin dato".
- Orden por **% de uso descendente** dentro de cada grupo.
- Preservar `NoData` (—) + `UsageBar` (semáforo azul <90% / ámbar ≥90% / rojo 100%) tal cual.

### Out of Scope

- **Mover sesiones a un endpoint nuevo** (`/api/sessions` separado): se descarta a favor de extender `/api/radius/sessions` con params opcionales (Decisión D1). El endpoint `/api/sessions` mencionado en el pedido **no existe**: el real es `/api/radius/sessions`.
- **Paginado server-side de pools** (~30 pools no lo justifican).
- **`downloadMbps`/`uploadMbps` reales en sesiones:** el orchestrator NO expone tasa instantánea → hoy son `0` (`OrchestratorRadiusSessionRepository:92-93`). No cambia en este redesign; se muestran las columnas como HOY.
- **Filtrar por `status='idle'` con datos reales:** la fuente real (`OrchestratorRadiusSessionRepository`) siempre produce `status='active'` — ver Riesgos. El filtro se implementa y se testea (el in-memory sí produce `idle`), pero en prod devolverá vacío hasta que la fuente exponga sesiones idle. Documentado, no un bug del redesign.
- **Permisos nuevos:** ambos tabs ya están gated (`network.read`). Sin permisos nuevos (ver "Agujeros de permisos" en `design.md`).
- **Extraer `NoData`/`UsageBar` a componentes reutilizables:** opcional; el redesign puede dejarlos inline como HOY. No es requisito.

## Capabilities

### New Capabilities

- `network-sessions-pools-redesign`: filtrado + paginado server-side de las sesiones RADIUS activas (`search`/`nasId`/`status`/`page`/`limit` + envelope condicional con `stats`), y rediseño de presentación de pools IP (filtros dynamic/static/cgnat/public, grupos colapsables, KPIs null-safe, orden por uso).

### Modified Capabilities

- `gestion-red-sessions` (implícita, `ListRadiusSessions`): gana filtrado + paginación + KPIs en el BE. Aditivo y back-compat: sin params, el comportamiento actual (array completo) no cambia.

## Approach

1. **BE sesiones (TDD, test primero):** extender `ListRadiusSessions.execute(params?)` para aceptar `{ search, nasId, status, page, limit }`; filtrar + paginar el array enriquecido en memoria; calcular `stats`. Devolver array (sin params) o envelope (con params). Ruta `GET /api/radius/sessions` valida params y rutea el shape. Wiring en `app.ts`.
2. **BE pools (aditivo mínimo):** verificar/exponer `ipKind` en la respuesta de `GET /api/ip-pools` + el tipo del FE. Sin más cambios de BE en pools.
3. **FE sesiones:** `useRadiusSessions(params)` → envelope; `Pagination` + filtros debounced + selects + KPIs de `stats`. ui-ux-pro-max.
4. **FE pools:** filtros (NAS/tipo/ipKind/texto debounced) + grupos colapsables + KPIs null-safe + orden por uso, preservando NoData/UsageBar. ui-ux-pro-max.
5. **Verificación:** `npm test` (BE) verde con tests de seam por cada filtro/param (ruta real + use case real + repos in-memory, NO mockear el use case); suite FE verde + typecheck; review adversarial (2 revisores: contrato/paginación + FE/estado-filtros).
6. **Deploy coordinado BE→FE** (push=prod por repo). El envelope condicional hace el deploy tolerante (ver Riesgos + `design.md` D1).

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/application/use-cases/ListRadiusSessions.ts` | Modified | `execute(params?)` con filtros + paginado + `stats` en memoria |
| `src/application/dto/` (nuevo `radius-session.dto.ts` o extensión) | New | `PaginatedRadiusSessionsDto { data, total, page, limit, hasNext, stats }` |
| `src/infrastructure/http/routes/radius.routes.ts` | Modified | `GET /sessions` valida `search/nasId/status/page/limit` + rutea array vs envelope |
| `src/infrastructure/http/app.ts` | Modified | Wiring (sin nuevos repos; `ListRadiusSessions` ya cableado) |
| `src/application/use-cases/ListIpPools.ts` / ruta `/ip-pools` | Verify/Modified | Confirmar/exponer `ipKind` en la respuesta (aditivo, si falta) |
| `ipnext-frontend` `GestionRedPage.tsx` (tab Sesiones) | Modified | Filtros + Pagination + KPIs + hook con params (ui-ux-pro-max) |
| `ipnext-frontend` `GestionRedPage.tsx` (tab Pools) | Modified | Filtros + colapsables + KPIs null-safe + orden (ui-ux-pro-max) |
| `ipnext-frontend` `src/hooks/useRadiusSessions.ts` | Modified | Acepta params, consume el envelope |
| `ipnext-frontend` `src/types/network.ts` (IpPool) | Modified | `+ ipKind` si el BE lo expone y falta en el tipo |

> **Splynx:** este cambio NO agrega dependencias de Splynx (constraint respetado).
> **Prisma:** NO hay cambio de schema ni migración (sesiones son en vivo del orchestrator; pools no cambian de modelo).

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Romper el contrato BE↔FE de `/api/radius/sessions` (array → envelope) | Alta | **Envelope condicional back-compat** (D1): sin params = array legacy (tests `Array.isArray` intactos); con params = envelope. Deploy BE primero, FE después; el BE tolera ambos mundos durante la ventana. |
| El badge "2949" desaparece al paginar (el FE ya no tiene el array completo) | Alta | El envelope trae `total` SIEMPRE → el badge lee `total`, no `data.length`. Test de seam que verifica `total` correcto con filtros. |
| `status='idle'` devuelve vacío en prod (la fuente real solo emite `active`) | Media | Documentado (Out of Scope + design D4). Se implementa y testea con el in-memory (que sí emite `idle`); en prod es "sin resultados", no error. No revertir por esto. |
| `nasId` de sesiones NO es un id de NAS real sino el `nasIp` | Media | La fuente mapea `nasId = nasName = nasIp` (`OrchestratorRadiusSessionRepository:84-85`). El filtro `nasId` matchea contra ese valor; el select del FE se puebla con los `nasId` presentes en la data. Documentado en el spec campo por campo. |
| KPIs de pools contaminados por `null` (contar null como 0) | Media | Regla dura: los KPIs **excluyen** los pools con `assignedCount === null` y muestran "N sin dato". Test del agregado null-safe. Patrón heredado de `gestion-red-radius-counters`. |
| `ipKind` no llega al FE → el filtro cgnat/public no funciona | Media | Verificar el mapper de `/ip-pools` + el tipo FE; exponerlo si falta (aditivo). Si no se puede en tiempo, el filtro ipKind se difiere sin bloquear el resto. |
| Filtro `search` con `customerName`/`clientId` null (sesión sin contrato) | Baja | El search sobre `customerName` ignora null (no matchea); no rompe. Test con sesión sin contrato. |

## Rollback

**Por capas, reversible, sin migración.**
- **BE:** el cambio es aditivo (params opcionales). `git revert` → `/api/radius/sessions` vuelve al array puro. Ningún dato migrado.
- **FE:** `git revert` del redesign → los tabs vuelven al render actual (que sigue funcionando contra el array legacy que el BE devuelve sin params).
- **Orden seguro:** por el envelope condicional, revertir el FE solo (dejando el BE nuevo) tampoco rompe: sin params el BE devuelve el array legacy que el FE viejo espera.

## Dependencies

- `Pagination` (molecules) — ya existe y se usa en el tab "Asignaciones" (server-side).
- Patrón de envelope `{ data, total, page, limit, hasNext }` — ya establecido por `network-audit-pages`.
- `useSearch` / patrón debounce useRef — ya existen en el FE.
- ui-ux-pro-max — skill presente en `ipnext-frontend/.claude/skills/ui-ux-pro-max/`.

## Success Criteria

- [ ] `GET /api/radius/sessions` **sin params** → array `RadiusSession[]` (back-compat; tests `Array.isArray` verdes).
- [ ] `GET /api/radius/sessions?page=1&limit=50` → envelope `{ data, total, page, limit, hasNext, stats }` con `total` = cantidad filtrada correcta.
- [ ] `search` matchea username OR customerName OR ipAddress OR macAddress (case-insensitive, substring).
- [ ] `nasId` filtra por el `nasId`/`nasIp` de la sesión; `status` filtra por `active`/`idle`.
- [ ] Combinación search + nasId + status + page/limit consistente (total correcto, página correcta).
- [ ] `stats` (total/active/idle) refleja el set filtrado por search/nasId (ignorando status).
- [ ] Pools: filtros por NAS/tipo/ipKind/texto (debounced) funcionan; grupos colapsables con subtotales.
- [ ] Pools: KPIs (totales/asignadas/libres) **excluyen** los `assignedCount === null` y muestran "N sin dato".
- [ ] Pools: orden por % de uso descendente dentro del grupo; NoData + UsageBar (semáforo) intactos.
- [ ] Tests de seam por cada filtro/param (ruta + use case + repos in-memory, sin mockear el use case). `npm test` (BE) verde + `tsc --noEmit` limpio.
- [ ] Suite FE verde + typecheck. Accesibilidad: contraste ≥4.5:1, touch ≥44px, focus visible, aria en NoData.
- [ ] Deploy coordinado BE→FE verde. **DIP preservado** (use case depende de ports, no de infra).
