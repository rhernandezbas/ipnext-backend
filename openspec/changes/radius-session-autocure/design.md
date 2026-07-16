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
- **Idempotencia = el `WHERE acctstoptime IS NULL`**: si el cron (o un doble-click, u otro tick) ya la cerró, el UPDATE afecta 0 filas → respuesta `{cured: false, alreadyClosed: true}` con 200. **Ese es el contrato anti doble-curador**: watcher y cron pueden correr a la vez sin pisarse — el segundo en llegar hace un no-op limpio.
- **Orden CoA→UPDATE**: el CoA va primero y FUERA de la transacción (molde exacto de `SessionControlService.disconnect_all`, `session_control_service.py:40-73`: resolver targets dentro de `begin()`, red fuera, excepción de CoA jamás se vuelve 500). Si el CoA falla o el NAS no responde (esperable: la sesión está colgada justamente porque el NAS la perdió), el cierre contable procede IGUAL — cerrar radacct es lo que destraba el `Simultaneous-Use=1`.

## D2 — Endpoint `POST /users/{username}/sessions/{session_id}/cure` (ORCH-1)

- **Router**: `sessions.py` (prefix ya existente `/users/{username}/sessions`, `sessions.py:20-24`, auth `require_token`). Ruta nueva: `POST /{session_id}/cure`.
- **Use case**: `SessionControlService.cure_session(cmd)` — nuevo método junto a `disconnect_all` (`session_control_service.py:40`). Comando inbound `CureSessionCommand {username, session_id}` en `ports/inbound/session_control.py` (molde `DisconnectSessionsCommand`, línea 10-12).
- **Primer write a radacct**: método nuevo en el port outbound `SessionRepository` (p. ej. `close_stale(username, session_id) -> Session | None` que hace SELECT de la fila abierta + UPDATE). La implementación va en `SqlAlchemySessionRepository` (`session_repository.py:15`), que YA es miembro del UoW (`unit_of_work.py:17`, `uow.sessions`) → el write entra en la MISMA transacción/patrón que los writes existentes de `user_repository.py` (radcheck/radreply). **No es el primer write del orchestrator a MariaDB — es el primer write a radacct**; el write-path (VIP, UoW, commit/rollback) está probado en prod.
- **Respuestas**: 200 `{cured: true, stopTime, coa: [CoAResultResponse...]}` | 200 `{cured: false, alreadyClosed: true, coa: [...]}` (fila existía pero ya cerrada) | 404 si NO existe fila con ese `acctsessionid`+`username` (ni abierta ni cerrada). El resultado CoA se reporta SIEMPRE (puede ser `failed`/`timeout` — informativo, no bloquea).
- **Domain event `SessionCured`** en `domain/events/events.py` (molde `SessionDisconnected`, `events.py:38-42`): `{username, session_id, nas_ip, stop_time_source: 'acctupdatetime'|'now', coa_ok: bool}` → publicado al `LogEventPublisher` (log estructurado = rastro en el orchestrator).

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
2. candidatos = usernames únicos de esos eventos               ← dedupe intra-tick
3. breaker: |candidatos| > ABORT_THRESHOLD → ABORT del tick    ← incidente masivo (NAS caído) ≠ sesión colgada
4. cap: procesar a lo sumo MAX_PER_TICK (resto → deferred)
5. por username (aislamiento de fallos por ítem):
   a. cooldown: último evento 'cured' del username < COOLDOWN_MS → skip (counter, sin fila)
   b. sessions = gateway.listSessions(username)                 ← fresco, del orchestrator
   c. gates FAIL-CLOSED (D6)
   d. cura: gateway.cureSession(username, sessionId)  →  fila RadiusSessionCureEvent
```

- **Detección = `RadiusAuthEvent` con `reason='session_stuck'`** ya ingeridos por `RadiusAuthIngestScheduler` (tick 60 s): cero queries nuevas contra el orchestrator/MariaDB para detectar. El filtro `reason` + `from` ya existe en el port (`RadiusAuthEventFilters`, `RadiusAuthEventRepository.ts:15-20`).
- **LOOKBACK default 15 min** (`RADIUS_AUTO_CURE_LOOKBACK_MS`): cubre el atraso del ingest + ticks perdidos sin re-barrer histórico. Un evento stuck más viejo que el lookback ya lo curó el cron (ventana 50 min > lookback + threshold).
- **Latencia esperada de cura**: reject → ingest (≤60 s) → tick watcher (≤60 s) + threshold 20 min de staleness ya cumplido al momento del reject en el caso típico → **~1-2 min** desde que el rechazo es visible, vs ~50 min worst-case del cron.

## D6 — Gates FAIL-CLOSED de verificación (BE-1) — la regla de oro: ante la duda, NO curar

Por username, sobre `sessions = gateway.listSessions(username)` frescas:

| Condición | Acción | Outcome |
|---|---|---|
| 0 sesiones abiertas | el cron/otro ya curó, o cerró sola | skip `skipped_no_session` |
| ALGUNA sesión con `lastUpdate` fresco (`now - lastUpdate < STALE_MS`) | usuario VIVO — el reject era doble login legítimo | skip `skipped_alive` |
| sesiones abiertas en NAS DISTINTOS entre sí | posible doble login real / transitorio | skip `skipped_ambiguous` |
| alguna sesión SIN `lastUpdate` en el wire (orchestrator viejo o sesión sin interim aún) | sin señal ⇒ sin cura | skip `skipped_no_signal` |
| TODAS stale (`now - lastUpdate > STALE_MS`) y mismo NAS | curable → cure de cada sesión stale | `cured` / `already_cured` / `failed` |

- **`STALE_MS` default 1 200 000 (20 min), PISO DURO 20 min** (`RADIUS_AUTO_CURE_STALE_MS`): el umbral está VALIDADO con datos (interim 600 s; 0 sesiones sanas >30 min sin interim; <20 min = falsos positivos medidos). El piso impide que un fat-finger baje el gate a territorio de matar sesiones vivas. Techo 24 h. Parse patrón `parseIntervalMs` (config.ts:201-206).
- **`skipped_no_signal` es la propiedad de orden de deploy**: BE-1 puede ir a prod ANTES que ORCH-1 sin daño — sin `lastUpdate` en el wire el watcher no cura nada y lo dice en la tabla.
- **El gate NO usa `startedAt` como fallback de señal**: una sesión sin interim no es diagnosticable desde acá — la cubre la regla horaria del cron (2 h). Fail-closed estricto.

## D7 — Anti-tormenta: breaker + cap + cooldown + throttle (BE-1, molde AutoMovePppoe D-W2.5)

- **Circuit breaker** `RADIUS_AUTO_CURE_ABORT_THRESHOLD` (default 20): más de N candidatos únicos en un tick ⇒ ABORT sin curar nada + WARN + `aborted: true` en el summary. Racional: hoy se curan 0-6/día; decenas de stuck simultáneos = NAS caído u outage (26 hoy, 23 del mismo NAS vialidad `10.60.0.10`) — eso NO se cura de a uno, se escala. Parse `parsePositiveInt` (molde config.ts:244-247).
- **Cap por tick** `RADIUS_AUTO_CURE_MAX_PER_TICK` (default 5): resto queda `deferred` para el próximo tick (el evento sigue en el lookback).
- **Cooldown post-cura** `RADIUS_AUTO_CURE_COOLDOWN_MS` (default 600 000 = 10 min): si el último evento `cured` del username es más nuevo, skip sin fila — evita re-procesar al mismo username mientras su evento stuck viejo sigue dentro del lookback (cinturón; el gate `no_session` ya lo cortaría).
- **Throttle 6 h del REGISTRO** (molde exacto D-W2.2 / `pppoeNasMoveThrottle.ts` referenciado en `AutoMovePppoe.ts:17,588`): un `skipped_*`/`failed` IDÉNTICO (mismo outcome + mismo reason) al último evento del username con <6 h NO genera fila nueva (el chequeo igual ocurre; solo se throttlea el spam de la tabla). Los `cured` SIEMPRE registran. Check fail-open ante hiccup de DB (se registra igual).
- **Tick** `RADIUS_AUTO_CURE_INTERVAL_MS` default 60 000 (molde `radiusAuthIngest`, config.ts:201-206: piso 15 s, techo 24 h, inválido→default, JAMÁS tumba el boot). **Flag** `radius-auto-cure` (FeatureFlag DB, seed OFF, chequeado EN CADA tick — prender/apagar sin deploy). **Lock** `radius-auto-cure` (PgAdvisoryLock). **Log estructurado por tick**: `{events, candidates, cured, alreadyCured, failed, skippedAlive, skippedAmbiguous, skippedNoSession, skippedNoSignal, skippedCooldown, deferred, throttled, aborted}`.

## D8 — Registro: tabla `RadiusSessionCureEvent` + endpoints (BE-1)

Molde 1:1 de `PppoeNasMoveEvent` (`schema.prisma:1902-1925`): append-only, **soft refs sin FK** (el log sobrevive al borrado de NAS/servicio), **outcome String libre** (outcomes nuevos sin migración), mismos 4 índices.

```prisma
model RadiusSessionCureEvent {
  id                String   @id @default(uuid())
  username          String
  nasIp             String?
  sessionId         String?   // acctsessionid de la sesión curada/evaluada
  sessionStartedAt  DateTime?
  sessionLastUpdate DateTime? // la señal usada por el gate (null si no había)
  trigger           String    // 'auto' | 'manual'
  action            String?   // 'both' | 'acct_close' | 'coa' | null — qué se ejecutó efectivamente
  outcome           String    // 'cured' | 'already_cured' | 'skipped_alive' | 'skipped_ambiguous' | 'skipped_no_session' | 'skipped_no_signal' | 'failed'
  reason            String?
  actorName         String?   // 'sistema' (auto) | nombre del operador (manual)
  createdAt         DateTime @default(now())

  @@index([createdAt])
  @@index([username])
  @@index([outcome, createdAt])
  @@index([trigger, createdAt])
}
```

- **`GET /api/radius/session-cures`** — GEMELO de `GET /auth-failures` (`radius.routes.ts:247-291`): mismo router (`/api/radius`, app.ts:1911), mismo guard `network.read` (`radius.routes.ts:72`), misma validación defensiva de query params (enums de outcome/trigger, `parseIntPositive`, `parseDate`). Filtros: `username?`, `outcome?`, `trigger?`, `from?`, `to?`, `page`, `limit` (default 50, cap 200 — molde `ListRadiusAuthFailures.ts:31-33`). **Wire contract campo por campo**: `{ data: [{ id, username, nasIp, sessionId, sessionStartedAt, sessionLastUpdate, trigger, action, outcome, reason, actorName, createdAt }], total, page, limit, hasNext, countsByOutcome }` — `countsByOutcome` espejo de `countsByReason` (`ListRadiusAuthFailures.ts:60-69`): ignora el filtro `outcome`, alimenta los chips del FE.
- **`POST /api/radius/session-cures`** — cura MANUAL (escape hatch). Guard **`network.manage`** (espejo de `DELETE /sessions/:id`, `radius.routes.ts:73`). Body `{ username, sessionId, force? }`. Sin `force`: respeta los gates D6 — si da alive/ambiguous responde 409 tipado (`CURE_SKIPPED_ALIVE` / `CURE_SKIPPED_AMBIGUOUS`) SIN curar. Con `force: true` (el FE lo manda tras la SEGUNDA confirmación explícita): saltea los gates alive/ambiguous y cura igual — es la misma potestad que ya tiene el operador con el disconnect manual, más el cierre contable. SIEMPRE registra fila `trigger='manual'` + `actorName` del operador (incl. los 409: outcome `skipped_*`). El manual NO pasa por throttle (una acción deliberada siempre deja rastro).
- **Use cases**: `CureStuckSession` (core: gates + cura + registro — lo comparten watcher y ruta manual) + `AutoCureStuckSessions` (orquesta el tick: lookback, breaker, cap, cooldown) + `ListRadiusSessionCures` (lectura). DIP estricta: dependen SOLO de ports (`RadiusAuthEventRepository`, `RadiusOrchestratorGateway`, `RadiusSessionCureEventRepository` nuevo, `FeatureFlagRepository`, `DistributedLock` en el scheduler). Tests con in-memory + fake del gateway.

## D9 — Extensión ADITIVA del gateway port (BE-1)

`RadiusOrchestratorGateway.ts` (port, líneas 186-268) y `HttpRadiusOrchestratorGateway` + fakes:

- **`OrchestratorSession.lastUpdate: string | null`** — campo nuevo opcional-null en el DTO (`RadiusOrchestratorGateway.ts:18-28` hoy NO lo tiene); parseado del `last_update` del wire (D3); `null` si el orchestrator no lo manda (⇒ gate `skipped_no_signal`). Precedente exacto: `AccountingEventRow.lastUpdate` (`RadiusOrchestratorGateway.ts:118`).
- **`cureSession(username: string, sessionId: string): Promise<CureSessionResult>`** — método nuevo → `POST /users/{username}/sessions/{sessionId}/cure` (sessionId con `encodeURIComponent`). `CureSessionResult = { cured: boolean, alreadyClosed?: boolean }`. Errores: 404 upstream → error tipado (fila desapareció entre list y cure — outcome `failed`, reason `session_not_found`); red/5xx → `OrchestratorUnreachableError` (patrón existente, `RadiusOrchestratorGateway.ts:15`).
- Los fakes in-memory modelan la semántica REAL: `cureSession` sobre sesión ya cerrada devuelve `alreadyClosed` (lección del fake de `changeFramedIp`, design pppoe-move-nas ajuste 2).

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
| **Matar una sesión VIVA** | Gates fail-closed (D6) + umbral 20 min VALIDADO con datos (interim 600 s, 0 sesiones sanas >30 min) + piso duro de 20 min en la env + `skipped_alive`/`skipped_ambiguous` ante cualquier señal de vida o ambigüedad |
| **Tormenta de curas (NAS caído genera N stuck)** | Breaker (>20 candidatos ⇒ abort del tick) + cap 5/tick + cooldown 10 min + throttle 6 h del registro (D7) |
| **HA / replicación MariaDB** | wsrep OFF ya medido; tarea EXPLÍCITA de apply ORCH-1: `SHOW SLAVE STATUS` en r1/r2 ANTES de habilitar el write en prod. Superficie acotada: mismo write-path (VIP + UoW) que los writes existentes a radcheck/radreply — lo nuevo es la tabla, no el camino |
| **Presión del pool SQL / orchestrator** | Detección sobre el mirror local (`RadiusAuthEvent`) — cero barrido nuevo; por tick a lo sumo `MAX_PER_TICK` × (`listSessions` + `cure`) por username, queries por-índice con LIMIT |
| **Deploy fuera de orden (BE antes que ORCH)** | `lastUpdate` ausente ⇒ fail-closed `skipped_no_signal` (nada se cura, queda visible); `cureSession` 404/405 ⇒ `failed` registrado. El flag nace DARK |
| **Session id raro en la URL** | `encodeURIComponent` en el gateway + test con id con caracteres no alfanuméricos |
| **Reject `session_stuck` sobre sesión que YA curó el cron entre ingest y tick** | Gate `skipped_no_session` (listSessions fresco) — no-op sin fila duplicada gracias al throttle |
