# Proposal: NOC Alerts — Reconciliación por Nivel (olt_watch)

## Intent

`sensors/olt_watch.rs` del colector Rust razona por **FLANCOS**: "la ONU cambió
de X a Y", guardando `prev_*` = **lo último VISTO**. Pero una alerta es un
**ESTADO**: "qué hay abierto AHORA en el hub". Cuando un cooldown, una guarda de
sanidad o un reinicio del proceso **interrumpen el flanco**, la transición se
pierde y **no vuelve nunca** (el loop solo actúa ante `prev != cur`; `prev` ya se
pisó con el valor nuevo).

Esa es la causa raíz —una sola— de los **4 CRITICAL** que encontraron 4 vueltas
de review adversarial en la rama congelada `feat/recovery-and-client-name` (PR #2,
NO mergear), cada uno abierto por el parche del anterior:

| # | Parche | CRITICAL que abrió |
|---|--------|--------------------|
| 1 | recuperación = resolver | resolver de más (cierra lo que no anunció) |
| 2 | cooldown por `(sn,categoría)` + bypass | spam sin techo (288 POSTs/día por ONU flapeando) |
| 3 | cooldown corto de escalación | **la escalada se PIERDE PARA SIEMPRE** (ONU en Critical reportada como Warning indefinidamente) |
| 4 | guarda anti-snapshot-vacío | deja la OLT **ciega permanentemente** ante un desplome legítimo; y un apagón zonal la dispara con la API sana |

**Regla derivada, no negociable**: NUNCA conflar *último visto* con *último
anunciado* — son dos estados distintos y viven separados.

Este change **rehace** `olt_watch` sobre **reconciliación por nivel** (modelo
Prometheus): cada ciclo se computa el estado OBSERVADO, se lee el estado
ANUNCIADO del hub, y se emite **la diferencia**. La clase entera de bugs
desaparece por construcción: no hay escalada perdida (se recalcula cada ciclo),
no hay huérfanos (lo anunciado que ya no se observa se cierra), no hay resolves
fantasma (solo se resuelve lo que está realmente anunciado), la guarda pasa a ser
inocua (saltear un ciclo solo atrasa), y el reinicio deja de importar (el estado
anunciado se DERIVA, no se recuerda).

## Scope

### In Scope

**Colector Rust (`ipnext-noc-collector`)**
- Reescritura de `src/sensors/olt_watch.rs`: de `evaluate_*_transitions` (flancos
  + `prev_*` + cooldowns) a un **reconciliador por nivel** puro:
  `observe(snapshot) → desired: Map<Fingerprint, Firing|Clear>` y
  `reconcile(desired, announced) → Vec<Action>`.
- **Tri-estado de observación** `Firing | Clear | Unknown`: lo Unknown se
  **arrastra** (ni fire ni resolve). Resuelve de raíz los hallazgos C1 y C5.
- **Jerarquía de agrupación** OLT → PON → ONU con supresión por contención, para
  que agrupadas e individuales **nunca convivan duplicadas** (hallazgo C3).
- **Freshness window** (`last_online_at` en memoria de observación) para que un
  modelo por nivel no dispare la población CRÓNICA de ONUs en LOS/PowerFail.
- **Histéresis `for:`** (N ciclos sostenidos para abrir / M para cerrar) como
  anti-flapping, más un rate-limiter del **ANUNCIO** que **nunca pierde el delta**.
- Namespace de fingerprints nuevo `olt-level/...` — determinístico, **sin
  timestamp**, dedupeable.
- Guarda de sanidad basada en **cobertura vs. el store propio**, con escape hatch
  (`olt-level/collector-stale/{olt}`).

**Backend (`ipnext-backend`)**
- Endpoint nuevo `GET /api/alerts/ingest/:source/state` — devuelve los
  fingerprints `firing` de ESA fuente, autenticado con **la key de ingesta de esa
  misma fuente** (molde ya probado: `createThresholdsReadAuth`). Es la fuente de
  verdad del estado ANUNCIADO y salda la deuda **M2** (estado en memoria →
  reinicio deja alertas huérfanas).

### Out of Scope
- El ciclo señal/PON: `onu-signal-degraded-{sn}` y `pon-suspect-{olt}-{pon}`
  **NO se tocan** — ese camino funciona bien en prod (`pon_analysis.rs`,
  `signal_poll.rs`, `signal_store.rs`, `pg_client.rs` intactos).
- La rama congelada PR #2: no se parte de ahí, se descarta.
- Grafana, Telegram, SSE, panel FE, umbrales editables: sin cambios.
- Migración de DDL en la DB del colector (`onu_signal_*` sin tocar).

## Capabilities

### New Capabilities
- `olt-level-reconciliation` (colector Rust): modelo observado/anunciado,
  catálogo de condiciones, jerarquía de supresión, freshness, histéresis,
  rate-limiter sin pérdida de estado, guarda de sanidad.
- `noc-alert-announced-state` (BE): `GET /api/alerts/ingest/:source/state` con
  auth de máquina por fuente.

### Modified Capabilities
- `noc-fiber-collector-ingest`: los fingerprints de `olt_watch` pasan de
  `olt-watch-{olt}-{kind}-{timestamp}` (irrepetibles, nunca dedupean) a
  `olt-level/{kind}/{scope}` (estables). El contrato de `POST /ingest/:source`
  no cambia.

## Rollback plan

Tres piezas independientes, cada una reversible por separado:

1. **BE**: el endpoint nuevo es **aditivo** (ruta nueva, sin migración, sin tocar
   `app.ts` más allá del wiring del router de alertas que ya existe). Rollback =
   revert del commit; ninguna ruta existente cambia de comportamiento.
2. **Colector**: `NOC_OLT_WATCH_MODE=legacy|reconcile` (default `legacy` en el
   primer deploy). El binario viejo queda de backup en la VM 130 (`.bak-*`, ya es
   el procedimiento vigente). Rollback = flip de env var + restart, sin deploy.
3. **Datos**: las ~400 alertas legacy se cierran con un `UPDATE` acotado por
   prefijo (paso operativo del cutover, ver design.md §6). Es idempotente y no
   toca `onu-signal-degraded-*` ni `pon-suspect-*`.

## Affected modules

| Repo | Módulo | Riesgo |
|------|--------|--------|
| `ipnext-noc-collector` | `src/sensors/olt_watch.rs` (reescritura), `src/main.rs` (loop + mapeo a `Alert`), `src/hub_client.rs` (GET state), `src/config.rs` (env nuevas) | Alto — es el corazón del change |
| `ipnext-backend` | `src/infrastructure/http/routes/alerts.routes.ts`, `src/application/use-cases/alerts/ListAlerts.ts` (reuso), `src/domain/ports/NocAlertRepository.ts` (filtro por prefijo, opcional) | Bajo — aditivo |

**Flags de la config**: NO toca `src/infrastructure/http/app.ts` salvo el
`AlertsRouterDeps` ya existente (el router de alertas ya está compuesto por
`composeAlertsModule`) → sin riesgo adicional de God Object.
**Splynx**: no agrega ninguna dependencia.
