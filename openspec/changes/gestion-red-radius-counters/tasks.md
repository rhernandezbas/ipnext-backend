# Tasks: Contadores en vivo de NAS RADIUS en Gestión de Red

> **CAMINO A comprometido** (la query global ya existe en el orchestrator; solo se cablea).
> TDD estricto (red → green → refactor). BE: `test_command: npm test`. Orchestrator: `pytest`.
> Use cases con adapters in-memory, NUNCA mockeando Prisma/repo real ni el use case. Sin migración (read-path).
> DIP: use cases dependen del PORT, no de axios/HTTP/Prisma.

---

## Orchestrator (freeradius-orchestrator) — exponer `GET /sessions` global

> La query `list_active_paginated(offset, limit)` YA existe (outbound port + `SqlAlchemySessionRepository`). Esta sección solo la cablea al inbound port + service + ruta HTTP. No reimplementa RADIUS ni la query.

- [ ] **(test primero)** `SessionControlService.list_all_active`: con `FakeUnitOfWork` + `InMemorySessionRepository` (su `list_active_paginated` ya existe en `tests/unit/application/fakes.py`), sembrar N sesiones → `list_all_active(offset, limit)` devuelve el slice correcto. Espeja el test de `list_active`.
- [ ] `SessionControlPort` (inbound, `application/ports/inbound/session_control.py`): agregar `async def list_all_active(self, offset: int, limit: int) -> list[Session]: ...`.
- [ ] `SessionControlService` (`application/use_cases/session_control_service.py`): impl que delega `async with self._uow.begin(): return await self._uow.sessions.list_active_paginated(offset, limit)`.
- [ ] **(test primero)** Router `GET /sessions`: `TestClient` con `get_session_control` y `require_token` overrideados → lista paginada (offset/limit) con shape `SessionResponse`; sin token → 401. Espeja `tests/unit/infrastructure/test_*_router_list.py`.
- [ ] Router nuevo `infrastructure/adapters/inbound/http/routers/sessions_global.py`: `APIRouter(tags=["sessions"], dependencies=[Depends(require_token)])`, `@router.get("/sessions", response_model=list[SessionResponse])` con `offset:int=0`, `limit:int=1000`, delega `service.list_all_active(...)` y mapea `SessionResponse.from_domain`.
- [ ] `app.py`: `app.include_router(sessions_global.router)` (sin prefix global — ruta queda en `/sessions`).
- [ ] **(opcional, aditivo)** Si se quiere `lastSeen` con granularidad `acctupdatetime`: agregar `last_update: datetime | None` a `SessionResponse` + a `from_domain` (no breaking). Si NO, el BE deriva `lastSeen` de `started_at` (default de este change).

---

## Backend (ipnext-backend) — consumir `GET /sessions` y enriquecer NAS

### BE — gateway: `listActiveSessions`
- [x] **(test primero)** `InMemoryRadiusOrchestratorGateway.listActiveSessions`: seed `globalSessions?: OrchestratorSession[]` → devuelve las sesiones; `globalSessionsUnreachable: true` → lanza `OrchestratorUnreachableError`. **Fix A (Round 2):** el fake ahora honra `offset`/`limit` (`slice(offset, offset + limit)`) — antes devolvía la lista completa ignorando los params, causando loop infinito con ≥100 sesiones. Test: 250 sesiones → `clientCount=250` (loop pagina 3 veces, sin duplicar).
- [x] `RadiusOrchestratorGateway` (port, `domain/ports/`): agregar `listActiveSessions(offset?: number, limit?: number): Promise<OrchestratorSession[]>` con doc que espeja `GET /sessions`.
- [ ] **(test primero)** `HttpRadiusOrchestratorGateway.listActiveSessions` (axios fake, en `HttpRadiusOrchestratorGateway.test.ts`): pega a `/sessions` con `params {offset, limit}`, mapea `SessionResponse[]`→`OrchestratorSession[]` (reusa `toSession`); red/5xx → `OrchestratorUnreachableError`; 4xx → `OrchestratorRejectedError`.
- [x] `HttpRadiusOrchestratorGateway.listActiveSessions`: impl con `this.call(() => this.http.get('/sessions', { params }))` + `.map(toSession)`.
- [x] `InMemoryRadiusOrchestratorGateway`: impl del double + seed `globalSessions` + `globalSessionsUnreachable`.

### BE — `NasLiveStatsProvider` (servicio de aplicación, espejo de `AssignedIpsProvider`)
- [x] **(test primero)** `NasLiveStatsProvider.enrich`:
  - [x] NAS `mikrotik_radius` con sesiones cuyo `framedIp` ∈ pools del NAS → `clientCount` real + `lastSeen` = max(startedAt).
  - [x] NAS legacy (`mikrotik_api`) → devuelve el NAS sin tocar; NO llama al orchestrator.
  - [x] orchestrator caído → devuelve el NAS con valores STORED (no lanza).
  - [x] NAS RADIUS con 0 sesiones atribuidas (fuente OK) → `clientCount = 0` real (NO cae al stored).
  - [x] varios NAS RADIUS → una sola llamada global (cacheo; assert de conteo de llamadas).
- [x] Helper de dominio `ipInAnyRange(ip, ranges)` en `domain/services/ipMath.ts`, para atribuir `framedIp` ∈ unión de rangos sin doble-conteo.
- [x] `src/application/services/NasLiveStatsProvider.ts`: `enrich(nas) → Promise<NasServerDto>` + `enrichAll`, deps `(ipNetworkRepo, orchestrator)`, ruteo por `nas.type`, atribución por `findPoolsByNas` + `ipInAnyRange`, `lastSeen=max(startedAt)`, degradación `.catch(→ stored)`, cacheo de la llamada global. **Fix B (Round 2):** test de regresión del CRITICAL #1 (cache per-request): 2da llamada a `execute()` sobre la misma instancia del use case, con sessions mutadas entre llamadas, refleja el cambio (el provider se crea fresh por execute, no es singleton). **Fix C (Round 2):** eliminado `.catch(() => { throw new Error("unreachable") })` en `fetchAllSessions` — se tragaba el `OrchestratorUnreachableError` tipado; ahora la rejection propaga al try/catch de `enrich`. **Fix D (Round 2):** eliminado `.catch` por-NAS en `enrichAll` — era inalcanzable ya que `enrich()` nunca rejecta (todo path está dentro de su propio try/catch).

### BE — `displayType` (derivación pura)
- [x] `displayType` incorporado en `NasServerDto` (extiende `NasServer`): `"BRAS RADIUS"` para `mikrotik_radius`, `type` crudo para el resto. Campo aditivo — `nas.type` sin tocar.
- [ ] **(opcional)** función pura más descriptiva `displayTypeOf(type)`: `mikrotik_api`→"MikroTik API"; `cisco`→"Cisco"; etc. Pendiente para iteración futura si el FE lo necesita.

### BE — `ListNasServers` / `GetNasServer` (enriquecer)
- [x] **(test primero)** `ListNasServers` con `InMemoryNasRepository` + `InMemoryIpNetworkRepository` + `InMemoryRadiusOrchestratorGateway`: NAS RADIUS enriquecido; legacy intacto; orchestrator caído degrada; `displayType` presente; una sola llamada global para varios NAS RADIUS. (9 tests en `NasLiveCounters.test.ts`)
- [x] **(test primero)** `GetNasServer`: idem para el detalle.
- [x] `ListNasServers.ts`: inyectar `NasLiveStatsProvider` opcional (backwards compatible); `execute()` llama `enrichAll` que hace una sola llamada global.
- [x] `GetNasServer.ts`: inyectar `NasLiveStatsProvider` opcional; `execute()` llama `enrich`.

### BE — wiring + seam de ruta
- [x] `app.ts`: `NasLiveStatsProvider(ipNetworkRepo, orchestrator)` instanciado después del orchestrator singleton; `ListNasServers(nasRepo, nasLiveStats)` y `GetNasServer(nasRepo, nasLiveStats)` reciben el provider. `ipNetworkRepo` ya está disponible (lo usan `ListIpPools`/`ListIpNetworks`).
- [ ] **(test primero)** seam `GET /api/nas-servers` (supertest, use case REAL + gateway in-memory): JSON trae `clientCount` real + `lastSeen` + `displayType="BRAS RADIUS"` para el NAS RADIUS; orchestrator caído → 200 con stored.
- [ ] **(test primero)** seam `GET /api/nas-servers/:id`: idem para el detalle.

---

## Verificación (por repo)
- [ ] Orchestrator: `pytest` verde.
- [x] BE: `npm test` verde (5290 passed, 0 failed) + `tsc --noEmit` limpio (exit 0).
- [x] DIP preservado: `NasLiveStatsProvider` depende de los ports `IpNetworkRepository` + `RadiusOrchestratorGateway`; `ListNasServers`/`GetNasServer` dependen del port `NasRepository` + el service de aplicación. Ningún use case importa de `infrastructure/`.
- [x] Sin migración / sin cambio de `schema.prisma`.
- [x] NAS legacy: comportamiento idéntico al actual (regresión cero) — cubierto por test `NasUseCases.test.ts` (5 passed) + `NasLiveCounters.test.ts` caso legacy.
- [ ] Review adversarial (obligatorio): foco en degradación best-effort, atribución sesión→NAS por pools, contrato aditivo del DTO (no breaking), una-sola-llamada-global.

## Verificación EN VIVO post-deploy (OBLIGATORIO — la integración cross-repo NO está verificada hasta ejercerla por la capa real)
- [ ] Deploy orchestrator → `curl -H "Authorization: Bearer <token>" https://<orchestrator>/sessions?limit=5` responde 200 con `list[SessionResponse]` del `radacct` vivo.
- [ ] Deploy BE → `GET /api/nas-servers` contra el orchestrator desplegado: `MercAccesoSur` trae `clientCount ~160` (no 0) y `lastSeen` reciente (no `—`).
- [ ] Orchestrator caído al chequear → BE responde 200 con valores stored (degradación), nunca 500.

## Coordinación FE (change aparte en ipnext-frontend)
- [ ] El FE recibe `clientCount`/`lastSeen` reales SIN cambios (mismo shape). Único cambio opcional: leer `displayType` en el badge TIPO.

## Salida
- [ ] Gestión de Red muestra `CLIENTES`/`ÚLTIMO CONTACTO` reales para `MercAccesoSur` y un TIPO honesto, sin tocar el read-path ya correcto de pools/redes/asignaciones.
