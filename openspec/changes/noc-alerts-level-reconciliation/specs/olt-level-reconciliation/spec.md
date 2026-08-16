# OLT Level Reconciliation Specification

## Purpose

Reemplaza la máquina de estados por FLANCOS de `sensors/olt_watch.rs` (colector
Rust `ipnext-noc-collector`) por **reconciliación por NIVEL**: cada ciclo se
computa el estado OBSERVADO, se lee el estado ANUNCIADO del hub, y se emite la
DIFERENCIA. Cubre LOS, power-fail, uptime/alcanzabilidad de la OLT y categoría de
señal.

**Alcance negativo explícito**: NO toca el ciclo señal/PON. Los fingerprints
`onu-signal-degraded-{sn}` y `pon-suspect-{olt}-{pon}` quedan intactos y son
INVISIBLES para este reconciliador.

## Requirements

### Requirement: Estado anunciado leído del hub, nunca recordado

El colector DEBE (MUST) obtener el estado ANUNCIADO en CADA ciclo vía
`GET /api/alerts/ingest/fiber-collector/state`, y NO DEBE (MUST NOT) derivarlo de
lo último visto ni persistirlo localmente. Si el GET falla, el colector DEBE
saltear la reconciliación de ese ciclo sin mutar ningún estado.

#### Scenario: El anunciado se relee en cada ciclo
- GIVEN un ciclo previo que anunció `olt-level/onu-los/A1` como firing
- WHEN arranca el ciclo siguiente
- THEN el colector pide `GET /api/alerts/ingest/fiber-collector/state`
- AND usa la respuesta —no una copia en memoria— como estado anunciado

#### Scenario: Un reinicio del proceso no deja alertas huérfanas
- GIVEN el hub tiene `olt-level/onu-los/A1` en firing y la ONU A1 volvió Online
- WHEN el colector arranca DE CERO (sin memoria) y corre su primer ciclo
- THEN observa `Clear` para `olt-level/onu-los/A1`
- AND emite `resolved` para ese fingerprint

#### Scenario: Fallo del GET saltea el ciclo sin efectos
- GIVEN el hub responde 500 al `GET .../state`
- WHEN corre el ciclo
- THEN NO se emite ninguna alerta (ni firing ni resolved)
- AND el ciclo siguiente reconcilia normalmente

### Requirement: Ownership por prefijo `olt-level/`

El reconciliador DEBE (MUST) considerar únicamente fingerprints con prefijo
`olt-level/`. Cualquier otro fingerprint del set anunciado DEBE ser ignorado:
nunca resuelto, nunca modificado.

#### Scenario: El ciclo señal/PON queda intacto
- GIVEN el estado anunciado contiene `onu-signal-degraded-A1`, `pon-suspect-1-1/5` y `olt-watch-1-los-ramal-2026-07-20T10:00:00Z`
- WHEN corre la reconciliación con un `desired` vacío
- THEN NO se emite `resolved` para ninguno de esos tres fingerprints

#### Scenario: Los fingerprints son estables y sin timestamp
- GIVEN la misma condición observada en dos ciclos distintos
- WHEN se computa su fingerprint
- THEN es idéntico en ambos ciclos (dedupea en el hub, no crea filas nuevas)

### Requirement: Observación tri-estado con arrastre de lo desconocido

Cada condición DEBE (MUST) observarse como `Firing`, `Clear` o `Unknown`.
`Unknown` se representa por AUSENCIA del fingerprint en el mapa observado y NO
DEBE (MUST NOT) producir ninguna acción: el estado anunciado se arrastra sin
cambios.

#### Scenario: Firing no anunciado abre la alerta
- GIVEN `olt-level/onu-los/A1` observado como `Firing` y ausente del anunciado
- WHEN se reconcilia
- THEN se emite `firing` para ese fingerprint

#### Scenario: Anunciado que ya no se observa se cierra
- GIVEN `olt-level/onu-los/A1` anunciado como firing y observado como `Clear`
- WHEN se reconcilia
- THEN se emite `resolved` para ese fingerprint

#### Scenario: Sin cambio no se emite nada
- GIVEN `olt-level/onu-los/A1` anunciado como firing y observado como `Firing` con la MISMA severidad
- WHEN se reconcilia
- THEN NO se emite ninguna acción para ese fingerprint

#### Scenario: Unknown arrastra el estado anunciado
- GIVEN `olt-level/onu-los/A1` anunciado como firing
- AND el fingerprint está AUSENTE del mapa observado
- WHEN se reconcilia
- THEN NO se emite ni `firing` ni `resolved` para ese fingerprint

### Requirement: Señal no medible es ausencia de dato, no un nivel

Una categoría de señal `Offline`, `Power fail`, `N/A` o desconocida DEBE (MUST)
observarse como `Unknown` para `olt-level/onu-signal-critical/{sn}`, y NO DEBE
(MUST NOT) observarse como `Clear`.

#### Scenario: [REGRESIÓN C5] Una ONU con señal crítica que se apaga no resuelve su alerta de señal
- GIVEN `olt-level/onu-signal-critical/A1` anunciado como firing
- WHEN SmartOLT reporta la ONU A1 con señal `N/A` y condición `Power fail`
- THEN NO se emite `resolved` para `olt-level/onu-signal-critical/A1`
- AND la condición de power-fail se evalúa por su propio camino

### Requirement: Freshness — la población crónica no dispara alertas

Una ONU en LOS DEBE (MUST) considerarse alertable solo si fue vista `Online`
dentro de `LOS_FRESH_WINDOW`. Una ONU en LOS con freshness DESCONOCIDA NO DEBE
(MUST NOT) abrir una condición nueva, pero SI ya estaba anunciada DEBE observarse
como `Unknown` (arrastre), nunca como `Clear`. Regla análoga para `PowerFail` con
`PWR_FRESH_WINDOW`.

#### Scenario: Arranque en frío no inunda el panel
- GIVEN el colector arranca sin memoria de observación
- AND SmartOLT reporta 300 ONUs en LOS, ninguna anunciada
- WHEN corre el primer ciclo
- THEN NO se emite ninguna alerta individual de LOS

#### Scenario: Una alerta abierta sobrevive al arranque en frío
- GIVEN `olt-level/onu-los/A1` anunciado como firing
- AND el colector arranca sin memoria y observa A1 todavía en LOS
- WHEN corre el primer ciclo
- THEN NO se emite `resolved` para `olt-level/onu-los/A1`

#### Scenario: Una ONU crónicamente en LOS envejece y se cierra
- GIVEN `olt-level/onu-los/A1` anunciado como firing
- AND A1 sigue en LOS y su `last_online_at` es anterior a `LOS_FRESH_WINDOW`
- WHEN se reconcilia
- THEN se emite `resolved` para `olt-level/onu-los/A1`

### Requirement: Jerarquía OLT → PON → ONU con supresión por contención

Las condiciones agrupadas DEBEN (MUST) computarse como niveles derivados del
snapshot. La precedencia DEBE resolverse top-down y cada ONU DEBE contribuir a
EXACTAMENTE un tier. Los fingerprints suprimidos por un tier superior DEBEN
observarse como `Clear` (no `Unknown`), de modo que agrupadas e individuales
nunca convivan.

#### Scenario: Dos ONUs fresh en LOS en el mismo PON producen ramal, no individuales
- GIVEN A1 y A2 en LOS-fresh, ambas en el PON `1/5` de la OLT `1`
- WHEN se observa el snapshot
- THEN `olt-level/pon-outage/1/1/5` se observa `Firing` con severidad `critical`
- AND `olt-level/onu-los/A1` y `olt-level/onu-los/A2` se observan `Clear`

#### Scenario: [REGRESIÓN C3] Una individual anunciada que escala a ramal se cierra
- GIVEN `olt-level/onu-los/A1` anunciado como firing
- WHEN A2 (mismo PON `1/5`) también entra en LOS-fresh
- THEN se emite `firing` para `olt-level/pon-outage/1/1/5`
- AND se emite `resolved` para `olt-level/onu-los/A1`

#### Scenario: Al repararse parcialmente el ramal reabre la individual
- GIVEN `olt-level/pon-outage/1/1/5` anunciado como firing con A1 y A2 en LOS
- WHEN A2 vuelve Online y A1 sigue en LOS-fresh
- THEN se emite `resolved` para `olt-level/pon-outage/1/1/5`
- AND se emite `firing` para `olt-level/onu-los/A1`

#### Scenario: Mass-LOS de OLT suprime los PON y las individuales
- GIVEN 3 o más ONUs en LOS-fresh repartidas en 2 o más PONs de la OLT `1`
- WHEN se observa el snapshot
- THEN `olt-level/olt-mass-los/1` se observa `Firing` con severidad `critical`
- AND todos los `olt-level/pon-outage/1/*` y `olt-level/onu-los/*` de esa OLT se observan `Clear`

#### Scenario: Power fail zonal es un nivel por OLT
- GIVEN 5 o más ONUs de la OLT `1` en `PowerFail` fresh
- WHEN se observa el snapshot
- THEN `olt-level/olt-power-outage/1` se observa `Firing` con severidad `warning`

#### Scenario: 4 ONUs en power fail no alcanzan el nivel zonal
- GIVEN 4 ONUs de la OLT `1` en `PowerFail` fresh
- WHEN se observa el snapshot
- THEN `olt-level/olt-power-outage/1` se observa `Clear`

### Requirement: Salud de la OLT derivada del nivel, no del flanco

`olt-level/olt-recent-restart/{olt}` DEBE (MUST) derivarse de `uptime_s <
RESTART_WINDOW` (sin comparar contra el uptime del ciclo anterior).
`olt-level/olt-unreachable/{olt}` DEBE fire tras 2 ciclos consecutivos sin datos
de uptime. Mientras `olt-unreachable` esté firing, todas las condiciones de ONU
de esa OLT DEBEN observarse como `Unknown`.

#### Scenario: Reinicio de OLT detectado sin memoria previa
- GIVEN el colector arranca de cero
- AND SmartOLT reporta la OLT `1` con `uptime_s = 120`
- WHEN corre el primer ciclo
- THEN se emite `firing` para `olt-level/olt-recent-restart/1`

#### Scenario: El reinicio se auto-resuelve al pasar la ventana
- GIVEN `olt-level/olt-recent-restart/1` anunciado como firing
- WHEN SmartOLT reporta `uptime_s = 1200` (mayor que `RESTART_WINDOW`)
- THEN se emite `resolved` para ese fingerprint

#### Scenario: Una OLT inalcanzable no resuelve las alertas de sus ONUs
- GIVEN `olt-level/onu-los/A1` anunciado como firing en la OLT `1`
- WHEN la OLT `1` no devuelve uptime por 2 ciclos consecutivos
- THEN se emite `firing` para `olt-level/olt-unreachable/1`
- AND NO se emite `resolved` para `olt-level/onu-los/A1`

### Requirement: Guarda de sanidad que no puede trabarse

Un snapshot DEBE (MUST) considerarse no confiable si (a) la llamada devolvió
error o el envelope de SmartOLT trajo `status:false`, (b) el HTTP fue 429/5xx, o
(c) las filas devueltas —contadas SIN filtrar por condición— son menos que
`COVERAGE_FLOOR` × el conteo de ONUs de esa OLT en `onu_signal_current`. Un
snapshot no confiable DEBE producir un mapa observado VACÍO para esa OLT (todo
`Unknown`) y NO DEBE mutar ningún estado. El colector DEBE anunciar
`olt-level/collector-stale/{olt}` tras `STALE_CYCLES` ciclos salteados
consecutivos.

#### Scenario: [REGRESIÓN C1] Un snapshot vacío no resuelve nada
- GIVEN 40 fingerprints `olt-level/*` de la OLT `1` anunciados como firing
- WHEN SmartOLT devuelve 0 ONUs para la OLT `1`
- THEN NO se emite ningún `resolved`

#### Scenario: [REGRESIÓN C1-bis] La guarda se destraba sola al ciclo siguiente
- GIVEN el ciclo anterior salteó la OLT `1` por snapshot no confiable
- WHEN el ciclo siguiente devuelve un snapshot con cobertura suficiente
- THEN se reconcilia normalmente
- AND se emiten todos los deltas pendientes

#### Scenario: [REGRESIÓN HIGH#1] Un apagón zonal NO dispara la guarda
- GIVEN `onu_signal_current` tiene 700 ONUs para la OLT `1`
- WHEN SmartOLT devuelve las 700 filas, de las cuales 650 en `Power fail`
- THEN el snapshot se considera CONFIABLE (cobertura 100%)
- AND se emite `firing` para `olt-level/olt-power-outage/1`

#### Scenario: Un desplome legítimo no ciega la OLT para siempre
- GIVEN la OLT `1` viene devolviendo cobertura por debajo del piso 3 ciclos seguidos
- WHEN corre el tercer ciclo
- THEN se emite `firing` para `olt-level/collector-stale/1`

### Requirement: Histéresis en la observación

Una condición DEBE (MUST) entrar en el mapa observado como `Firing` recién tras
`FIRE_FOR` ciclos consecutivos cumpliéndose, y como `Clear` recién tras
`CLEAR_FOR` ciclos consecutivos sin cumplirse. Entre medio DEBE observarse como
`Unknown`.

#### Scenario: [REGRESIÓN C2] Una ONU que oscila no genera spam
- GIVEN una ONU cuya señal alterna `Critical` y `Warning` en ciclos alternos
- WHEN corren 20 ciclos
- THEN NO se emite ninguna acción para `olt-level/onu-signal-critical/{sn}`

#### Scenario: Una condición sostenida sí abre
- GIVEN una ONU con señal `Critical` en `FIRE_FOR` ciclos consecutivos
- WHEN corre ese último ciclo
- THEN se emite `firing` para `olt-level/onu-signal-critical/{sn}`

### Requirement: El rate-limiter del anuncio nunca pierde el delta

El rate-limiter DEBE (MUST) actuar SOLO sobre el ANUNCIO. Un anuncio suprimido
por límite —o un POST que falló— NO DEBE (MUST NOT) mutar ningún estado: el mismo
delta DEBE recomputarse y reintentarse en el ciclo siguiente. Cuando el techo
global por ciclo se alcanza, los anuncios DEBEN priorizarse por severidad
descendente.

#### Scenario: [REGRESIÓN C4-bis] Una escalación suprimida NO se pierde
- GIVEN `olt-level/onu-signal-critical/A1` observado `Firing` y el rate-limiter lo suprime en el ciclo N
- WHEN corre el ciclo N+1 y la condición sigue observándose `Firing`
- THEN el delta sigue existiendo
- AND se emite `firing` en cuanto el limiter lo permite

#### Scenario: Un POST fallido se reintenta
- GIVEN se emitió `firing` para `olt-level/onu-los/A1` y el hub respondió 503
- WHEN corre el ciclo siguiente con la misma observación
- THEN el fingerprint sigue ausente del estado anunciado
- AND se vuelve a emitir `firing`

#### Scenario: El techo por ciclo difiere, no descarta
- GIVEN 120 acciones pendientes y `MAX_ANNOUNCES_PER_CYCLE = 50`
- WHEN corre el ciclo
- THEN se emiten 50 acciones, las de severidad más alta primero
- AND las 70 restantes se recomputan y emiten en los ciclos siguientes

### Requirement: Convivencia con el camino legacy

El modo de operación DEBE (MUST) ser seleccionable por env var
`NOC_OLT_WATCH_MODE` con valores `legacy` (default) y `reconcile`. El binario NO
DEBE ejecutar ambos caminos en el mismo ciclo.

#### Scenario: El default no cambia el comportamiento en prod
- GIVEN `NOC_OLT_WATCH_MODE` sin definir
- WHEN arranca el colector
- THEN corre el camino legacy y NO llama a `GET .../state`
