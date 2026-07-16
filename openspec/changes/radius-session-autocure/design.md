# Design: Auto-curación de sesiones RADIUS colgadas + log auditable

> Tres changes coordinados: **ORCH-1** (Python, repo `freeradius-orchestrator`), **BE-1** (este repo), **FE-1** (repo FE). Evidencia file:line verificada 2026-07-16 sobre los repos reales + dos análisis en vivo (r1/MariaDB/radacct).

## D1 — Qué significa "curar": CoA Disconnect best-effort + cierre contable idempotente (ORCH-1)

Curar una sesión colgada son DOS acciones, en este orden:

```
1. CoA Disconnect (best-effort)  → si el NAS todavía la sostiene, la tira; si no responde, seguimos
2. UPDATE radacct
     SET acctstoptime      = COALESCE(acctupdatetime, NOW()),
         acctsessiontime   = TIMESTAMPDIFF(SECOND, acctstarttime, <ese stoptime>),
         acctterminatecause = 'Admin-Reset'
   WHERE acctsessionid = :sid AND username = :user AND acctstoptime IS NULL
```

Decisiones dentro de D1:

- **`acctstoptime = acctupdatetime` (fallback `NOW()`)** — el fin ESTIMADO honesto: la última señal de vida conocida (interim). Poner `NOW()` de primera inflaría la sesión con hasta 20+ min de vida inventada. Fallback `NOW()` solo cuando `acctupdatetime IS NULL` (sesión que nunca mandó interim — el caso de la regla horaria del cron).
- **`acctsessiontime` SÍ se recalcula** (`stoptime - acctstarttime` en segundos): deja la fila internamente coherente (stop − start == sessiontime). Dejarlo como estaba mentiría contra el stoptime estimado. Documentado en el endpoint.
- **`acctterminatecause = 'Admin-Reset'`** (causa RFC 2866 de desconexión administrativa): distingue la cura del orchestrator frente al cron (`Lost-Carrier` / `Session-Timeout`) → cualquier post-mortem sobre radacct sabe QUIÉN cerró cada sesión.
- **Idempotencia = el `WHERE acctstoptime IS NULL`** (por `radacctid` ya resuelto, ver D2/D9 — enmienda CRITICAL-2): si el cron (o un doble-click, u otro tick) ya la cerró, el UPDATE afecta 0 filas → respuesta `{cured: false, already_closed: true, coa: [...]}` con 200. **Ese es el contrato anti doble-curador**: watcher y cron pueden correr a la vez sin pisarse — el segundo en llegar hace un no-op limpio.
- **Orden CoA→UPDATE**: el CoA va primero y FUERA de la transacción (molde exacto de `SessionControlService.disconnect_all`, `session_control_service.py:40-73`: resolver targets dentro de `begin()`, red fuera, excepción de CoA jamás se vuelve 500). Si el CoA falla o el NAS no responde (esperable: la sesión está colgada justamente porque el NAS la perdió), el cierre contable procede IGUAL — cerrar radacct es lo que destraba el `Simultaneous-Use=1`.

## D2 — Endpoint `POST /users/{username}/sessions/{session_id}/cure` (ORCH-1)

- **Router**: `sessions.py` (prefix ya existente `/users/{username}/sessions`, `sessions.py:20-24`, auth `require_token`). Ruta nueva: `POST /{session_id}/cure`.
- **Use case**: `SessionControlService.cure_session(cmd)` — nuevo método junto a `disconnect_all` (`session_control_service.py:40`). Comando inbound `CureSessionCommand {username, session_id}` en `ports/inbound/session_control.py` (molde `DisconnectSessionsCommand`, línea 10-12).
- **Primer write a radacct**: nuevos métodos en el port outbound `SessionRepository`. **[ENMIENDA fix wave 2026-07-16 — review adversarial CRITICAL-2]**: `acctsessionid` puede estar REUSADO (MikroTik reasigna el mismo sid en cada reboot del NAS, `mapping.py:80-84`) — cerrar por `(username, acctsessionid)` podía matchear DOS filas abiertas (la colgada vieja Y la sesión viva recién creada) y corromper la viva. Fix: `find_by_id(username, session_id)` filtra `acctstoptime IS NULL` + ordena por `acctstarttime ASC` (la más vieja primero) + expone el `radacctid` (PK real de radacct) de esa fila; `find_any_by_id(username, session_id)` preserva el lookup viejo (abierta o cerrada) para resolver 404 vs `already_closed` y el NAS target del CoA cuando no hay fila abierta; `close_stale(radacctid)` cierra ATÓMICAMENTE `WHERE radacctid = :id AND acctstoptime IS NULL` — nunca por username+acctsessionid. La implementación va en `SqlAlchemySessionRepository` (`session_repository.py:15`), que YA es miembro del UoW (`unit_of_work.py:17`, `uow.sessions`) → el write entra en la MISMA transacción/patrón que los writes existentes de `user_repository.py` (radcheck/radreply), y el segundo `begin()` COMITEA explícitamente (CRITICAL-1 — sin esto el UPDATE se rollbackeaba). **No es el primer write del orchestrator a MariaDB — es el primer write a radacct**; el write-path (VIP, UoW, commit/rollback) está probado en prod.
- **Respuestas** — **[ENMIENDA fix wave 2026-07-16 — decisión del orquestador HIGH-3]**: wire canónico snake_case + detalle CoA completo (no un bool derivado). 200 `{cured: true, already_closed: false, closed_at, coa: [CoAResultResponse, ...]}` | 200 `{cured: false, already_closed: true, closed_at: null, coa: [...]}` (fila existía pero ya cerrada) | 404 si NO existe fila con ese `acctsessionid`+`username` (ni abierta ni cerrada). `coa` es un array de 0 o 1 `CoAResultResponse` (`{nas_ip, status, detail}`) — vacío si no había NAS conocido o el dispatcher lanzó excepción; el ACK/NAK/timeout se lee del `status` de cada item, SIEMPRE informativo, nunca bloquea el cierre contable.
- **Domain event `SessionCured`** en `domain/events/events.py` (molde `SessionDisconnected`, `events.py:38-42`): `{username, session_id, nas_ip, stop_time_source: 'acctupdatetime'|'now', coa_ok: bool}` → publicado al `LogEventPublisher` (log estructurado = rastro en el orchestrator). `coa_ok` se deriva de `any(r.status is ACK for r in coa)`.

## D3 — `last_update` expuesto en `SessionResponse` (ORCH-1)

`Session.last_update` ya existe en dominio (`session.py:16`) y ya se mapea desde `acctupdatetime` (`mapping.py:70`). El schema HTTP lo dropea (`schemas/session.py:12-20`). Cambio: campo `last_update: datetime | None` + serializer `db_naive_to_utc_z` (idéntico a `started_at`, `schemas/session.py:24-26`) + una línea en `from_domain`. Los consumidores existentes (BE `HttpRadiusOrchestratorGateway`) ignoran campos desconocidos → cambio backward-compatible.

## D4 — Versionar el cron de r1 como red de seguridad (ORCH-1)

- **Archivo nuevo** `deploy/cron.d/radius-cleanup` — copia VERBATIM del `/etc/cron.d/radius-cleanup` vivo en r1 (verificado 2026-07-16: cada 30 min cierra `acctupdatetime < NOW()-20min` como `Lost-Carrier`; cada hora cierra `acctupdatetime IS NULL AND acctstarttime < NOW()-2h` como `Session-Timeout`), con header comentado: por qué existe, por qué 20 min (validado: interim 600 s; 84 % de las 5166 sesiones <10 min de frescura, 0 >30 min; <20 min = falsos positivos), y su rol POST-watcher: **safety net** — cubre sesiones colgadas que nunca generan rechazo (cliente que no reintenta), BE de Prominense caído, y el caso `acctupdatetime IS NULL`.
- **Instalación**: referenciado desde el script de deploy correspondiente en `deploy/` (los bootstrap-*.sh existentes) — decisión fina en el apply; mínimo aceptable: el archivo versionado + doc de instalación en el header.
- **NO se cambian las reglas del cron en este change**: primero visibilidad/versionado; recalibrar cadencias es un follow-up con datos del watcher.

## D5 — BE watcher `AutoCureStuckSessions`: detección desde lo YA ingerido, cero barrido nuevo (BE-1)

Molde estructural completo: `PppoeAutoMoveScheduler.ts` (setInterval + `unref()` + `inFlight` síncrono + `DistributedLock` + flag por tick + catch propio del tick + `runOnce()` para tests, líneas 34-117) y `bootstrapPppoeAutoMove.ts` (null sin `ORCHESTRATOR_BASE_URL`, adapters frescos, tuning inyectado desde config, líneas 38-81).

Pipeline del tick:

```
1. eventos = RadiusAuthEventRepository.list({ reason: 'session_stuck',
     from: now - LOOKBACK, page: 1, pageSize: 500 })          ← port EXISTENTE (RadiusAuthEventRepository.ts:39-51)
2. agregado por username: { firstReject, lastReject }          ← dedupe intra-tick + INSUMO del fast path (D6)
3. breaker: |usernames| > ABORT_THRESHOLD → ABORT del tick     ← incidente masivo (NAS caído) ≠ sesión colgada
4. cap: procesar a lo sumo MAX_PER_TICK (resto → deferred)
5. por username (aislamiento de fallos por ítem):
   a. cure-throttle anti-flapping: último 'cured' < COOLDOWN_MS (30 min) → skip (counter, sin fila)
   b. flapping: ≥ FLAPPING_MAX eventos 'cured' del username en 24 h → fila `flagged_flapping`, NO curar (D7)
   c. sessions = gateway.listSessions(username)                 ← fresco, del orchestrator
   d. gates FAIL-CLOSED + DOS caminos de cura (D6, enmienda fast-path)
   e. cura: gateway.cureSession(username, sessionId)  →  fila RadiusSessionCureEvent (con signalUsed)
```

- **Detección = `RadiusAuthEvent` con `reason='session_stuck'`** ya ingeridos por `RadiusAuthIngestScheduler` (tick 60 s): cero queries nuevas contra el orchestrator/MariaDB para detectar. El filtro `reason` + `from` ya existe en el port (`RadiusAuthEventFilters`, `RadiusAuthEventRepository.ts:15-20`).
- **LOOKBACK default 15 min** (`RADIUS_AUTO_CURE_LOOKBACK_MS`): cubre el atraso del ingest + ticks perdidos sin re-barrer histórico, y DEBE ser mayor que `PERSISTENCE_MS + RECENCY_MS` (la ventana del fast path vive DENTRO del lookback; defaults 15 > 5+2, con clamp de coherencia en config). Un evento stuck más viejo que el lookback ya lo curó el cron (ventana 50 min > lookback + threshold).
- **Latencia esperada de cura (enmienda fast-path)**: la sesión muere en T0 → el cliente redialea y los rejects `session_stuck` arrancan ~T0 → persistencia cumplida en T0+5 min → ingest (≤60 s) + tick (≤60 s) ⇒ **cura en ~5-7 min desde la muerte de la sesión** (requisito del usuario: ~5 min). El camino `stale_interim` (cliente que dejó de redialear dentro del lookback) cura a los ~20-22 min, y el cron versionado sigue cubriendo el worst-case ~50 min como safety net para fantasmas SIN redial.

## D6 — Verificación por username: DOS caminos de cura + gates FAIL-CLOSED (BE-1) — [ENMIENDA fast-path 2026-07-16]

**Restricción DURA que motiva el diseño**: con `Acct-Interim-Interval = 600 s`, un umbral de staleness <20 min produce falsos positivos masivos (medido: 84 % de las sesiones sanas tienen frescura <10 min, 16 % entre 10-30 min). El requisito del usuario de reaccionar en **~5 minutos** NO se resuelve bajando ese umbral — se resuelve con un SEGUNDO camino de cura independiente de la señal de interim.

Por username, sobre `sessions = gateway.listSessions(username)` frescas y el agregado de rejects del tick (`firstReject`/`lastReject`), en este orden:

| # | Condición | Acción | Outcome / signalUsed |
|---|---|---|---|
| 1 | 0 sesiones abiertas | el cron/otro ya curó, o cerró sola | skip `skipped_no_session` |
| 2 | sesiones abiertas en NAS DISTINTOS entre sí | ambigüedad real | skip `skipped_ambiguous` |
| 3 | alguna sesión SIN `lastUpdate` en el wire (orchestrator viejo) | sin señal ⇒ sin cura | skip `skipped_no_signal` |
| 4 | **FAST PATH**: `lastReject - firstReject >= PERSISTENCE_MS` (5 min) Y `now - lastReject <= RECENCY_MS` (2 min — el cliente SIGUE marcando) | curar TODAS las sesiones abiertas, SIN exigir staleness — el interim fresco NO bloquea | `cured` · `signalUsed='persistent_rejects'` |
| 5 | sin persistencia + ALGUNA sesión fresca (`now - lastUpdate < STALE_MS`) | usuario posiblemente vivo, rejects aún no sostenidos | skip `skipped_alive` |
| 6 | sin persistencia + TODAS stale (`> STALE_MS`) y mismo NAS | curable clásico | `cured` · `signalUsed='stale_interim'` |

- **Justificación de seguridad del fast path (new-wins)**: `Simultaneous-Use := 1` está en los 81 grupos de `radgroupcheck` (TODOS = 1) — es POLÍTICA de red: no existe el doble-login legítimo. Un cliente que insiste ≥5 min contra un reject `session_stuck` ES el titular intentando conectarse → "el que marca gana". Costo del falso positivo (curar una sesión viva del mismo titular en otro dispositivo): micro-corte ~30 s + redial automático del otro dispositivo. Acotado y aceptado por decisión del usuario (2026-07-16).
- **Los gates 1-3 aplican a AMBOS caminos**: `skipped_ambiguous` (NAS distintos) y `skipped_no_signal` bloquean también al fast path — fail-closed uniforme, y `no_signal` preserva la propiedad de orden de deploy (BE-1 antes que ORCH-1 ⇒ nada se cura, queda visible en la tabla). `skipped_alive` es el ÚNICO gate que el fast path saltea (el reject sostenido pesa más que el interim fresco).
- **`PERSISTENCE_MS` default 300 000 (5 min), piso 2 min** (`RADIUS_AUTO_CURE_PERSISTENCE_MS`) y **`RECENCY_MS` default 120 000 (2 min), piso 30 s** (`RADIUS_AUTO_CURE_REJECT_RECENCY_MS`): la persistencia corta evita curar por una ráfaga transitoria de redial; la recencia exige que el cliente SIGA intentando (rejects viejos sin recencia = dejó de marcar → que decida el camino stale/cron). Restricción de coherencia: `LOOKBACK_MS > PERSISTENCE_MS + RECENCY_MS` (defaults 15 > 5+2 — validado con clamp en config).
- **`STALE_MS` default 1 200 000 (20 min), PISO DURO 20 min** (`RADIUS_AUTO_CURE_STALE_MS`): el umbral está VALIDADO con datos (interim 600 s; 0 sesiones sanas >30 min sin interim). El piso impide que un fat-finger baje el gate a territorio de matar sesiones vivas SIN la evidencia de rejects sostenidos que sí tiene el fast path. Techo 24 h. Parse patrón `parseIntervalMs` (config.ts:201-206).
- **El gate NO usa `startedAt` como fallback de señal**: una sesión sin interim no es diagnosticable desde acá — la cubre la regla horaria del cron (2 h). Fail-closed estricto.

## D7 — Anti-tormenta y anti-flapping: breaker + cap + cure-throttle + flapping flag + throttle de registro (BE-1, molde AutoMovePppoe D-W2.5) — [ENMIENDA 2026-07-16]

- **Circuit breaker** `RADIUS_AUTO_CURE_ABORT_THRESHOLD` (default 20): más de N candidatos únicos en un tick ⇒ ABORT sin curar nada + WARN + `aborted: true` en el summary. **SE MANTIENE con la enmienda fast-path**: decenas de stuck simultáneos = NAS caído u outage — eso NO se cura de a uno, se escala (el caso vialidad de hoy, 23 stuck del mismo NAS `10.60.0.10`, habría abortado el tick: comportamiento CORRECTO). Parse `parsePositiveInt` (molde config.ts:244-247).
- **Cap por tick** `RADIUS_AUTO_CURE_MAX_PER_TICK` (default 5): resto queda `deferred` para el próximo tick (el evento sigue en el lookback).
- **Cure-throttle anti-flapping** `RADIUS_AUTO_CURE_COOLDOWN_MS` (default **1 800 000 = 30 min**, enmienda — antes 10 min): una cura por username cada 30 min MÁXIMO. Si el último evento `cured` del username es más nuevo, skip sin fila (`skippedCureThrottle`). Primera línea de defensa contra el ping-pong new-wins (dos dispositivos con la misma credencial curándose mutuamente).
- **Flapping flag** (NUEVO): si el username acumula ≥ `RADIUS_AUTO_CURE_FLAPPING_MAX` (default 3) eventos `cured` en las últimas 24 h (ventana fija documentada) ⇒ NO curar más mientras la condición persista + fila `flagged_flapping` (throttled 6 h como todo skip) — VISIBLE en la UI de curas: 3+ curas/día del mismo username delata credencial compartida o sesión clonada, y eso es un caso de SOPORTE, no de auto-cura. La consulta es barata: `list({usernameExact, outcome:'cured', from: now-24h})` sobre índice existente.
- **Throttle 6 h del REGISTRO** (molde exacto D-W2.2 / `pppoeNasMoveThrottle.ts` referenciado en `AutoMovePppoe.ts:17,588`): un `skipped_*`/`failed`/`flagged_flapping` IDÉNTICO (mismo outcome + mismo reason) al último evento del username con <6 h NO genera fila nueva (el chequeo igual ocurre; solo se throttlea el spam de la tabla). Los `cured` SIEMPRE registran. Check fail-open ante hiccup de DB (se registra igual).
- **Tick** `RADIUS_AUTO_CURE_INTERVAL_MS` default 60 000 (molde `radiusAuthIngest`, config.ts:201-206: piso 15 s, techo 24 h, inválido→default, JAMÁS tumba el boot). **Flag** `radius-auto-cure` (FeatureFlag DB, seed OFF, chequeado EN CADA tick — prender/apagar sin deploy). **Lock** `radius-auto-cure` (PgAdvisoryLock). **Log estructurado por tick**: `{events, candidates, cured, alreadyCured, failed, skippedAlive, skippedAmbiguous, skippedNoSession, skippedNoSignal, skippedCureThrottle, flaggedFlapping, deferred, throttled, aborted}`.

## D8 — Registro: tabla `RadiusSessionCureEvent` + endpoints (BE-1)

Molde 1:1 de `PppoeNasMoveEvent` (`schema.prisma:1902-1925`): append-only, **soft refs sin FK** (el log sobrevive al borrado de NAS/servicio), **outcome String libre** (outcomes nuevos sin migración), mismos 4 índices.

```prisma
model RadiusSessionCureEvent {
  id                String   @id @default(uuid())
  username          String
  nasIp             String?
  sessionId         String?   // acctsessionid de la sesión curada/evaluada
  sessionStartedAt  DateTime?
  sessionLastUpdate DateTime? // el interim al momento de evaluar (null si no había señal)
  signalUsed        String?   // 'persistent_rejects' (fast path) | 'stale_interim' (camino clásico) — qué evidencia justificó la cura; null en skips (enmienda 2026-07-16)
  trigger           String    // 'auto' | 'manual'
  action            String?   // 'both' | 'acct_close' | 'coa' | null — qué se ejecutó efectivamente
  outcome           String    // 'cured' | 'already_cured' | 'skipped_alive' | 'skipped_ambiguous' | 'skipped_no_session' | 'skipped_no_signal' | 'flagged_flapping' | 'failed'
  reason            String?
  actorName         String?   // 'sistema' (auto) | nombre del operador (manual)
  createdAt         DateTime @default(now())

  @@index([createdAt])
  @@index([username])
  @@index([outcome, createdAt])
  @@index([trigger, createdAt])
}
```

- **`GET /api/radius/session-cures`** — GEMELO de `GET /auth-failures` (`radius.routes.ts:247-291`): mismo router (`/api/radius`, app.ts:1911), mismo guard `network.read` (`radius.routes.ts:72`), misma validación defensiva de query params (enums de outcome/trigger, `parseIntPositive`, `parseDate`). Filtros: `username?`, `outcome?`, `trigger?`, `from?`, `to?`, `page`, `limit` (default 50, cap 200 — molde `ListRadiusAuthFailures.ts:31-33`). **Wire contract campo por campo**: `{ data: [{ id, username, nasIp, sessionId, sessionStartedAt, sessionLastUpdate, signalUsed, trigger, action, outcome, reason, actorName, createdAt }], total, page, limit, hasNext, countsByOutcome }` — `countsByOutcome` espejo de `countsByReason` (`ListRadiusAuthFailures.ts:60-69`): ignora el filtro `outcome`, alimenta los chips del FE.
- **`POST /api/radius/session-cures`** — cura MANUAL (escape hatch). Guard **`network.manage`** (espejo de `DELETE /sessions/:id`, `radius.routes.ts:73`). Body `{ username, sessionId, force? }`. Sin `force`: respeta los gates D6 — si da alive/ambiguous responde 409 tipado (`CURE_SKIPPED_ALIVE` / `CURE_SKIPPED_AMBIGUOUS`) SIN curar. Con `force: true` (el FE lo manda tras la SEGUNDA confirmación explícita): saltea los gates alive/ambiguous y cura igual — es la misma potestad que ya tiene el operador con el disconnect manual, más el cierre contable. SIEMPRE registra fila `trigger='manual'` + `actorName` del operador (incl. los 409: outcome `skipped_*`). El manual NO pasa por throttle (una acción deliberada siempre deja rastro).
- **Use cases**: `CureStuckSession` (core: gates + cura + registro — lo comparten watcher y ruta manual) + `AutoCureStuckSessions` (orquesta el tick: lookback, breaker, cap, cooldown) + `ListRadiusSessionCures` (lectura). DIP estricta: dependen SOLO de ports (`RadiusAuthEventRepository`, `RadiusOrchestratorGateway`, `RadiusSessionCureEventRepository` nuevo, `FeatureFlagRepository`, `DistributedLock` en el scheduler). Tests con in-memory + fake del gateway.

## D9 — Extensión ADITIVA del gateway port (BE-1)

`RadiusOrchestratorGateway.ts` (port, líneas 186-268) y `HttpRadiusOrchestratorGateway` + fakes:

- **`OrchestratorSession.lastUpdate: string | null`** — campo nuevo opcional-null en el DTO (`RadiusOrchestratorGateway.ts:18-28` hoy NO lo tiene); parseado del `last_update` del wire (D3); `null` si el orchestrator no lo manda (⇒ gate `skipped_no_signal`). Precedente exacto: `AccountingEventRow.lastUpdate` (`RadiusOrchestratorGateway.ts:118`).
- **`cureSession(username: string, sessionId: string): Promise<CureSessionResult>`** — método nuevo → `POST /users/{username}/sessions/{sessionId}/cure` (sessionId con `encodeURIComponent`). **[ENMIENDA fix wave 2026-07-16 — decisión del orquestador HIGH-3]**: el gateway BE tipa `CureSessionResult = { cured: boolean, already_closed?: boolean, coa: CoAResult[] }` — snake_case (consistencia del wire del repo ORCH) y con el detalle CoA completo; `coaSent`/`coa_sent` (bool) NO existe en el wire, el ACK se deriva del array (`coa.some(r => r.status === 'ack')`) si el consumidor lo necesita. Errores: 404 upstream → error tipado (fila desapareció entre list y cure — outcome `failed`, reason `session_not_found`); red/5xx → `OrchestratorUnreachableError` (patrón existente, `RadiusOrchestratorGateway.ts:15`).
- Los fakes in-memory modelan la semántica REAL: `cureSession` sobre sesión ya cerrada devuelve `already_closed: true` (lección del fake de `changeFramedIp`, design pppoe-move-nas ajuste 2).

## D10 — FE-1: tab "Sesiones curadas" + botón manual

- **Tab/sección "Sesiones curadas"** en la page de auditoría RADIUS (donde viven Logs RADIUS / Errores de auth): tabla paginada del `GET /api/radius/session-cures`, chips `countsByOutcome` (patrón de los chips de reason de Errores de auth), badge por outcome (curada · ya curada · skip vivo · skip ambiguo · fallo), filtros outcome/trigger/username/rango. Wire contract del D8 campo por campo.
- **Botón "Curar sesión colgada"**: en las filas de "Errores de auth" con `reason='session_stuck'`. Flujo: click → confirm 1 (explica qué va a pasar: CoA + cierre contable) → POST sin `force` → si 200 `cured` → toast + refresh; si 409 `CURE_SKIPPED_ALIVE`/`CURE_SKIPPED_AMBIGUOUS` → mostrar el motivo REAL y ofrecer confirm 2 (copy explícito de riesgo: "la sesión parece viva / hay sesiones en varios NAS — forzar la cura la desconecta igual") → POST con `force: true`. El detalle visual (composición, estados, copys) se resuelve en el apply FE con **ui-ux-pro-max**.
- Estados degradados: outcomes desconocidos renderizan texto plano (lección `OutcomeBadge` de pppoe-move-nas D-W2.5.5).

## Hexagonal / DIP (ambos repos)

- **ORCH-1**: `SessionControlService` (application) depende de ports (`UnitOfWork`, `CoADispatcher`, `EventPublisher`) — cero SQL en application; el UPDATE vive en `SqlAlchemySessionRepository` (infra). El router solo traduce HTTP ↔ comando (molde `sessions.py:36-42`).
- **BE-1**: use cases dependen SOLO de ports; nada de Prisma/Express en application; tests de use case con in-memory (regla del repo), tests de ruta con supertest + repos in-memory.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **Doble-curador (cron 20 min/30 min vs watcher)** | Idempotencia por diseño: `WHERE acctstoptime IS NULL` ⇒ el segundo hace no-op limpio (`already_cured`, visible en la tabla). El cron QUEDA documentado como safety net (D4) — no compiten, se complementan |
| **Matar una sesión VIVA** | Camino stale: gates fail-closed (D6) + umbral 20 min VALIDADO (interim 600 s, 0 sesiones sanas >30 min) + piso duro en la env. Fast path: desconectar una sesión viva es DELIBERADO bajo new-wins (`Simultaneous-Use=1` = política, no hay doble-login legítimo) — el costo es un micro-corte ~30 s + redial, acotado por persistencia 5 min + recencia 2 min + los gates ambiguous/no_signal que SÍ aplican |
| **Ping-pong new-wins (credencial compartida / sesión clonada: dos dispositivos curándose mutuamente)** | Cure-throttle 30 min por username + flapping flag: ≥3 curas en 24 h ⇒ `flagged_flapping`, no se cura más ese día y queda VISIBLE en la UI (es caso de soporte, no de auto-cura) |
| **Tormenta de curas (NAS caído genera N stuck)** | Breaker (>20 candidatos ⇒ abort del tick — SE MANTIENE con la enmienda) + cap 5/tick + cure-throttle 30 min + throttle 6 h del registro (D7) |
| **HA / replicación MariaDB** | wsrep OFF ya medido; tarea EXPLÍCITA de apply ORCH-1: `SHOW SLAVE STATUS` en r1/r2 ANTES de habilitar el write en prod. Superficie acotada: mismo write-path (VIP + UoW) que los writes existentes a radcheck/radreply — lo nuevo es la tabla, no el camino |
| **Presión del pool SQL / orchestrator** | Detección sobre el mirror local (`RadiusAuthEvent`) — cero barrido nuevo; por tick a lo sumo `MAX_PER_TICK` × (`listSessions` + `cure`) por username, queries por-índice con LIMIT |
| **Deploy fuera de orden (BE antes que ORCH)** | `lastUpdate` ausente ⇒ fail-closed `skipped_no_signal` (nada se cura, queda visible); `cureSession` 404/405 ⇒ `failed` registrado. El flag nace DARK |
| **Session id raro en la URL** | `encodeURIComponent` en el gateway + test con id con caracteres no alfanuméricos |
| **Reject `session_stuck` sobre sesión que YA curó el cron entre ingest y tick** | Gate `skipped_no_session` (listSessions fresco) — no-op sin fila duplicada gracias al throttle |

## Enmienda fast-path 5 min (2026-07-16, decisión del usuario)

El usuario pidió reaccionar en **~5 minutos**, no 20. La versión original de este design solo curaba con staleness ≥20 min (D6 v1) → latencia real ~20-22 min. La enmienda lo resuelve SIN bajar el umbral de staleness (restricción DURA: con interim 600 s, <20 min = falsos positivos masivos — queda documentado en D6) agregando el **fast path por persistencia de rejects** como camino PRINCIPAL:

1. **Fast path (D6 fila 4)**: rejects `session_stuck` sostenidos ≥5 min (primer y último reject separados ≥ `PERSISTENCE_MS`) con el último reciente (≤ `RECENCY_MS`) ⇒ curar YA, sin exigir staleness. Fundamento new-wins: `Simultaneous-Use=1` en los 81 grupos = política de red, el que marca gana; falso positivo = micro-corte ~30 s.
2. **Slow path**: el camino `stale_interim` (≥20 min) queda para clientes que dejaron de redialear dentro del lookback, y el **cron versionado** (D4) sigue siendo la red de seguridad para fantasmas sin redial — sin cambios.
3. **Anti-flapping (D7)**: cure-throttle 30 min por username (antes cooldown 10 min) + `flagged_flapping` con ≥3 curas/24 h (no curar más ese día, visible en UI — delata credencial compartida/clon).
4. **El breaker de tormenta SE MANTIENE** (>20 candidatos/tick ⇒ abort): incidente de NAS ≠ curas masivas.
5. `skipped_no_session` / `skipped_no_signal` / `skipped_ambiguous` aplican a ambos caminos; `skipped_alive` solo bloquea el camino stale. La columna `signalUsed` (`persistent_rejects` | `stale_interim`) distingue en la tabla/UI qué evidencia justificó cada cura.

**ORCH-1 NO cambia**: el endpoint cure es agnóstico de la política — la decisión de CUÁNDO curar vive entera en BE-1.
