# Design: pppoe-preprovision-autoinstall

## D1 — `nasId` nullable (migración segura) + lecturas tolerantes

`PppoeService.nasId String` → `String?` (ALTER DROP NOT NULL — no destructivo; la relación `nas` pasa a opcional). **Barrido obligatorio de lectores**: DTOs, `listAllPaginated` (filtro por nasId no debe romper con null), tab PPPoE (render "Sin NAS — pendiente de instalación"), enforcement/corte (un pendiente NO es operable: guard con error tipado claro, no crash), `IngestPppoeFromNas`/asociación, move manual (mover un pendiente A MANO = asignarle NAS por primera vez — debe funcionar como adopción manual). El composition/route tests pinean los caminos con null.

## D2 — `ipTypePreference` persistido y obligatorio

Campo `ipTypePreference String @default("cgnat")` ('cgnat' | 'public'). En el CREATE es **input obligatorio** (zod rechaza ausente). Backfill en la migración (idempotente, no destructivo): filas cuya `remoteAddress` cae en un pool `ipKind='public'` cargado → 'public'; resto queda 'cgnat' (default). El campo lo consume:
- **La creación CON NAS** (flujo actual): reemplaza el toggle-sugerencia — `FindFreeIp(nas, ipTypePreference)`.
- **La auto-instalación**: `FindFreeIp(nasReal, ipTypePreference)`. 'public' en un NAS sin pool público cargado → `NO_POOL_FOR_NAS_TYPE` → fila `failed_no_free_ip` VISIBLE (throttled) — queda para manual o cargar el pool.
- El move manual NO cambia (semántica W1 intacta: cgnat + force para no-cgnat).

## D3 — Creación sin NAS

`CreatePppoeService` acepta `nasId: null` SOLO en modo pre-provisión: valida plan (obligatorio como siempre), llama `orchestrator.createUser({username, password, plan, framedIp: null})`, persiste `{nasId: null, remoteAddress: null, ipMode: 'fixed', ipTypePreference}`. NO llama FindFreeIp (no hay pool sin NAS). Guards existentes intactos (contrato con PPPoE activo, profile requerido). El servicio nace `enabled` — el RADIUS ya lo autentica; "pendiente" es una DERIVACIÓN (`nasId === null`), no un status nuevo (cero cambios al union de status que el FE pinea).

## D4 — Watcher: rama "pending install" (adopción)

En `AutoMovePppoe`, un servicio con `nasId === null` y sesión viva NO es mismatch: es **adopción**. Diferencias vs move:
- No hay "NAS origen" ni IP que perder → SIN guard de pública por IP actual (la preferencia manda el pool).
- MISMAS defensas: freshness de la sesión ganadora (la sesión post-instalación es fresca por definición), conflicto multi-NAS → `skipped_nas_conflict`, breaker y cap COMPARTIDOS (una adopción cuenta como move del tick), throttle de fallos.
- Ejecuta `MovePppoeToNas` (que ya soporta origen-null tras D1) con `trigger:'auto'`, pool = `ipTypePreference`, reason del evento `auto_install` (outcome `moved` — SIN outcome nuevo, el FE no cambia).
- Cooldown aplica igual (una adopción recién hecha no se re-procesa).

## D5 — FE

1. **Form "Cargar PPPoE"**: "Tipo de IP" pasa a REQUERIDO sin preselección (dos botones, ninguno activo; submit deshabilitado + hint hasta elegir — decisión consciente del operador, pedido explícito del usuario). Selector de Router gana la opción **"Sin router — auto-instalación"** (primera opción, con hint: "El sistema asigna el NAS y la IP cuando el cliente se conecta por primera vez"). Con "Sin router": el campo IP remota se oculta (no aplica).
2. **Visibilidad del pendiente**: badge "Pendiente de instalación" (familia warning) en el tab PPPoE (columna NAS → "—" + badge) y en el panel de Internet del cliente. Filtro rápido "Pendientes" en el tab (query param, round-trip).
3. ui-ux-pro-max obligatorio.

## W0 — Recon EJECUTADO (2026-07-02) — RESULTADO

- **NE8000 (Acceso Sur): GO** ✅ — `ip-pool asur-cgnat` en el domain asigna sin Framed-IP (Free=83, verificado).
- **Los 8 MikroTiks: NO-GO hoy** ❌ — TODOS los pppoe-servers usan `default-profile=_NO-SECRET`, y ese perfil tiene `local-address` + `rate-limit=1k/1k` pero **SIN `remote-address`** → una sesión RADIUS aceptada SIN Framed-IP no completa IPCP (no hay dirección) → el pre-provisionado NO conecta y el watcher nunca lo ve. (El pool-emergencia de canepa está en el perfil `default`, que los servers NO usan.)

### W0.5 — ✅ APLICADO EN LOS 8 (2026-07-02, OK del usuario, verificado por router)

Pool nuevo `pool-preinstall` = `172.31.255.2-172.31.255.254` (rango RFC1918 libre en los 8, verificado con print fresco contra TODOS los pools existentes — cero solapamiento con rangos CGNAT/públicos reales: un temporal jamás pisa la IP fija de un cliente offline) + `/ppp profile set _NO-SECRET remote-address=pool-preinstall`. Verificado `remote-address=pool-preinstall` en: hipico, vialidad, ugarte, parque, rodriguez, opendoor, estudiantes, canepa. **Los 9 NAS quedan GO** (NE8000 ya era GO por su domain pool). Nota: el test end-to-end real (CPE discando sin Framed-IP) ocurre naturalmente con la primera pre-provisión instalada — no es simulable remoto.

### (referencia) El plan original del W0.5

`/ppp profile set _NO-SECRET remote-address=<pool-local-del-router>` en los 8. Quirúrgico: solo afecta usuarios ACEPTADOS sin Framed-IP (= los pre-provisionados; los clientes reales tienen Framed-IP del RADIUS que pisa el perfil; credenciales malas = Access-Reject, jamás llegan al perfil). El `rate-limit=1k/1k` existente es DESEABLE (el pre-provisionado no navega hasta ser adoptado ≤2 min después). Requiere elegir/crear el pool por router (varios ya tienen pools de emergencia/dinámicos; si no, crear un rango dummy chico). Verificación por router: crear usuario de prueba sin Framed-IP → conecta → aparece en radacct → borrar.

Mientras W0.5 no esté hecho en un router, los pre-provisionados instalados ahí quedan "Pendiente de instalación" visibles (no conectan) — la feature funciona completa en el NE8000 desde el día 1.

## D6 — Endurecimiento post-review (fix wave, 2026-07-02; 2 revisores BE: 1 CRITICAL + 8 W/S)

1. **Adopciones FUERA del abort-threshold (CRITICAL):** el breaker protege contra inventario roto; un pendiente-con-sesión NO es evidencia de inventario roto. Los pendientes acumulados (flag OFF días = modo esperado pre-go-live) NO abortan el tick: se cuentan aparte y se drenan por el CAP (10/tick, deferred). Los mismatches REALES siguen contando para el abort. Test: 30 pendientes + 5 mismatches reales → tick NO aborta, procesa 10, `deferred`.
2. **Adopciones EXENTAS del freshness gate:** un username pre-provisionado es NUEVO — no pueden existir sesiones colgadas históricas de él; una sesión vieja en el pool preinstall = el CPE instalado esperando (la premisa "fresca por definición" era falsa si la adopción se demora — instalado lunes, flag ON jueves). Peor caso = adoptar con cliente ya offline → converge solo cuando vuelve. El guard multi-NAS sí aplica. Test: sesión de 5 días → SE adopta.
3. **Anti-starvation del cap:** candidato cuyo último evento idéntico es `failed_*` (<6h, mismo toNas) NO consume slot del cap (skip con counter `skippedRecentFailure`; reintenta al expirar la ventana) — un 'public' sin pool cargado no puede ocupar 1 de los 10 slots CADA tick para siempre.
4. **Carrera doble-adopción (tick vs manual):** verificación post-persist barata — re-leer el servicio tras `setNasAndIp`; si `remoteAddress` ≠ la IP escrita en RADIUS (otro actor interleaved) → evento visible reason `concurrent_adoption_detected` + WARN (sin auto-heal — intervención manual; ventana sub-segundo).
5. **Pendiente → NAS legacy (no-radius): error tipado** (el moveLegacy adoptaba SIN IP, ignorando la preferencia, dejando fantasma en el RADIUS central). Hoy no hay NAS legacy en prod — guard de bomba latente.
6. **`remoteAddress`/`framedIp` SIN `nasId` → 422** (zod refine): el input incoherente no se descarta en silencio.
7. **`pending=true` en `GET /pppoe` + `GET /pppoe/ids`** (`nasId IS NULL`): el chip "Pendientes" del FE pasa a server-side (paginación correcta; hallazgo convergente de ambos reviews).
8. **`ipTypePreference='public'` + NAS pool-mode → error tipado** (el sqlippool asignaría cgnat y el alta "public" mentiría; dormant hoy).
9. **Migración:** la regex del backfill excluye octetos con cero a la izquierda (`100.064.x` → `::inet` de PG moderno lo rechaza → crash teórico del deploy).
10. **Tests faltantes:** breaker-con-adopciones, `auto_install_kick_failed`, cooldown sobre adopción.
11. **Nota de producto (pregunta abierta, NO código):** la pre-provisión deja la línea INTERNET del contrato `active` antes de la instalación física — revisar implicancia de facturación con el usuario.
12. **Orden de deploy INVERTIDO: FE PRIMERO** (schemas del BE viejo no-strict ignoran `ipTypePreference`; solo "Sin router" da 422 polite hasta que llegue el BE). Mobile verificado: no llama estos POSTs. `changeFramedIp` upsert verificado en el orchestrator real (adopción funciona en el control-plane).

## D7 — Mini fix wave post-re-review (2026-07-02)

1. **Exención de freshness ACOTADA POR NACIMIENTO:** la adopción solo actúa si `startedAt(sesión ganadora) >= createdAt(servicio)` — una sesión que PRECEDE a la pre-provisión no puede ser su instalación (es una colgada histórica del username RECICLADO: terminate+recreate es el workaround documentado para editar pendientes). Sesión anterior al alta → `skipped_stale_session` visible (restaura la garantía del C1). Preserva "instalado lunes, flag ON jueves" (esa sesión nace después del alta). `startedAt` no parseable → epoch 0 → skip (cubierto).
2. **Anti-starvation acotado a outcomes persistentes-por-construcción** (`failed_no_free_ip`, `failed_router`): un `failed_orchestrator` transitorio (hiccup) ya no suprime candidatos 6h bajo presión.
3. **`setNasAndIp` condicional para adopciones** (param aditivo `expectedNasId: null`): `UPDATE ... WHERE id=? AND nasId IS NULL` — el perdedor de la carrera doble-adopción matchea 0 filas y falla determinístico con señal tipada (cierra el lado DB por completo; el post-persist check de D6.4 queda como segunda red).

## Riesgos

| Riesgo | Mitigación |
|---|---|
| NAS sin pool fallback → pre-provisionado no conecta nunca | W0 documenta GO/NO-GO por NAS; queda visible como "Pendiente" en el tab |
| 'public' en NAS sin pool público | fila `failed_no_free_ip` visible + throttled; manual o cargar pool |
| Flag OFF → pendientes acumulados | visibles con badge + filtro; adopción manual (move) siempre disponible |
| Lecturas con nasId null rompiendo listados/enforcement | barrido D1 con tests por camino |
| Watcher adopta con sesión colgada ajena (username reciclado) | freshness + username exacto ya en W2 |
