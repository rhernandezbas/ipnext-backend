# Design: Mover PPPoE de NAS (radius-aware) — manual + automático

## Decisión 1 — Un solo core: `MovePppoeToNas` (radius-aware), el legacy queda como rama

Nuevo use case `MovePppoeToNas` que rutea por `routesViaOrchestrator(nas.type)`:

- **NAS radius (los 10 de prod):** el secret vive en el RADIUS central → NO hay create/remove de secrets. El move es: reasignar IP + actualizar `nasId` + kick.
- **NAS legacy (no-radius):** delega al flujo actual de `MovePppoeServiceToRouter` (create en destino → remove en origen → DB). Hoy no hay NAS legacy, pero el guard evita romper si reaparece uno.

La ruta `POST /pppoe/:id/move` pasa a llamar al nuevo use case. El contrato HTTP no cambia (mismo body `{nasId}`), la respuesta DTO ahora refleja la IP nueva.

## Decisión 2 — Secuencia del move radius (plano de control primero, patrón CreatePppoeService)

```
1. service = repo.findById(id); origen = nasRepo(service.nasId); destino = nasRepo(input.nasId)
2. guards: destino existe; destino ≠ origen (no-op si igual); destino es radius;
   service.status !== 'terminated'
3. newIp = FindFreeIp.execute({ nasId: destino.id, type: 'cgnat' })   ← si NoFreeIpError → abort, NADA cambió
4. orchestrator.changeFramedIp(username, newIp)                        ← control plane primero; si falla → abort
5. repo.upsertByUsername({ ..., nasId: destino.id, remoteAddress: newIp, ipMode: 'fixed' })
6. orchestrator.disconnectSessions(username)                           ← best-effort: si falla, log WARN
   (la sesión vieja seguirá con la IP vieja hasta reconectar; NO se revierte el move)
7. record evento historial (old NAS/IP → new NAS/IP, actor)
```

- **Orden 4→5**: igual que el repo hace en `CreatePppoeService` (si el orchestrator falla, la DB no queda mintiendo). Si la DB falla después del 4, el retry del move es idempotente (elige otra IP libre o la misma).
- **El kick (6) NO es transaccional con el move**: si el CoA-Disconnect falla (NAS viejo inalcanzable), el cliente cae solo por keepalive/re-auth natural. Log estructurado para visibilidad.

## Decisión 3 — Manual: la IP la elige SIEMPRE el sistema (no el operador)

El modal "Mover NAS" NO pide IP. El input es solo el NAS destino. Requisito del usuario: automático y a prueba de errores; el operador eligiendo IP es la fuente del bug original. (Pin manual de IP ya existe aparte: `PinPppoeIp`.)

## Decisión 4 — Auto-move: watcher que compara sesiones vivas vs NAS asignado

Fuente: `orchestrator.listAllSessions()` (cada sesión trae `username` + `nasIpAddress`). Cada tick:

```
1. sessions = listAllSessions()          (1 llamada, ~2.8k filas hoy)
2. nasByRadiusIp = map(NasServer.nasIpAddress → NasServer)   (los 10, 1 query)
3. services = repo por username de las sesiones (batch, 1 query)
4. mismatch = sesión cuyo NAS real (por nasIpAddress) ≠ service.nasId
5. para cada mismatch:
   a. si la IP ACTUAL del service es pública/pinned (ver D5) → log WARN 'auto-move skipped: public ip' + seguir
   b. si el NAS real no está mapeado en Prominense (nasIpAddress desconocida) → log WARN + seguir
   c. MovePppoeToNas.execute({ id, nasId: nasRealId, actor: 'auto-move' })
      · NoFreeIpError → log ERROR 'pool destino lleno' + seguir (reintenta el próximo tick)
```

- **Sin ventana anti-rebote** (decisión b del usuario): el mismatch se actúa al tick en que se ve. El intervalo del watcher ES el damping natural.
- Scheduler in-process, patrón `radius-auth-ingest` (`setInterval` + lock advisory + `parseIntervalMs` con piso/techo). **ON/OFF por feature flag `pppoe-auto-move` (DB `FeatureFlag`, toggle VISIBLE en la Config UI — patrón del toggle de `radius-auth-ingest`; default OFF)**, chequeado en cada tick → prender/apagar SIN deploy. Intervalo por env `AUTO_MOVE_INTERVAL_MS` (default **120000 = 2 min**, decisión del usuario).

## Decisión 5 — "Solo CGNAT": clasificación de la IP actual por los pools cargados

La IP actual del servicio se clasifica contra `IpPool` (rangos ya cargados, fuente de verdad):

- cae en un pool `ipKind='cgnat'` → **elegible** para auto-move.
- cae en un pool `ipKind='public'` → **NO elegible**: log WARN estructurado (`auto-move skipped: public`, username, NAS real vs asignado). El aviso al operador es el log + el mismatch visible en la UI (la columna NAS del tab PPPoE vs sesión); alerta Telegram queda para Ola 3.
- no cae en ningún pool conocido → **NO elegible** (conservador), log WARN.

El move manual NO tiene esta restricción (el operador decide), pero el modal avisa si la IP actual es pública.

## Decisión 6 — Registro DOBLE: historial del cliente + log VISIBLE en la page de auditoría

1. **Historial del servicio del contrato** (si `contractId != null`): evento tipo `modified` (del union canónico de 7 que el FE ya pinea — NO inventar un tipo nuevo sin tocar el contract test) con detalle `from {nas, ip} → to {nas, ip}` + trigger + actor (operador o "sistema"). Reusa `ContractServiceEventRepository`.
2. **`PppoeNasMoveEvent` (tabla NUEVA, migración aditiva)** — TODO intento de move (manual y auto, con o sin contrato) persiste una fila: `{id, username, pppoeServiceId?, fromNasId?, toNasId?, fromIp?, toIp?, trigger: 'manual'|'auto', outcome: 'moved'|'failed_no_free_ip'|'failed_orchestrator'|'skipped_public'|'skipped_unknown_nas', reason?, actorName?, createdAt}`. Es el registro VISIBLE que pidió el usuario: los fallos del auto-move (pool lleno) y los skips (IP pública) no pueden vivir solo en el stdout del container.
3. **Endpoint** `GET /api/pppoe/nas-move-events` (gate **`network.read`** — corregido en fix wave FE 2026-07-02: el tab vive en la page de auditoría de red cuyos 3 tabs vecinos gatean `network.read`; gatearlo `pppoe.read` dejaba el tab "visible pero muerto" (403) para roles NOC con `network.read`), paginado + filtros `outcome`/`trigger`/`username`. **Wire contract (campo por campo, lección #28):** `{ items: [{ id, username, fromNas: {id,name}|null, toNas: {id,name}|null, fromIp, toIp, trigger, outcome, reason, actorName, createdAt }], total, page, limit }`.
4. **FE**: tab **"Movimientos NAS"** en la page de auditoría de Gestión de Red (`/admin/networking/audit`, junto a Logs RADIUS / Auditoría NE8000 / Errores de auth), con badge por outcome (moved · fallo · skip) + filtros. ui-ux-pro-max.

Retención: purga best-effort >12 meses (mismo patrón que `RadiusEvent`); si complica W1, se difiere a W2 con nota.

## Hexagonal / DIP

- `MovePppoeToNas` y `AutoMovePppoe` dependen SOLO de ports: `PppoeServiceRepository`, `NasRepository`, `RadiusOrchestratorGateway`, `IpNetworkRepository` (+ `FindFreeIp` como colaborador de application).
- Nada de Prisma/Express en application. Tests con in-memory + fake del gateway.

## Ajustes post-review (fix wave 1, 2026-07-01 — 2 revisores adversariales, NO CLEAN)

1. **Errores HTTP → `errorHandler` como fuente ÚNICA.** Los handlers async del move y del listado terminan en `next(err)` (nunca `throw` pelado — Express 4 cuelga la request). `OrchestratorRejectedError` re-envía su `upstreamStatus` + code (patrón de la ruta create). `NO_FREE_IP`/`NO_POOL_FOR_NAS_TYPE` toman el status del errorHandler (422/404) — se elimina el 409 inline divergente. Los errores nuevos (`PPPOE_MOVE_MIXED_NAS_TYPES`, `PPPOE_TERMINATED`, `PPPOE_MOVE_PUBLIC_IP`) se mapean 409 en el errorHandler.
2. **Colisión de Framed-IP (TOCTOU): el orchestrator ES el guard autoritativo** — VERIFICADO en `user_management_service.py:203-218`: `set_framed_ip` valida `find_username_by_framed_ip` transaccional y rechaza con `FramedIpAlreadyAssigned` (4xx). El BE, ante ese rechazo (upstream 409), **reintenta UNA vez** con un `FindFreeIp` fresco (el snapshot nuevo ya ve la IP tomada); si el 2º intento también es rechazado → evento `failed_orchestrator` + 409 al caller. El fake in-memory del gateway modela la semántica real (registra la IP en `assignedIps` y rechaza duplicados).
3. **Anti-resurrección:** el move persiste con update NO-creador (por id), nunca `upsertByUsername` (el create-branch resucitaba filas borradas por un terminate/rename concurrente). Si la fila ya no existe → typed not-found, nada creado.
4. **Fallo de DB post-RADIUS:** si el update falla DESPUÉS del `changeFramedIp` exitoso, se registra best-effort un evento `failed_db` (reason `db_update_failed_after_radius_write`) y se propaga el error — era el único estado divergente sin rastro (y el watcher W2 NO lo cura: el mismatch sesión-vs-nasId no lo ve).
5. **Outcomes ampliados:** `+failed_db`, `+failed_router` (fallo del move legacy). También se registra `failed_orchestrator` cuando `FindFreeIp` muere por `OrchestratorUnreachableError` (reason `list_assigned_ips`). Los RECHAZOS de guard (no-op, mixto, terminated, pública-sin-force) responden 4xx directo al operador y NO persisten fila — la tabla registra intentos que llegaron a la asignación, no validaciones de input.
6. **Move manual de IP PÚBLICA exige `force: true`** en el body (409 `PPPOE_MOVE_PUBLIC_IP` sin él): mover un corporativo con pública pagada a CGNAT libera su IP contratada — no puede pasar por accidente. El modal del FE manda `force` tras el warning (REQ-FE-1 S9.3). **[SUPERSEDIDO por el ajuste 9: el guard es FAIL-CLOSED — exige force toda IP no clasificable como CGNAT, no solo la que cae en pool público. El copy (error BE + modal FE) debe decir "IP pública o no clasificada como CGNAT".]
7. **Kick fallido visible:** si `disconnectSessions` falla, el evento `moved` lleva `reason='kick_failed'` (el operador sabe que el cliente sigue con la IP vieja hasta re-auth natural).
8. Menores: no-op ANTES del guard terminated; `actorName` vacío se normaliza a null; test de orden kick-después-de-persistir con call-log compartido; regex del composition test acotada.

## Decisiones W2 (watcher auto-move, 2026-07-02)

**D-W2.1 — PRE-clasificación (nunca depender del guard 409).** El watcher clasifica la IP actual del servicio contra `IpPool` ANTES de llamar al move: en pool `cgnat` → `MovePppoeToNas` con trigger `auto` (sin force); en pool `public` → evento `skipped_public` SIN llamar al move; fuera de todo pool → `skipped_unknown_nas`... NO: `skipped_public` es para pública, el "fuera de todo pool" también va como `skipped_public` (reason `unclassified_ip`) porque el guard fail-closed del core lo trataría igual — o el outcome `skipped_unknown_nas` queda RESERVADO para el caso "el `nasIpAddress` de la sesión no mapea a ningún `NasServer`" (REQ-AUTO-1 S4.2). Resumen de outcomes del watcher: mismatch+cgnat → move; mismatch+no-cgnat → `skipped_public` (reason distingue `public_pool` vs `unclassified_ip`); sesión de NAS desconocido → `skipped_unknown_nas`; sesión sin `PppoeService` espejado → se ignora (contador en el log del tick, sin fila).

**D-W2.2 — Throttle de filas repetidas (anti-spam del tab).** Un mismatch no-accionable (pública, pool lleno) PERSISTE tick tras tick → sin throttle = 1 fila cada 2 min para siempre. Regla: antes de registrar un evento `skipped_*` o `failed_*` con trigger `auto`, consultar el último evento del username (repo `list({username, limit:1})`); si el último es IDÉNTICO (mismo outcome + mismo toNasId) y tiene menos de **6 horas**, NO registrar la fila (el intento/skip igual ocurre — solo se throttlea el REGISTRO). Los `moved` SIEMPRE se registran (cambian estado). El intento de move con pool lleno SÍ se reintenta cada tick (barato); solo la fila se throttlea.

**D-W2.3 — Flag + intervalo + lock.** Flag `pppoe-auto-move` en el catálogo `FeatureFlag` (seed OFF vía migración idempotente `ON CONFLICT DO NOTHING` si el catálogo lo requiere — estudiar cómo se seedearon `radius-auth-ingest`/`uisp-sync`), **chequeado en CADA tick** (patrón del toggle de radius-auth-ingest): OFF → el tick retorna sin trabajo. `AUTO_MOVE_INTERVAL_MS` default 120000 (2 min), `parseIntervalMs` piso 15s/techo 24h, inválido→default, NUNCA tumba el boot. Reentrancy guard + lock (patrón de los schedulers existentes) → un solo tick a la vez. Log estructurado por tick: `{sessions, mismatches, moved, skippedPublic, skippedUnknownNas, failed, throttled}`.

**D-W2.4 — Detección.** `listAllSessions()` (1 llamada) → map `NasServer.nasIpAddress → NasServer` (1 query, los 10 NAS) → servicios por username de las sesiones (batch) → mismatch = NAS real ≠ `service.nasId`. Username con MÚLTIPLES sesiones vivas: usar la más RECIENTE (por startedAt); si las sesiones vivas están en NAS distintos entre sí (transitorio de re-auth), saltear ese tick (converge solo). Servicios `terminated` o `ipMode` raro: los guards del core ya los rechazan — el watcher no duplica guards, solo pre-clasifica CGNAT.

## D-W2.5 — Endurecimiento post-review W2 (2026-07-02, 2 revisores: 3 CRITICAL + 8 W/S)

1. **Circuit breaker (C3 — sin esto NO se prende el flag):** `AUTO_MOVE_ABORT_THRESHOLD` (default 25) — mismatches del tick > umbral ⇒ ABORTAR el tick SIN mover nada (huele a error de inventario: NAS duplicado, nasIpAddress mal editada) + WARN + `aborted: true` en el summary. `AUTO_MOVE_MAX_MOVES_PER_TICK` (default 10) — se procesan a lo sumo N moves por tick; el resto queda para el próximo (counter `deferred`). Ambas envs con parse seguro (inválido→default, jamás tumban el boot).
2. **Cooldown anti-revert (C2a):** antes de ejecutar un move, consultar el último evento `moved` del username (CUALQUIER trigger): si < `AUTO_MOVE_COOLDOWN_MS` (default 600000 = 10 min) ⇒ skip con counter `skippedCooldown` (sin fila). Evita que el watcher deshaga un move manual recién hecho.
3. **Re-verificación pre-execute (C2b/S10):** justo antes del execute de CADA move: (a) re-fetch del servicio (`findById` fresco) — si `nasId` ya == target ⇒ counter `alreadyConverged`, sin move; (b) re-fetch de las sesiones del username (`listSessions(username)`) — si el ganador fresco ya no apunta al target ⇒ skip. Mata la ventana del snapshot envejecido.
4. **Liveness / freshness (C1):** la sesión GANADORA debe tener actividad reciente: `lastUpdate`/`acctupdatetime` si el wire del orchestrator lo trae (VERIFICAR el schema de `/sessions`; extender port+gateway+fakes ADITIVAMENTE si está en el wire y el port lo dropea), fallback `startedAt`. Actividad más vieja que `AUTO_MOVE_SESSION_FRESHNESS_MS` (default 259200000 = 72h) ⇒ NO actuar: outcome nuevo **`skipped_stale_session`** (fila, throttled). Fail-safe: una sesión colgada vieja jamás dispara un move; el move físico real siempre genera sesión fresca en el NAS nuevo.
5. **Conflicto multi-NAS persistente (W7/rev2-W2):** sesiones vivas en NAS distintos ⇒ outcome nuevo **`skipped_nas_conflict`** (fila, throttled) en vez de WARN invisible — el estado terminal del C1 queda VISIBLE en el tab. Los 2 outcomes nuevos degradan graceful en el FE actual (`OutcomeBadge` renderiza texto plano para desconocidos); labels/filtros se agregan en la wave FE del flag.
6. **Terminated pre-filter (W4):** el watcher salta `status==='terminated'` ANTES de llamar al core (counter `skippedTerminated`, sin fila) — se acabó el `failed++` eterno invisible.
7. **Throttle v2 (W5/W6/S9):** igualdad EXACTA de username vía filtro exacto en el repo (param aditivo `usernameExact` en port + Prisma + InMemory); suprimir SOLO si el último evento es `trigger='auto'`; la comparación incluye `reason` además de outcome+toNasId; si el CHECK del throttle lanza (DB hiccup) ⇒ fail-open (registrar la fila igual).
8. **Summary honesto:** `moved++` solo si hubo move real (no no-ops); summary agrega `aborted`, `deferred`, `skippedCooldown`, `alreadyConverged`, `skippedTerminated`, `skippedStale`, `nasConflicts`.
9. **Menores:** `env.example` documenta TODAS las envs nuevas del watcher; composition test pinea que el gateway del bootstrap sale de `config.orchestrator`; el cuerpo del tick del scheduler con catch propio prefijado `[pppoe-auto-move]`.

**FE (bloqueante del go-live, task 4.4b):** card `PppoeAutoMoveCard` en la page de flags de Config (patrón EXACTO de `RadiusAuthIngestCard`, `FLAG_KEY='pppoe-auto-move'`) + labels/filtros de los 2 outcomes nuevos en el tab "Movimientos NAS".

## Ajustes post-re-review (mini fix wave, 2026-07-01)

9. **Guard de pública FAIL-CLOSED:** requiere `force` toda IP NO clasificable como CGNAT (pública **o fuera de todo pool conocido**). Razón: en prod solo 3 NAS tienen pools públicos cargados — fail-open dejaba sin protección a los públicos de parque/canepa/hípico/rodriguez/ugarte/opendoor. IP en pool cgnat → procede sin force.
10. **Rama `!updated` (S1.7) registra evento** `failed_db` reason `row_deleted_after_radius_write` — era el último path de divergencia RADIUS-escrito sin rastro.
11. **Ventana del composition test cortada en el `));` de cierre** (el margen de 4000 chars se comía con ~2 use cases más).

**Deudas anotadas (NO de esta wave):** fidelidad del fake del gateway (`createUser`/`deleteUser` no registran/liberan `ipOwners` — deuda de test-double); cargar en Prominense los pools públicos faltantes (parque 190.15.242.x, etc.) — mejora de visibilidad en Gestión de Red, ya NO es prerequisito del guard (fail-closed lo cubre).

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Pool destino lleno | Abort ANTES de tocar nada; cliente queda como estaba; log + retry por tick |
| changeFramedIp ok pero DB falla | Retry idempotente; el watcher re-detecta el mismatch y converge |
| Kick falla (NAS viejo muerto) | Best-effort + log; el cliente converge al re-auth natural |
| Sesión duplicada/colgada en radacct (acctstoptime NULL viejo) | `listAllSessions` del orchestrator ya filtra sesiones vivas; si un stale genera mismatch, el move es convergente (lo lleva al NAS real de la sesión) — y el caso conocido de sesiones colgadas tiene su card aparte (Ola 3) |
| Watcher pisándose con un move manual simultáneo | El move es idempotente y el no-op (`nasId` igual) corta; ventana ínfima |
| Falso mismatch por `nasIpAddress` mal cargada | Guard 5b (NAS desconocido → skip + WARN); los 10 verificados en prod 2026-06-30 |
