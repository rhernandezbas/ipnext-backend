# Design: Contadores en vivo de NAS RADIUS en Gestión de Red

## Context

La página Gestión de Red muestra contadores STALE para un NAS sobre RADIUS (`MercAccesoSur`, Huawei NE8000, `nas.type='mikrotik_radius'`). Tras leer el código real:

- **YA arreglado en `main`** (NO tocar): Ocupación/IPs-libres (`ListIpPools` / `ListIpNetworks` vía `AssignedIpsProvider` → orchestrator `listAssignedIps` = `radreply`) y Asignaciones (`GET /api/ip-assignments` → `ListPppoeAssignments` → `PppoeService`).
- **SIGUE stale**: los 3 contadores PROPIOS del NAS que viajan crudos en la entidad `NasServer`:
  - `clientCount` (Int STORED, `schema.prisma:1732`) — muestra `0`, debería ~160,
  - `lastSeen` (DateTime? STORED, `schema.prisma:1731`) — muestra `—`,
  - el badge **TIPO** = `nas.type` crudo (`mikrotik_radius`) — debería mostrar el vendor.

`ListNasServers.execute()` y `GetNasServer.execute(id)` hoy son one-liners: `return this.repo.findAll…()`. No hablan con el orchestrator. **Esa es la causa raíz.**

## Decisión 0 — CAMINO A comprometido (open question cerrada)

La open question del explore ("¿el orchestrator expone sesiones activas globales?") quedó **resuelta a favor del Camino A**. Verificado en el repo `freeradius-orchestrator`:

- `SqlAlchemySessionRepository.list_active_paginated(offset, limit) -> list[Session]` (`…/persistence/mariadb/session_repository.py:28`) **ya implementa** la query global `radacct WHERE acctstoptime IS NULL`, `ORDER BY acctstarttime DESC`, paginada. Está declarada en el outbound port `application/ports/outbound/session_repository.py`.
- **Pero está MUERTA**: el inbound port `SessionControlPort` solo expone `list_active(username)` + `disconnect_all`; el router `routers/sessions.py` solo monta `GET/DELETE /users/{username}/sessions`. No hay ruta global.
- Existe el schema HTTP `SessionResponse` (con `.from_domain(s)`), la entidad de dominio `Session` y el mapper `to_session(RadAcct) -> Session`.

**Por tanto**: el Camino A se reduce a **cablear** la query ya existente — un método nuevo en el inbound port + service + una ruta HTTP global. No se reimplementa RADIUS ni la query. **No** hay Camino B (descartado: `radreply` cuenta IPs *configuradas*, no sesiones *vivas*, y no da `lastSeen`).

**Alcance**: read-path en vivo, **SIN migración**. No sincronizamos `clientCount`/`lastSeen` a la tabla con cron/sync (reintroduciría la deuda actual de "stored que se desincroniza"). Los campos STORED quedan como **fallback** best-effort (NAS legacy u orchestrator caído). Sin cambio de schema Prisma.

---

## Decisión 1 — Endpoint nuevo en el orchestrator: `GET /sessions` global

Ruta HTTP **global** (fuera del prefix per-user `/users/{username}/sessions`), gateada con `require_token` igual que el resto:

```
GET /sessions?offset=<int>&limit=<int>     (Bearer token)
→ 200  list[SessionResponse]
```

Wire del Camino A (3 piezas, espejando `list_active`):

1. **Inbound port** `SessionControlPort` (`application/ports/inbound/session_control.py`):
   ```python
   async def list_all_active(self, offset: int, limit: int) -> list[Session]: ...
   ```
2. **Service** `SessionControlService` (`application/use_cases/session_control_service.py`) — delega a la query ya existente:
   ```python
   async def list_all_active(self, offset: int, limit: int) -> list[Session]:
       async with self._uow.begin():
           return await self._uow.sessions.list_active_paginated(offset, limit)
   ```
3. **Router** — router NUEVO `routers/sessions_global.py` (más limpio que tocar el prefix per-user, que está acoplado a `{username}`), montado SIN prefix con `dependencies=[Depends(require_token)]`:
   ```python
   @router.get("/sessions", response_model=list[SessionResponse])
   async def list_all_active_sessions(
       service: Annotated[SessionControlPort, Depends(get_session_control)],
       offset: int = 0,
       limit: int = 1000,
   ) -> list[SessionResponse]:
       sessions = await service.list_all_active(offset, limit)
       return [SessionResponse.from_domain(s) for s in sessions]
   ```
   Mount en `app.py`: `app.include_router(sessions_global.router)`.

### Contrato `SessionResponse` (campo por campo — PINNED, verificado en el schema real)

```
SessionResponse (cada item del array de GET /sessions):
  session_id : str
  username   : str
  nas_ip     : str
  framed_ip  : str | null
  started_at : str (ISO-8601 datetime)
  bytes_in   : int
  bytes_out  : int
  caller_id  : str | null
```

⚠️ **Gotcha de `lastSeen`**: la entidad de dominio `Session` tiene `last_update: datetime | None` (de `radacct.acctupdatetime`), pero el schema `SessionResponse` **NO lo expone** — solo viaja `started_at` (de `acctstarttime`). Decisión: el BE deriva `lastSeen = max(started_at)` de las sesiones del NAS. Es honesto (es actividad real de sesión), aunque no sea el `acctupdatetime` más fino. **Si se quiere `lastSeen` con la granularidad de `acctupdatetime`**, hay que AGREGAR `last_update` a `SessionResponse.from_domain` (campo aditivo, no breaking) — queda como mejora opcional dentro del mismo change, no bloqueante.

Este endpoint **espeja 1:1 el `OrchestratorSession` que el gateway BE ya tiene** (`session_id→sessionId`, `framed_ip→framedIp`, etc.). El mapper `toSession()` del adapter BE ya parsea exactamente este shape.

---

## Decisión 2 — Gateway BE: `listActiveSessions(offset?, limit?)`

El puerto `RadiusOrchestratorGateway` (`domain/ports/`) gana un método nuevo que pega al `GET /sessions` global y mapea a `OrchestratorSession` (tipo de dominio ya existente):

```ts
// domain/ports/RadiusOrchestratorGateway.ts
/**
 * Lista las sesiones ACTIVAS GLOBALES del RADIUS (radacct WHERE acctstoptime IS NULL).
 * Corresponde a `GET /sessions?offset=&limit=` del orchestrator → list[SessionResponse].
 * Fuente para los contadores PROPIOS del NAS (clientCount = sesiones cuyo framedIp ∈ pools del NAS;
 * lastSeen = max(startedAt) de esas sesiones). Fallo de red/5xx → OrchestratorUnreachableError.
 */
listActiveSessions(offset?: number, limit?: number): Promise<OrchestratorSession[]>;
```

- **`HttpRadiusOrchestratorGateway.listActiveSessions`** (`infrastructure/adapters/orchestrator/`): `this.http.get('/sessions', { params: { offset, limit } })`, mapeado con el `toSession()` ya existente, errores vía el `call()` ya existente (`OrchestratorUnreachableError`/`OrchestratorRejectedError`). REUSA todo lo que ya hay.
- **`InMemoryRadiusOrchestratorGateway.listActiveSessions`** (`infrastructure/adapters/in-memory/`): nuevo seed `activeSessions?: OrchestratorSession[]` en el constructor; el modo `unreachable` (global) lanza `OrchestratorUnreachableError`. Espeja el patrón de `assignedIps`.

DIP: el use case depende del PORT, NUNCA de axios/HTTP/Prisma.

---

## Decisión 3 — `NasLiveStatsProvider` (servicio de aplicación, espejo de `AssignedIpsProvider`)

Nuevo servicio inyectado a `ListNasServers`/`GetNasServer`. Computa `clientCount`/`lastSeen` en vivo para NAS RADIUS, con **una sola llamada global cacheada** y degradación best-effort:

```
NasLiveStatsProvider(nasRepo, ipNetworkRepo, orchestrator)
  // cache de la llamada global (la sesión activa es global, no por-NAS) → 1 fetch por request
  private sessions: Promise<OrchestratorSession[]> | null = null

  async enrich(nas: NasServer): Promise<NasServer>
    if (nas.type !== 'mikrotik_radius') return nas                 // legacy: intacto, NO llama al orchestrator
    try {
      const sessions = await this.activeSessions()                 // cacheada, .catch(()=>[]) interno
      const ranges   = await this.poolRangesFor(nas.id)            // ipNetworkRepo.findPoolsByNas(nas.id)
      const mine     = sessions.filter(s => s.framedIp && ipInAnyRange(s.framedIp, ranges))
      const clientCount = mine.length || nas.clientCount           // si 0 sesiones → fallback stored? ver nota
      const lastSeen    = maxStartedAt(mine) ?? nas.lastSeen
      return { ...nas, clientCount, lastSeen }
    } catch {
      return nas                                                   // degradación: valores stored
    }
```

### Algoritmo de atribución sesión → NAS (PINNED)

`clientCount` de un NAS `mikrotik_radius` = **cantidad de sesiones activas distintas cuyo `framedIp` cae dentro de algún rango de pool del NAS**.

1. Sesiones activas globales: `orchestrator.listActiveSessions()` (una sola vez, cacheada).
2. Rangos del NAS: `ipNetworkRepo.findPoolsByNas(nas.id)` → `[{rangeStart, rangeEnd}, …]`.
3. Por cada sesión con `framedIp != null`: cuenta si `framedIp ∈ [rangeStart, rangeEnd]` de **algún** pool (unión de rangos). Dedup a nivel de **sesión** (no de IP) para no doble-contar si los rangos se solapan.
4. Reusar la primitiva de `ipMath`: `countAssignedInRange(framedIps, rangeStart, rangeEnd)` cuenta IPs en un rango; para "∈ algún rango" sin doble-conteo, filtrar las `framedIp` que caen en la unión de rangos y contar sesiones únicas. (Helper de dominio `ipInAnyRange(ip, ranges)` apoyado en `ipToInt`/los bounds de `countAssignedInRange`.)

`lastSeen` = `max(startedAt)` de esas sesiones atribuidas, o el `lastSeen` stored si no hay ninguna (best-effort; no se inventa instante).

> **Atribución por pools, no por `nasIp`**: aunque `OrchestratorSession.nasIp` existe, atribuimos por `framedIp ∈ pools del NAS` para ser coherentes con cómo `AssignedIpsProvider`/`ListIpPools` ya recortan lo "del NAS" (el `nasIp` del radacct puede ser la IP del BRAS, no del registro NAS de Prominense). Mismo criterio en toda la página.

### Cacheo y degradación

- **Una sola llamada global por request**: `listActiveSessions()` se cachea en la instancia del provider (como `__radius_global__` en `AssignedIpsProvider`). Varios NAS RADIUS → 1 fetch. En prod hay un solo BRAS RADIUS, pero el patrón se respeta.
- **Degradación best-effort**: cualquier fallo de la fuente (orchestrator caído, timeout, 5xx) → el NAS sale con sus valores STORED. Un listado **NUNCA** revienta (lo consume el dropdown del InternetPanel). Igual que `AssignedIpsProvider`.
- **NAS legacy** (`type != 'mikrotik_radius'`): el provider lo devuelve sin tocar y **no llama** al orchestrator.

> **Nota sobre `clientCount === 0`**: si el orchestrator responde OK pero el NAS RADIUS tiene 0 sesiones atribuidas, el valor REAL es 0 (no se cae al stored: el stored es justamente el `0` mentiroso que queremos reemplazar). El fallback al stored solo aplica cuando la fuente NO respondió (catch).

---

## Decisión 4 — TIPO honesto (`displayType`) sin romper el ruteo

`nas.type` (`mikrotik_radius`) **gobierna el ruteo** (allocator, `AssignedIpsProvider`, este provider, enforcement) → **NO se cambia**. Se agrega un campo de display derivado, aditivo:

- Regla de derivación (función pura, testeable):
  - `mikrotik_radius` → `"BRAS RADIUS"`
  - `mikrotik_api` → `"MikroTik API"`
  - `cisco` → `"Cisco"`, `ubiquiti` → `"Ubiquiti"`, `cambium` → `"Cambium"`, `other` → `"Otro"`
- El FE puede adoptar `displayType` para el badge; si no lo adopta, sigue mostrando `type` (cero regresión).

### Contrato BE↔FE de salida de NAS (campo por campo) — el shape se MANTIENE, solo se AGREGA

```
NasServer (salida JSON de GET /api/nas-servers y /:id):
  id, name, type, ipAddress, radiusSecret(masked), nasIpAddress,
  apiPort, apiLogin, apiPassword(masked), status, description   ← sin cambios
  clientCount : number        ← MISMO campo, ahora REAL para mikrotik_radius (antes 0 stored)
  lastSeen    : string | null ← MISMO campo, ahora REAL/best-effort (antes — stored)
  displayType : string        ← NUEVO (aditivo). FE: usar para el badge si está presente
```

→ El FE renderiza `clientCount`/`lastSeen` reales SIN tocar nada. Único cambio FE opcional: leer `displayType` en el badge. Fix **BE-first**, cero cambios FE obligatorios.

> **DTO vs entidad**: hoy `ListNasServers`/`GetNasServer` devuelven la entidad `NasServer` cruda y la ruta hace `res.json(server)` sin mapear. Para respetar la convención (no devolver entidad cruda) y agregar `displayType`, se introduce un mapper de salida (DTO `NasServerDto` o extensión de la entidad de salida) aplicado en el use case. `displayType` se computa ahí, junto al enrich. Decisión de implementación: campo aditivo en el objeto de salida del use case; la ruta sigue serializando lo que el use case devuelve.

---

## Decisión 5 — Wiring (`app.ts`)

`orchestrator` ya está instanciado en `app.ts:1121` (singleton compartido por IP allocator/PPPoE/plan-catalog). `nasRepo` (`app.ts:1108`) e `ipNetworkRepo` (`app.ts:1049`) ya existen. Construir:

```ts
const nasLiveStats = new NasLiveStatsProvider(nasRepo, ipNetworkRepo, orchestrator);
const listNasServers = new ListNasServers(nasRepo, nasLiveStats);   // app.ts:1109
const getNasServer   = new GetNasServer(nasRepo, nasLiveStats);     // app.ts:1110
```

Sin nuevas dependencias de infra. El provider se instancia por construcción de app (su cache es por-request: en la práctica cada request reconstruye o el cache vive lo que dura el Promise.all del listado — coherente con `AssignedIpsProvider`, que se instancia dentro de `execute()`). **Detalle de implementación**: para garantizar cache *por request* (no compartida entre requests, que serviría datos viejos), el provider se instancia DENTRO de `ListNasServers.execute()`/`GetNasServer.execute()` a partir de las deps inyectadas (igual que `ListIpPools` hace `new AssignedIpsProvider(...)` en cada `execute`). Inyectar deps, instanciar provider por ejecución.

---

## Manejo de errores (resumen)

| Situación | Comportamiento |
|-----------|----------------|
| Orchestrator caído / timeout / 5xx | `listActiveSessions` → `OrchestratorUnreachableError`; el provider lo captura → NAS con valores STORED. Endpoint 200. |
| Orchestrator 4xx (token inválido) | `OrchestratorRejectedError`; capturado igual → valores STORED. Endpoint 200 (no se filtra el detalle al browser). |
| NAS RADIUS con 0 sesiones (fuente OK) | `clientCount = 0` REAL (no se cae al stored). |
| NAS legacy | Sin llamada al orchestrator; valores STORED intactos. |
| NAS sin pools (`findPoolsByNas` vacío) | `clientCount = 0` (ninguna sesión atribuible); `lastSeen` stored. |

---

## Test Strategy (TDD estricto — red→green→refactor)

Use cases con adapters **in-memory** (`InMemoryNasRepository`, `InMemoryIpNetworkRepository`, `InMemoryRadiusOrchestratorGateway`), NUNCA mockeando Prisma ni el use case. Patrón de referencia: `src/__tests__/application/IpNetworkCounts.test.ts`.

- **`InMemoryRadiusOrchestratorGateway.listActiveSessions`**: devuelve sesiones seedeadas; modo `unreachable` global lanza `OrchestratorUnreachableError`.
- **`NasLiveStatsProvider` / `ListNasServers`**:
  - NAS `mikrotik_radius` con sesiones cuyo `framedIp` cae en sus pools → `clientCount` real + `lastSeen` = max(startedAt).
  - NAS legacy (`mikrotik_api`, etc.) → `clientCount`/`lastSeen` STORED intactos (provider no llama al orchestrator).
  - Orchestrator caído (fake unreachable) → degrada al valor stored, NO lanza.
  - NAS RADIUS con 0 sesiones atribuidas (fuente OK) → `clientCount = 0` real.
  - Varios NAS RADIUS → una sola llamada global (assert de conteo de llamadas, como el test "no hace N+1").
  - `displayType`: `mikrotik_radius` → "BRAS RADIUS"; otros → label del type.
- **`GetNasServer`**: idem para el detalle (un NAS).
- **Seam de ruta** (`GET /api/nas-servers`, `GET /api/nas-servers/:id`): supertest sobre la app con use case REAL + gateway in-memory → el JSON trae `clientCount`/`lastSeen` reales + `displayType`. Verifica que el dato cruza route→use case→provider→gateway sin mockear el use case.
- **`HttpRadiusOrchestratorGateway.listActiveSessions`** (adapter): axios fake → pega a `/sessions` con params, mapea `SessionResponse[]` a `OrchestratorSession[]`, errores → `OrchestratorUnreachableError`/`OrchestratorRejectedError`.

### Orchestrator (pytest)
- `SessionControlService.list_all_active` delega a `list_active_paginated` (fake repo) → devuelve las sesiones seedeadas.
- `GET /sessions` router: lista paginada (offset/limit), `require_token` (sin token → 401), shape `SessionResponse`. Espeja `tests/unit/infrastructure/test_*_router_list.py` + `tests/unit/application/fakes.py` (`InMemorySessionRepository.list_active_paginated` ya existe).

---

## Verificación EN VIVO post-deploy (gotcha del workflow — OBLIGATORIO)

**La integración cross-repo NO está verificada hasta ejercerla por la capa real.** Los tests in-memory/pytest prueban el wiring de cada repo por separado, pero NO que el BE habla bien con el orchestrator desplegado. Tras deployar AMBOS repos:

1. Orchestrator: `curl -H "Authorization: Bearer <token>" https://<orchestrator>/sessions?limit=5` → debe responder `200` con `list[SessionResponse]` real del `radacct` vivo.
2. BE: `GET /api/nas-servers` contra el orchestrator desplegado → `MercAccesoSur` debe traer `clientCount ~160` (no 0) y `lastSeen` reciente (no `—`).
3. Si el orchestrator está caído al momento del check: el endpoint BE debe seguir respondiendo 200 con valores stored (degradación), nunca 500.

Sin este paso, la deuda sigue "verde en tests pero rota en prod".

---

## Riesgo principal

`lastSeen` se deriva de `started_at` (lo único que `SessionResponse` expone hoy), no de `acctupdatetime`. Es honesto pero menos fino. Mitigación: si ops necesita el `acctupdatetime`, agregar `last_update` a `SessionResponse` (aditivo, mismo change) — no bloqueante. El resto del riesgo (orchestrator caído) está cubierto por la degradación best-effort: en el peor caso `clientCount`/`lastSeen` caen al stored, sin 500.
