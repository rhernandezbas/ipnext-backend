# Spec: ORCH-1 — Curación de sesiones en el radius-orchestrator

> Repo: `freeradius-orchestrator` (Python/FastAPI, hexagonal). Delta spec del change `radius-session-autocure`.

## REQ-ORCH-1 — `last_update` expuesto en `SessionResponse`

`SessionResponse` DEBE exponer `last_update` (el `acctupdatetime` de radacct, ya presente en `Session.last_update` del dominio), serializado a UTC con sufijo Z con el MISMO serializer que `started_at` (`db_naive_to_utc_z`). El cambio DEBE ser backward-compatible (campo agregado, ninguno removido).

- **S1.1** dada una sesión activa con `acctupdatetime` poblado, cuando se consulta `GET /users/{u}/sessions`, entonces cada item incluye `last_update` en formato ISO 8601 UTC (`...Z`).
- **S1.2** dada una sesión activa SIN interim aún (`acctupdatetime` NULL), cuando se consulta, entonces `last_update` es `null` (no se inventa señal).
- **S1.3** el resto de los campos (`session_id`, `username`, `nas_ip`, `framed_ip`, `started_at`, `bytes_in`, `bytes_out`, `caller_id`) quedan EXACTAMENTE como estaban (contract test del shape).

## REQ-ORCH-2 — `POST /users/{username}/sessions/{session_id}/cure` — CoA best-effort + cierre contable idempotente

> **[ENMIENDA fix wave 2026-07-16 — review adversarial con pruebas ejecutadas]**: dos correcciones sobre el REQ original. **HIGH-3** (decisión del orquestador): el wire de respuesta es snake_case con el detalle CoA completo — `coa_sent` (bool) queda ELIMINADO, reemplazado por `coa: [CoAResultResponse, ...]`. **CRITICAL-2**: el UPDATE ya NO se filtra por `(acctsessionid, username)` — con el sid REUSADO por el NAS (MikroTik reasigna el mismo `acctsessionid` en cada reboot, `mapping.py:80-84`) ese filtro podía matchear DOS filas abiertas (la colgada Y la sesión viva reconectada) y cerrar ambas. Ver S2.3/S2.7 más abajo para el detalle actualizado.

El orchestrator DEBE exponer un endpoint de curación que: (1) resuelva DETERMINÍSTICAMENTE la fila colgada — `find_by_id` filtra `acctstoptime IS NULL` y ordena por `acctstarttime ASC` (la más VIEJA primero), exponiendo el `radacctid` (PK real de radacct) de esa fila; si no hay ninguna fila abierta, `find_any_by_id` (sin filtrar por `acctstoptime`) resuelve 404 (no existe en absoluto) vs `already_closed` (existe pero ya cerrada); (2) intente CoA Disconnect contra el NAS de la sesión resuelta (best-effort — su fallo NO aborta ni se vuelve 5xx); y (3) cierre la fila en radacct de forma IDEMPOTENTE y ATÓMICA por PK: `UPDATE radacct SET acctstoptime = COALESCE(acctupdatetime, NOW()), acctsessiontime = <stoptime - acctstarttime en segundos>, acctterminatecause = 'Admin-Reset' WHERE radacctid = :id AND acctstoptime IS NULL`. El write DEBE ir por el UoW (mismo patrón transaccional que los writes a radcheck/radreply) y DEBE comitear explícitamente dentro de ese `begin()`; el CoA DEBE ejecutarse FUERA de la transacción.

- **S2.1** dada una sesión colgada (fila abierta), cuando se llama al cure, entonces la fila queda con `acctstoptime = acctupdatetime` (el fin estimado honesto), `acctsessiontime` recalculado coherente y `acctterminatecause = 'Admin-Reset'`, y responde 200 `{cured: true, already_closed: false, closed_at, coa: [...]}` incluyendo el detalle completo del CoA.
- **S2.2** dada una sesión abierta con `acctupdatetime` NULL, cuando se llama al cure, entonces `acctstoptime = NOW()` (fallback documentado) y `cured: true`.
- **S2.3** dada una sesión que YA está cerrada (el cron ganó la carrera), cuando se llama al cure, entonces NO se modifica NADA en radacct y responde 200 `{cured: false, already_closed: true, closed_at: null, coa: [...]}` — no-op limpio, sin error. **[ENMIENDA]** snake_case (`already_closed`, no `alreadyClosed`) y `coa` SIEMPRE presente como array (puede tener 0 o 1 elementos: el CoA best-effort igual se intenta contra el NAS de la fila ya-cerrada resuelta por `find_any_by_id`, porque la sesión puede seguir viva en el NAS aunque radacct ya esté cerrada por el cron).
- **S2.4** dado un `session_id`+`username` que no existe en radacct (ni abierto ni cerrado — `find_any_by_id` también devuelve nada), cuando se llama al cure, entonces responde 404.
- **S2.5** dado que el CoA Disconnect falla (NAS no responde / timeout), cuando se llama al cure, entonces el cierre contable procede IGUAL y responde 200 `{cured: true}` con `coa: [{status: 'timeout'|'nak', ...}]` (o `coa: []` si el dispatcher lanzó excepción antes de producir un resultado) — informativo, un CoA fallido/ausente JAMÁS se vuelve 500 (molde `disconnect_all`).
- **S2.6** el endpoint exige el token (`require_token`) como todo el router de sesiones.
- **S2.7** dos llamadas concurrentes/sucesivas al cure de la misma sesión → exactamente UNA reporta `cured: true`; la otra `already_closed: true` (la idempotencia es el `WHERE acctstoptime IS NULL` sobre el `radacctid` ya resuelto, no un check-then-act). **[ENMIENDA CRITICAL-2]** extiende a sid reusado: dadas DOS filas ABIERTAS con el mismo `(username, acctsessionid)` (la colgada vieja y una sesión viva reconectada tras un reboot del NAS con `acctsessionid` reasignado), el cure DEBE cerrar EXACTAMENTE la más vieja (`radacctid` resuelto por `find_by_id`, `acctstarttime ASC`) — la sesión viva (otro `radacctid`, mismo sid) queda intacta. Cerrar por `(username, acctsessionid)` sin el PK es un bug: puede matchear y cerrar ambas filas.

## REQ-ORCH-3 — Domain event `SessionCured`

Toda curación efectiva DEBE publicar un domain event `SessionCured` (`{username, session_id, nas_ip, stop_time_source: 'acctupdatetime'|'now', coa_ok}`) vía el `EventPublisher` (log estructurado). Un cure que resulta `already_closed: true` NO publica el evento (no curó nada).

- **S3.1** cure efectivo → `SessionCured` publicado con el source real del stoptime.
- **S3.2** cure con `already_closed: true` → cero eventos publicados.

## REQ-ORCH-4 — Cron de limpieza VERSIONADO como red de seguridad

El repo DEBE versionar en `deploy/cron.d/radius-cleanup` una copia fiel del cron vivo en r1 (regla 30 min / `Lost-Carrier` sobre `acctupdatetime < NOW()-20min`; regla horaria / `Session-Timeout` sobre `acctupdatetime IS NULL AND acctstarttime < NOW()-2h`), con header que documente: por qué existe, la evidencia del umbral de 20 min (interim 600 s; 0 sesiones sanas >30 min sin interim), y su rol de safety net frente al watcher de Prominense (cubre: sesiones colgadas sin rechazos, BE caído, sesiones sin interim). Las REGLAS no se modifican en este change.

- **S4.1** el archivo existe en `deploy/cron.d/` y su SQL coincide con el cron desplegado en r1 (verificación manual en el apply, diff contra la VM).
- **S4.2** el header documenta umbral + rol de safety net + instrucción de instalación.
