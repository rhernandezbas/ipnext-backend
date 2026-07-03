# Spec: Mover PPPoE de NAS (radius-aware) — manual + automático

## REQ-MOVE-1 — Move radius reasigna IP del pool CGNAT del destino

Al mover un PPPoE de un NAS radius a otro NAS radius, el sistema DEBE asignarle la primera IP libre de los pools `cgnat` del NAS **destino** (vía `FindFreeIp`), escribirla como Framed-IP en el RADIUS (`changeFramedIp`) y persistir `nasId` destino + `remoteAddress` nueva + `ipMode='fixed'`.

- **S1.1** dado un servicio en NAS A (IP `100.64.60.25`) movido a NAS B (pool `100.64.43.0/24`), cuando ejecuta el move, entonces el RADIUS recibe `changeFramedIp(username, 100.64.43.X)` con X libre, y el servicio queda `nasId=B`, `remoteAddress=100.64.43.X`, `ipMode='fixed'`.
- **S1.2** dado el mismo NAS destino que el actual, cuando ejecuta el move, entonces es no-op (no toca RADIUS ni DB).
- **S1.3** dado un destino cuyos pools cgnat están LLENOS, cuando ejecuta el move, entonces lanza `NoFreeIpError` y NADA cambió (ni RADIUS ni DB — el cliente conserva NAS e IP originales).
- **S1.4** dado que `changeFramedIp` falla (orchestrator caído), cuando ejecuta el move, entonces propaga el error y la DB no cambió.
- **S1.5** dado un servicio cuya IP actual NO es clasificable como CGNAT (cae en un pool `public` O no cae en NINGÚN pool conocido — **fail-closed**: pools públicos sin cargar en Prominense no pueden desproteger al cliente), el move SIN `force: true` → 409 tipado (`PPPOE_MOVE_PUBLIC_IP`) y NADA cambió; CON `force: true` → procede (decisión explícita del operador). IP en pool `cgnat` → procede sin force.
- **S1.6** dado que el orchestrator rechaza la IP elegida por colisión (otro move concurrente la tomó — guard autoritativo `FramedIpAlreadyAssigned`), el move reintenta UNA vez con un `FindFreeIp` fresco y converge a otra IP; si el 2º intento también es rechazado → evento `failed_orchestrator` + error tipado (sin colgar la request).
- **S1.7** dado que la fila del servicio fue borrada entre la lectura y la persistencia (terminate concurrente), el move NO re-crea la fila (update no-creador → typed not-found) Y registra un evento `failed_db` con reason `row_deleted_after_radius_write` (el RADIUS ya quedó escrito — la divergencia deja rastro).
- **S1.8** dado que el update de DB falla DESPUÉS del `changeFramedIp` exitoso, se registra un evento `failed_db` (best-effort) y el error se propaga (respuesta 5xx, nunca request colgada).

## REQ-MOVE-2 — Disconnect inmediato post-move

Tras persistir el move, el sistema DEBE desconectar las sesiones del username (`disconnectSessions`) para forzar re-auth con la IP nueva. El disconnect es best-effort: su fallo NO revierte el move y queda logueado.

- **S2.1** move exitoso → se llamó `disconnectSessions(username)` DESPUÉS de persistir en DB (orden verificable en el test — no alcanza con "después de changeFramedIp").
- **S2.2** `disconnectSessions` lanza → el move devuelve éxito igual (con warning logueado), el servicio quedó movido.

## REQ-MOVE-3 — Ruteo por tipo de NAS (radius vs legacy)

El move DEBE rutear por `routesViaOrchestrator(nas.type)`: NAS radius usa el flujo REQ-MOVE-1 (sin crear/borrar secrets); NAS legacy conserva el flujo actual (create destino → remove origen). Un move entre tipos mixtos radius↔legacy DEBE rechazarse con error tipado.

- **S3.1** ambos radius → flujo nuevo, cero llamadas al `PppoeRouterGateway`.
- **S3.2** ambos legacy → flujo viejo intacto (create+remove por API router).
- **S3.3** mixto → error tipado 422/409, nada cambió.

## REQ-AUTO-1 — Detección de mismatch NAS real vs asignado

El watcher DEBE obtener las sesiones vivas (`listAllSessions`), resolver el NAS real de cada una por `session.nasIpAddress → NasServer.nasIpAddress`, y detectar los servicios cuya sesión viva vino de un NAS ≠ `service.nasId`.

- **S4.1** sesión de `userX` con `nasIpAddress` del NAS B y servicio asignado al NAS A → mismatch detectado.
- **S4.2** sesión con `nasIpAddress` que no matchea ningún `NasServer` → skip + warning logueado (no mueve).
- **S4.3** sesiones cuyo NAS real == asignado → cero acciones.

## REQ-AUTO-2 — Auto-move solo CGNAT

El watcher DEBE auto-mover SOLO servicios cuya IP actual cae en un pool `ipKind='cgnat'`. IP en pool `public` o fuera de todo pool conocido → NO se mueve; se loguea WARN estructurado (username, NAS asignado, NAS real, IP) para aviso/move manual.

- **S5.1** mismatch con IP actual `100.64.60.25` (pool cgnat) → auto-move ejecutado hacia el NAS real.
- **S5.2** mismatch con IP actual `190.15.242.10` (pool public) → NO move, WARN `auto-move skipped: public`.
- **S5.3** mismatch con IP actual fuera de los pools cargados → NO move, WARN.

## REQ-AUTO-3 — Resiliencia por ítem y reintento por tick

Un fallo en el auto-move de UN servicio (p.ej. `NoFreeIpError`) NO DEBE abortar el tick: se loguea y se sigue con el resto. El mismatch persiste → se reintenta naturalmente el tick siguiente.

- **S6.1** dos mismatches, el primero falla con NoFreeIpError → el segundo se mueve igual; el tick reporta 1 moved / 1 failed.

## REQ-AUTO-4 — Feature flag en la Config UI + intervalo configurable

El auto-move DEBE gatearse por el feature flag `pppoe-auto-move` (DB `FeatureFlag`, visible y toggleable desde la Config UI — patrón del toggle de `radius-auth-ingest`), chequeado en cada tick: prender/apagar NO requiere deploy. Default OFF. Intervalo: `AUTO_MOVE_INTERVAL_MS` (default 120000 = 2 min; piso 15s, techo 24h, inválido→default — patrón `parseIntervalMs`).

- **S7.1** flag OFF (o ausente) → el tick no procesa nada (cero moves).
- **S7.2** intervalo inválido → default 2 min, el boot NUNCA falla por esto.
- **S7.3** flag ON → el tick procesa; flag vuelto a OFF → el tick siguiente ya no procesa (sin restart).

## REQ-LOG-1 — Registro VISIBLE de movimientos en la page de auditoría

TODO intento de move (manual o auto) que LLEGA a la fase de asignación —o falla en ella— DEBE persistir un `PppoeNasMoveEvent` con su outcome (`moved` | `failed_no_free_ip` | `failed_orchestrator` | `failed_db` | `failed_router` | `skipped_public` | `skipped_unknown_nas`), consultable por `GET /api/pppoe/nas-move-events` (gate `pppoe.read`, paginado, filtros outcome/trigger/username) y visible en el tab "Movimientos NAS" de la page de auditoría. Los rechazos de guard de input (no-op, mixto, terminated, pública-sin-force) responden 4xx directo al caller y NO persisten fila. Un `moved` con kick fallido lleva `reason='kick_failed'`.

- **S10.1** move manual exitoso → fila `{trigger:'manual', outcome:'moved', fromIp, toIp, actorName}`.
- **S10.2** auto-move con pool destino lleno → fila `{trigger:'auto', outcome:'failed_no_free_ip'}` y el endpoint la devuelve (visible en la UI).
- **S10.3** auto-move skipped por IP pública → fila `{trigger:'auto', outcome:'skipped_public'}`.
- **S10.4** el endpoint pagina y filtra por outcome (`?outcome=failed_no_free_ip` devuelve solo fallos).
- **S10.5 (W2, anti-spam):** un `skipped_*`/`failed_*` del watcher IDÉNTICO al último evento del mismo username (mismo outcome + mismo toNasId) con menos de 6h NO genera fila nueva (el intento igual ocurre; solo se throttlea el registro). Los `moved` SIEMPRE registran.

## REQ-HIST-1 — Evento de historial

Todo move (manual o auto) de un servicio con contrato DEBE registrar un evento en el historial del servicio con `{from: {nasId, ip}, to: {nasId, ip}, trigger}` y actor (operador para manual, "sistema" para auto). Huérfanos: log estructurado.

- **S8.1** move manual con contrato → evento con actor del operador y trigger manual.
- **S8.2** auto-move con contrato → evento con actor sistema y trigger auto.

## REQ-FE-1 — Modal "Mover NAS" honesto

El modal de mover DEBE avisar antes de confirmar: se asignará una IP nueva del pool del NAS destino y se desconectará la sesión. Tras el move, DEBE mostrarse la IP nueva. Si la IP actual es pública, el modal DEBE advertirlo (el operador decide igual).

- **S9.1** confirm del modal → texto de aviso presente (IP nueva + desconexión).
- **S9.2** respuesta del move → la fila/detalle refleja el NAS y la IP nuevos sin reload manual.
- **S9.3** servicio con IP pública → warning visible en el modal.
