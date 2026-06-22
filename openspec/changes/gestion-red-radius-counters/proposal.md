# Proposal: Contadores en vivo de NAS RADIUS en Gestión de Red

## Intent

La página **Gestión de Red** del FE (`/admin/networking…`, `GestionRedPage`) muestra contadores STALE para un NAS que corre sobre RADIUS. Con `MercAccesoSur` (un Huawei NE8000, `nas.type='mikrotik_radius'`) el panel muestra `CLIENTES 0`, `ÚLTIMO CONTACTO —` y un badge `TIPO: MikroTik RADIUS`, cuando en realidad hay ~160 clientes vivos sobre un BRAS Huawei.

Este change **completa** la deuda que empezó el allocator (`FindFreeIp`, `#1338`): para NAS sobre RADIUS la verdad vive en el RADIUS (vía el **radius-orchestrator**), no en tablas STORED de Prominense. Hay que computar **en vivo** los contadores propios del NAS (`clientCount`, `lastSeen`) y mostrar un **TIPO** honesto.

## Why

- **Verificá el código real, no asumas.** La hipótesis original del bug-report listaba 5 contadores stale. Al abrir el código, **3 de esos 5 YA están arreglados** en `main`:
  - **Ocupación / IPs libres** (`ListIpPools`, `ListIpNetworks`) → ya computan en vivo desde el orchestrator vía `AssignedIpsProvider` (rutea por `nas.type`, lee `radreply`). Mismo patrón #1338.
  - **Asignaciones** (`GET /api/ip-assignments`) → ya usa `ListPppoeAssignments` (lee `PppoeService`, NO el `IpAssignment` legacy vacío).
- **Lo que SIGUE roto** son los contadores PROPIOS del NAS, que viajan crudos desde la entidad `NasServer`:
  1. `NasServer.clientCount` (Int STORED, `schema.prisma:1732`) — nunca se sincroniza para un NAS RADIUS → muestra `0`.
  2. `NasServer.lastSeen` (DateTime? STORED, `schema.prisma:1731`) — nunca se actualiza → muestra `—`.
  3. El **badge TIPO** = `nas.type` crudo (`mikrotik_radius`) — es el nombre del *cutover*, no el vendor real (Huawei NE8000).
- `ListNasServers` / `GetNasServer` hoy **solo leen `NasRepository`** y devuelven la entidad cruda; no hablan con el orchestrator. Esa es la causa raíz remanente.

## Scope

### In Scope (BE)

1. **Enriquecer NAS con contadores en vivo para `type='mikrotik_radius'`**:
   - `clientCount` real (clientes/sesiones activas en el RADIUS del NAS).
   - `lastSeen` real (actividad reciente del NAS en el RADIUS), best-effort.
   - Computado **al vuelo** en `ListNasServers` / `GetNasServer`, ruteando por `nas.type` (igual que `AssignedIpsProvider`): RADIUS → orchestrator; resto → comportamiento actual (campo STORED sin tocar).
   - **Degradación best-effort**: si el orchestrator no responde, el NAS sale con su valor stored (no se rompe el listado, igual que `AssignedIpsProvider`).
2. **TIPO honesto en el badge** sin romper el ruteo por `nas.type`:
   - Exponer un campo derivado de display (p. ej. `displayType` / `vendorLabel`) que para `mikrotik_radius` muestre un label neutro tipo **"BRAS RADIUS"**, sin cambiar `nas.type` (que sigue gobernando el ruteo).
   - **Aditivo**: el campo `type` crudo sigue viajando para el resto de la UI/lógica.
3. **Extensión del puerto** `RadiusOrchestratorGateway` con `listActiveSessions(offset?, limit?)` (CAMINO A comprometido): pega al nuevo `GET /sessions` global del orchestrator. `clientCount` = sesiones activas cuyo `framedIp` cae en los pools del NAS; `lastSeen` = `max(startedAt)` de esas sesiones.
4. **Endpoint nuevo en el `freeradius-orchestrator`**: `GET /sessions?offset=&limit=` (ruta global, gateada con `require_token`) que expone la query `radacct WHERE acctstoptime IS NULL` que el repo de sesiones YA implementa (`list_active_paginated`, hoy muerta: ningún inbound port la cablea). Solo se cablea (inbound port + service + router) — no se reimplementa RADIUS ni la query.

### Out of Scope

- **Migración / cambio de schema.** Es read-path puro: se computa en vivo, no se persiste. `clientCount`/`lastSeen` stored quedan como fallback.
- **Sincronización periódica** de `clientCount`/`lastSeen` a la tabla (un cron/sync) — alternativa descartada en Design (mantiene la deuda de "stored que se desincroniza").
- Paginación / rediseño de la página (cubierto por `asignaciones-scale`).
- Reimplementar RADIUS o la query en el orchestrator: `list_active_paginated` (la query global `radacct`) YA existe; solo se expone vía HTTP. **Camino B descartado** (aproximar con `radreply`: cuenta IPs configuradas, no sesiones vivas, y no da `lastSeen`).

## Capabilities

### Modified Capabilities
- **Gestión de Red (network)**: contadores propios del NAS (`clientCount`, `lastSeen`) computados en vivo desde el RADIUS para NAS `mikrotik_radius`; TIPO de display honesto. NAS legacy sin cambio de comportamiento.

## Approach

1. **TDD BE** — un use case (o servicio) que enriquece la lista/detalle de NAS:
   - test-first con `InMemoryNasRepository` + `InMemoryRadiusOrchestratorGateway`: NAS `mikrotik_radius` → `clientCount`/`lastSeen` del orchestrator; NAS legacy → valores stored intactos; orchestrator caído → degrada al valor stored.
2. **Ruteo por `nas.type`** reutilizando el patrón de `AssignedIpsProvider` (no reinventar; misma degradación best-effort y mismo cacheo si aplica).
3. **TIPO de display** como campo derivado additivo en el DTO/entidad de salida.
4. **Seam completo** — test de ruta `GET /api/nas-servers` → use case REAL → gateway in-memory, verificando que los números reales llegan al JSON.

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/application/use-cases/ListNasServers.ts` | Modified — inyectar orchestrator + enriquecer en vivo |
| `src/application/use-cases/GetNasServer.ts` | Modified — idem para el detalle |
| `src/application/services/` (p. ej. `NasLiveStatsProvider`) | New (posible) — ruteo por `nas.type` + degradación, espejo de `AssignedIpsProvider` |
| `src/domain/ports/RadiusOrchestratorGateway.ts` | Modified — `listActiveSessions(offset?, limit?)` (CAMINO A) |
| `src/infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway.ts` | Modified — impl HTTP (`GET /sessions`, reusa `toSession`) |
| `src/infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway.ts` | Modified — test double + seed `activeSessions` |
| `src/application/services/NasLiveStatsProvider.ts` | New — ruteo por `nas.type` + atribución por pools + degradación (espejo de `AssignedIpsProvider`) |
| `src/domain/services/ipMath.ts` | Modified — helper `ipInAnyRange` (atribución `framedIp` ∈ unión de rangos) |
| `src/domain/entities/nas.ts` + DTO de salida | Modified — campo `displayType` (aditivo) |
| `src/infrastructure/http/app.ts` | Modified — wiring: pasar `nasRepo`+`ipNetworkRepo`+`orchestrator` a `ListNasServers`/`GetNasServer` |
| `src/infrastructure/http/routes/nas.routes.ts` | Sin cambio de contrato (mismo shape, números reales + campo aditivo) |
| **`freeradius-orchestrator`** (Python) | New — inbound port `list_all_active` + service + router `GET /sessions` global (cabla `list_active_paginated` ya existente) |
| **FE** `ipnext-frontend` | Mínimo — solo el badge TIPO si se adopta `displayType` (change FE aparte) |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| `lastSeen` se deriva de `started_at`, no de `acctupdatetime` (el schema `SessionResponse` no expone `last_update`) | Media | Honesto (actividad real de sesión). Si ops necesita la granularidad de `acctupdatetime`: agregar `last_update` a `SessionResponse` (aditivo, mismo change, no bloqueante) |
| Llamar al orchestrator por cada NAS infla la latencia del listado | Media | Cachear la llamada global por request (espejo de `AssignedIpsProvider`); 1 sola llamada para todos los NAS RADIUS |
| El orchestrator caído rompe `GET /nas-servers` (lo consume el dropdown del InternetPanel) | Media | Degradación best-effort: `.catch(() => fallback stored)`. Un listado NUNCA se rompe por una fuente caída |
| La integración cross-repo pasa en tests pero falla en prod | Media | Verificación EN VIVO post-deploy obligatoria (Design): `curl` al `/sessions` real + `GET /api/nas-servers` contra el orchestrator desplegado |
| Cambiar el badge confunde a ops acostumbrados a "MikroTik RADIUS" | Baja | Label neutro consensuado ("BRAS RADIUS"); `type` crudo sigue disponible |

## Rollback

Aditivo y read-only (sin schema). Rollback = `git revert`. Sin coordinación de deploy obligatoria: si el FE no adopta `displayType`, el badge sigue como hoy pero `clientCount`/`lastSeen` ya llegan reales (el FE renderiza los números sin cambios).

## Dependencies

- Sin cambio de schema Prisma.
- `orchestrator` (`RadiusOrchestratorGateway`) ya instanciado y wired en `app.ts:1121` (singleton compartido); `nasRepo` y `ipNetworkRepo` ya existen.
- **Cross-repo (comprometido)**: el `freeradius-orchestrator` debe exponer `GET /sessions?offset=&limit=` (la query `list_active_paginated` ya existe; solo se cablea inbound port + service + router). Se deploya junto al BE; verificación EN VIVO post-deploy.

## Success Criteria

- [ ] **Los 3 contadores propios del NAS** quedan reales: `GET /api/nas-servers` y `:id` devuelven, para `mikrotik_radius`, `clientCount` y `lastSeen` reales del RADIUS (no `0`/`—` stored) y un `displayType` honesto.
- [ ] Orchestrator expone `GET /sessions` global (token, `list[SessionResponse]`); gateway BE lo consume vía `listActiveSessions`.
- [ ] NAS legacy (no-RADIUS) mantienen EXACTAMENTE el comportamiento actual (valores stored).
- [ ] El badge TIPO muestra un label honesto para `mikrotik_radius` sin romper el ruteo por `nas.type`.
- [ ] Orchestrator caído → el listado responde igual (degradado al valor stored), nunca 500.
- [ ] `npm test` + `pytest` verdes; DIP preservado (use cases dependen del PORT, nunca de axios/Prisma). Seam ruta→use case→gateway in-memory cubierto.
- [ ] **Verificación EN VIVO post-deploy**: `/sessions` real responde + `GET /api/nas-servers` trae `clientCount ~160` para `MercAccesoSur`.
- [ ] Review adversarial GO.
