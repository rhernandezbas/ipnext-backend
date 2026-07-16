# Spec: ORCH-1 — Curación de sesiones en el radius-orchestrator

> Repo: `freeradius-orchestrator` (Python/FastAPI, hexagonal). Delta spec del change `radius-session-autocure`.

## REQ-ORCH-1 — `last_update` expuesto en `SessionResponse`

`SessionResponse` DEBE exponer `last_update` (el `acctupdatetime` de radacct, ya presente en `Session.last_update` del dominio), serializado a UTC con sufijo Z con el MISMO serializer que `started_at` (`db_naive_to_utc_z`). El cambio DEBE ser backward-compatible (campo agregado, ninguno removido).

- **S1.1** dada una sesión activa con `acctupdatetime` poblado, cuando se consulta `GET /users/{u}/sessions`, entonces cada item incluye `last_update` en formato ISO 8601 UTC (`...Z`).
- **S1.2** dada una sesión activa SIN interim aún (`acctupdatetime` NULL), cuando se consulta, entonces `last_update` es `null` (no se inventa señal).
- **S1.3** el resto de los campos (`session_id`, `username`, `nas_ip`, `framed_ip`, `started_at`, `bytes_in`, `bytes_out`, `caller_id`) quedan EXACTAMENTE como estaban (contract test del shape).

## REQ-ORCH-2 — `POST /users/{username}/sessions/{session_id}/cure` — CoA best-effort + cierre contable idempotente

El orchestrator DEBE exponer un endpoint de curación que: (1) intente CoA Disconnect contra el NAS de la sesión (best-effort — su fallo NO aborta ni se vuelve 5xx), y (2) cierre la fila en radacct de forma IDEMPOTENTE: `UPDATE radacct SET acctstoptime = COALESCE(acctupdatetime, NOW()), acctsessiontime = <stoptime - acctstarttime en segundos>, acctterminatecause = 'Admin-Reset' WHERE acctsessionid = :sid AND username = :user AND acctstoptime IS NULL`. El write DEBE ir por el UoW (mismo patrón transaccional que los writes a radcheck/radreply); el CoA DEBE ejecutarse FUERA de la transacción.

- **S2.1** dada una sesión colgada (fila abierta), cuando se llama al cure, entonces la fila queda con `acctstoptime = acctupdatetime` (el fin estimado honesto), `acctsessiontime` recalculado coherente y `acctterminatecause = 'Admin-Reset'`, y responde 200 `{cured: true, ...}` incluyendo el resultado del CoA.
- **S2.2** dada una sesión abierta con `acctupdatetime` NULL, cuando se llama al cure, entonces `acctstoptime = NOW()` (fallback documentado) y `cured: true`.
- **S2.3** dada una sesión que YA está cerrada (el cron ganó la carrera), cuando se llama al cure, entonces NO se modifica NADA en radacct y responde 200 `{cured: false, alreadyClosed: true}` — no-op limpio, sin error.
- **S2.4** dado un `session_id`+`username` que no existe en radacct (ni abierto ni cerrado), cuando se llama al cure, entonces responde 404.
- **S2.5** dado que el CoA Disconnect falla (NAS no responde / timeout), cuando se llama al cure, entonces el cierre contable procede IGUAL y responde 200 `{cured: true}` con el resultado CoA de fallo informativo — un CoA fallido JAMÁS se vuelve 500 (molde `disconnect_all`).
- **S2.6** el endpoint exige el token (`require_token`) como todo el router de sesiones.
- **S2.7** dos llamadas concurrentes/sucesivas al cure de la misma sesión → exactamente UNA reporta `cured: true`; la otra `alreadyClosed: true` (la idempotencia es el `WHERE acctstoptime IS NULL`, no un check-then-act).

## REQ-ORCH-3 — Domain event `SessionCured`

Toda curación efectiva DEBE publicar un domain event `SessionCured` (`{username, session_id, nas_ip, stop_time_source: 'acctupdatetime'|'now', coa_ok}`) vía el `EventPublisher` (log estructurado). Un cure que resulta `alreadyClosed` NO publica el evento (no curó nada).

- **S3.1** cure efectivo → `SessionCured` publicado con el source real del stoptime.
- **S3.2** cure `alreadyClosed` → cero eventos publicados.

## REQ-ORCH-4 — Cron de limpieza VERSIONADO como red de seguridad

El repo DEBE versionar en `deploy/cron.d/radius-cleanup` una copia fiel del cron vivo en r1 (regla 30 min / `Lost-Carrier` sobre `acctupdatetime < NOW()-20min`; regla horaria / `Session-Timeout` sobre `acctupdatetime IS NULL AND acctstarttime < NOW()-2h`), con header que documente: por qué existe, la evidencia del umbral de 20 min (interim 600 s; 0 sesiones sanas >30 min sin interim), y su rol de safety net frente al watcher de Prominense (cubre: sesiones colgadas sin rechazos, BE caído, sesiones sin interim). Las REGLAS no se modifican en este change.

- **S4.1** el archivo existe en `deploy/cron.d/` y su SQL coincide con el cron desplegado en r1 (verificación manual en el apply, diff contra la VM).
- **S4.2** el header documenta umbral + rol de safety net + instrucción de instalación.
