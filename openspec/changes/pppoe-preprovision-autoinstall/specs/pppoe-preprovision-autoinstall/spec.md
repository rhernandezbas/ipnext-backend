# Spec: pppoe-preprovision-autoinstall

## REQ-PRE-1 — Creación sin NAS

El sistema DEBE permitir crear un PPPoE radius con `nasId` null (pre-provisión): usuario+password+plan+ipTypePreference obligatorios; va al RADIUS central SIN Framed-IP; persiste `{nasId:null, remoteAddress:null, ipTypePreference}`.

- S1.1 create sin NAS válido → createUser al orchestrator con framedIp null, fila con nasId null, 201.
- S1.2 create sin NAS sin `ipTypePreference` → 422, nada creado.
- S1.3 create sin NAS sin plan → error tipado existente, nada creado.
- S1.4 el flujo CON NAS sigue intacto (regresión) y ahora exige `ipTypePreference` (422 si falta) usándolo para FindFreeIp.

## REQ-PRE-2 — Tipo de IP obligatorio y persistido

`ipTypePreference` ('cgnat'|'public') DEBE ser obligatorio en TODA creación y persistirse. Backfill: filas existentes con IP en pool público cargado → 'public'; resto 'cgnat'.

- S2.1 migración: fila existente con IP `190.7.247.10` (pool público) → 'public'; con `100.64.43.5` → 'cgnat'.
- S2.2 el DTO expone `ipTypePreference`.

## REQ-PRE-3 — Adopción automática (watcher)

Un servicio con `nasId` null y sesión viva DEBE ser adoptado por el watcher: NAS real + IP fija del pool del `ipTypePreference` + kick + evento `moved` con reason `auto_install` y actor sistema. MISMAS defensas del W2 (freshness, conflicto multi-NAS, breaker/cap compartidos, cooldown).

- S3.1 pendiente + sesión fresca en NAS X → adoptado: nasId=X, remoteAddress del pool cgnat de X, kick, evento moved/auto_install.
- S3.2 pendiente con preferencia 'public' + NAS X con pool público → IP del pool público.
- S3.3 pendiente 'public' + NAS sin pool público → fila `failed_no_free_ip` visible (throttled), servicio intacto (sigue pendiente).
- S3.4 pendiente con sesiones en 2 NAS → `skipped_nas_conflict`, sin adopción.
- S3.5 pendiente con única sesión vieja (>72h) → `skipped_stale_session`, sin adopción.
- S3.6 las adopciones cuentan para el cap/breaker del tick.
- S3.7 flag OFF → cero adopciones (pendiente queda visible).

## REQ-PRE-4 — Tolerancia a nasId null en TODO el sistema

Listados, DTOs, tab PPPoE, panel del cliente y rutas DEBEN manejar `nasId` null sin crash. Enforcement/corte de un pendiente → error tipado claro (409, "pendiente de instalación, no operable"), NUNCA 500/crash. El move MANUAL de un pendiente = adopción manual (funciona, respeta `ipTypePreference`).

- S4.1 GET /pppoe con pendientes → 200, items con nas null renderizables.
- S4.2 enforce de un pendiente → 409 tipado.
- S4.3 move manual de un pendiente a NAS X → adopta (IP del tipo persistido), 200.

## REQ-FE-2 — Form y visibilidad

- S5.1 form: tipo de IP SIN preselección; submit deshabilitado hasta elegir.
- S5.2 opción "Sin router — auto-instalación" → oculta IP remota; el submit va sin nasId.
- S5.3 tab PPPoE: pendiente → NAS "—" + badge "Pendiente de instalación"; filtro "Pendientes" round-trip en URL.
- S5.4 flujo con NAS: sin regresión visual, tipo de IP igual de obligatorio.
