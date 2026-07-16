# Proposal: Auto-curación de sesiones RADIUS colgadas + log auditable

## Intent

Que una sesión PPPoE colgada (fila de `radacct` con `acctstoptime IS NULL` cuyo NAS ya no la sostiene) deje de bloquear al cliente durante ~50 minutos y deje de curarse en forma INVISIBLE. Tres piezas coordinadas:

1. **ORCH-1 (repo `freeradius-orchestrator`)** — endpoint de curación (`POST /users/{username}/sessions/{session_id}/cure` = CoA Disconnect best-effort + cierre contable idempotente en `radacct`) + exponer `last_update` en `SessionResponse` + versionar el cron de limpieza que hoy vive suelto en la VM r1.
2. **BE-1 (este repo)** — watcher `AutoCureStuckSessions` que detecta los rechazos `session_stuck` YA ingeridos, verifica FAIL-CLOSED contra las sesiones vivas del orchestrator y cura vía el endpoint nuevo, registrando TODO en una tabla de auditoría (`RadiusSessionCureEvent`) + `GET /api/radius/session-cures` + endpoint manual de curación.
3. **FE-1** — tab "Sesiones curadas" en la page de auditoría RADIUS + botón manual "Curar sesión colgada" (escape hatch con doble confirmación).

## Problema

- **Ventana de lockout worst-case ~50 min.** Con `Simultaneous-Use := 1` (81 grupos en `radgroupcheck`, TODOS = 1), una sesión colgada hace que CADA re-intento PPPoE del cliente reciba Access-Reject (medidos 179 rejects en 5 min de un solo cliente). La única cura hoy es un cron en r1 que corre cada 30 min y exige 20 min de staleness → 20 + 30 = ~50 min de cliente sin servicio en el peor caso.
- **Curación INVISIBLE.** El cron cierra las sesiones directamente en MariaDB: ni Prominense ni el orchestrator se enteran. Soporte ve "Sesión colgada" en Errores de auth y no tiene forma de saber si ya se curó, cuándo, ni cuántas veces le pasa al mismo cliente.
- **Cron NO versionado.** `/etc/cron.d/radius-cleanup` es un archivo suelto root en la VM r1: no está en ningún repo, no tiene doc, y un rebuild de la VM lo pierde en silencio.
- **Los mecanismos nativos de FreeRADIUS están muertos**: `checkrad` inoperante (sin soporte huawei, `nas.community` NULL, `naspasswd` inexistente → `delete_stale_sessions = yes` es letra muerta) y la tabla `nasreload` está VACÍA. No hay curación nativa posible sin obra mayor.

## Contexto verificado (dos análisis en vivo, 2026-07-16)

- **"Sesión colgada" es una inferencia post-hoc del orchestrator** (`postauth_repository.py:68-77`): Access-Reject + username existe en `radcheck` + `EXISTS radacct con acctstoptime NULL`. El BE la ingesta CONGELADA (`IngestRadiusAuth.ts:152-161` — el update no pisa el reason) vía `RadiusAuthIngestScheduler` (tick 60 s).
- **El cron de r1 funciona**: candidatas colgadas al momento del análisis: 0; cura 0-6/día (hoy 26, de las cuales 23 del NAS vialidad `10.60.0.10`). Reglas: cada 30 min cierra `acctstoptime IS NULL AND acctupdatetime < NOW()-20min` como `Lost-Carrier`; cada hora cierra `acctupdatetime IS NULL AND acctstarttime < NOW()-2h` como `Session-Timeout`.
- **Datos duros del umbral**: `Acct-Interim-Interval := 600` (post-auth en `sites-enabled/default:750`, medido 600 s clavados); 5166 sesiones abiertas: 84 % con frescura <10 min, 16 % entre 10-30 min, **0 >30 min** → **staleThreshold seguro = 20 min** (validado; <20 min produce falsos positivos).
- **El orchestrator hoy NO escribe radacct**: `session_repository.py` es read-only (NO existe UPDATE de `acctstoptime` en ningún lado del repo). El CoA Disconnect FUNCIONA (`pyrad_coa_dispatcher.py`, source = VIP 10.75.0.20, fix `cf82c1b`). `Session.last_update` (= `acctupdatetime`) existe en dominio (`mapping.py:70`, `session.py:16`) pero NO se expone en `SessionResponse` (`schemas/session.py:12-20`) — exponerla es 1 línea + serializer.
- **MariaDB accounting**: wsrep dio OFF en el chequeo. Queda VERIFICAR en el apply si hay replicación master-master clásica (`SHOW SLAVE STATUS`) antes de asumir topología. Nota que baja el riesgo: el orchestrator YA escribe en la misma DB (radcheck/radreply/radusergroup vía UoW) — lo nuevo es escribir *radacct*, no escribir.
- **Moldes BE listos para clonar**: watcher `PppoeAutoMoveScheduler` + `bootstrapPppoeAutoMove` (setInterval + unref + inFlight + PgAdvisoryLock + flag por tick + log estructurado); tabla append-only `PppoeNasMoveEvent` (`schema.prisma:1902-1925`: soft refs sin FK, outcome String libre); throttle 6 h (`isDuplicateAutoEvent`); gateway `RadiusOrchestratorGateway.listSessions/disconnectSessions` ya existen; UI gemela: `radius.routes.ts:247-291` (`GET /auth-failures`, gate `network.read`) + page "Errores de auth" del FE.

## Dirección decidida por el usuario (2026-07-16)

**"Cura rápida + log auditable + versionar el cron como red de seguridad."** El watcher del BE cura en **~5-7 min desde la muerte de la sesión** (enmienda fast-path del mismo día: persistencia de rejects ≥5 min bajo política new-wins — ver design "Enmienda fast-path 5 min") lo que el cron cura en hasta 50; el cron QUEDA como safety net (cubre lo que el watcher no ve: sesiones colgadas sin rechazos, BE caído); todo intento de cura —del watcher o manual— queda registrado y visible en Prominense, con anti-flapping (cure-throttle 30 min + `flagged_flapping` ≥3 curas/24 h) para que new-wins no degenere en ping-pong con credenciales compartidas.

## Scope

- **ORCH-1** (`freeradius-orchestrator`): `last_update` en `SessionResponse` + `POST /users/{username}/sessions/{session_id}/cure` (CoA best-effort + `UPDATE radacct SET acctstoptime=... WHERE ... AND acctstoptime IS NULL`, idempotente) + domain event `SessionCured` + versionar el cron actual en `deploy/` con doc del porqué.
- **BE-1** (este repo): use case `CureStuckSession` (core) + watcher `AutoCureStuckSessions` (flag `radius-auto-cure` DARK, lock propio, tick ~60 s, detección desde `RadiusAuthEvent` reason `session_stuck` — cero barrido nuevo) + gates fail-closed (alive/ambiguous/no-signal) + tabla `RadiusSessionCureEvent` (migración ADITIVA) + `GET /api/radius/session-cures` (gate `network.read`) + `POST /api/radius/session-cures` manual (gate `network.manage`, `force` con doble confirm) + método `cureSession` y campo `lastUpdate` ADITIVOS en el gateway port.
- **FE-1**: tab/sección "Sesiones curadas" en la page de auditoría RADIUS (tabla paginada, chips por outcome, filtros) + botón "Curar sesión colgada" en las filas `session_stuck` de "Errores de auth" (doble confirmación; el detalle visual va al apply FE con ui-ux-pro-max).
- **Fuera de scope**: arreglar `checkrad`/`nasreload` (mecanismos nativos — obra mayor sin retorno claro teniendo cura activa + cron); tocar las reglas del cron (solo se VERSIONA tal cual); alertas Telegram (el log estructurado deja el hook); curación masiva por NAS caído (el breaker la ABORTA a propósito — eso es un incidente, no una sesión colgada).

## Orden de ejecución

**ORCH-1 → BE-1 → FE-1.** BE-1 es tolerante al orden real de deploy: si el orchestrator viejo no manda `last_update`, el gate fail-closed skipea todo (`skipped_no_signal`) sin daño; si el endpoint cure no existe, el intento registra `failed`. El flag nace DARK: se prende con OK del usuario tras validar en prod.

## Proceso

SDD completo + worktrees dedicados + TDD estricto + review adversarial + verify antes de push + push con OK del usuario, change por change.
