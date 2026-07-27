# Proposal: Base propia Postgres para el histórico de señal de fibra (deadband)

> ⚠️ **El código de este change NO vive en este repo.** Vive en
> `ipnext-noc-collector` (Rust, branch `feat/sensors`). Los artefactos SDD viven acá por
> convención del proyecto (mismo precedente que la Fase E de `noc-alerts-hub`).
> Runner de tests: **`cargo test`** (no `npm test`).

## Intent

El colector Rust (`nochub-collector`, VM 130 `10.75.0.40`) **no tiene histórico propio**: lee el
baseline de señal desde el InfluxDB que llena `onu_signal_poll.py` (Python). Eso genera dos
problemas, uno estructural y uno que ya está roto HOY:

1. **Dependencia oculta e invertida.** El Rust vino a reemplazar a los scripts Python, pero
   *depende* de que uno de ellos siga vivo. Si se apaga `onu_signal_poll.py` en el cutover, el
   colector queda ciego sin que nada falle ruidosamente. El cutover está bloqueado por esto.
2. **La query heredada de baseline está ciega y no se puede arreglar desde afuera.**
   `influx_client.rs:51-57` pide `MEDIAN(rx)` en una ventana de **2 días de ancho** centrada en
   `now()-Nd`. Medido en vivo (engram `noc-alerts-hub/rust-collector-deployed`): las tres
   ventanas (7/15/30d) vienen **VACÍAS** → `pon_suspects=0` e `individual=0` en cada ciclo desde
   el deploy. El `fibra_report.py` viejo usa la MISMA query → el sistema entero lleva meses ciego
   a las degradaciones. Re-sembrar no sirve: la ventana se mueve, el punto sembrado no.

La solución no es parchar Influx: es **ser dueños del store**. Con base propia, la query de
baseline pasa de "mediana de una ventana estrecha" a **"último valor conocido antes de la fecha
X"** (`DISTINCT ON` / `LATERAL`), que por construcción **nunca viene vacía** mientras exista
cualquier dato anterior a X. Eso arregla la ceguera, no la mitiga.

Y para que el store no explote, se escribe con **deadband**: no las ~2803 ONUs cada ciclo
(134k filas/día) sino **solo cuando la señal cambia** + un heartbeat de anclaje
(→ ~15k filas/día, **-89%**).

## Scope

### In Scope
- **Servicio Postgres nuevo** en EasyPanel del `.37` (creado por el usuario — ver Bloqueantes),
  con DB/rol dedicados y accesible por red desde la VM 130.
- **Esquema de 2 tablas** versionado y migrado desde el propio binario Rust
  (`onu_signal_current` + `onu_signal_history`), con la política de retención definida **desde el
  día 1** (no "a definir después").
- **Módulo `pg_client`** en el colector: pool, migraciones embebidas, bulk insert por ciclo,
  carga de estado al arrancar, query de baseline nueva, poda de retención.
- **Política de escritura con deadband** como **función pura** (`decide_write`), testeable sin DB
  — mismo molde que `pon_analysis`.
- **Topología `sn → (olt, pon)` desde nuestra propia tabla** `onu_signal_current` (hoy se lee de
  los tags de Influx) → esto es lo que **corta la última atadura** con el Python. Costo en API de
  SmartOLT: **cero** (no se agrega ninguna llamada).
- Config nueva (`NOC_PG_URL`, deadband, heartbeat, retención, fuente de baseline) y **retiro de
  `NOC_SHADOW`** (verificado: hoy no gatea nada, solo loguea — `main.rs:81-87`).
- CI: job con service container Postgres para los tests de integración de SQL.

### Out of Scope
- **Migrar los datos históricos de Influx.** Decisión del usuario: se arranca de CERO.
- **Apagar `onu_signal_poll.py` / `fibra_report.py` / el InfluxDB.** Siguen corriendo intactos.
  Este change los deja de *necesitar*; jubilarlos es un change posterior.
- Cambiar `pon_analysis::analyze` (la lógica de análisis no se toca — solo cambia de dónde salen
  los `baseline_7d/15d/30d` que ya recibe en `OnuReading`).
- Exponer el histórico por API/panel de Prominense (el hub no lee esta base; es privada del
  colector).
- Mover `deadband`/`heartbeat` al endpoint de umbrales del hub (`GET /api/alerts/thresholds`) —
  se queda en env, con nota de extensión futura.
- El loop `olt_watch` (5 min) — no usa baseline, no se toca, **sigue alertando durante todo el
  período de maduración**.

## Capabilities

### New Capabilities
- **`noc-fiber-signal-store`** — el store en sí: esquema, migraciones versionadas embebidas en el
  binario, invariantes de las 2 tablas, retención y poda segura, índices.
- **`noc-fiber-signal-deadband`** — la política de escritura: comparación contra el último valor
  **guardado**, heartbeat, ONU nueva, dedup de batch, idempotencia del flush, recarga de estado
  al arrancar, degradación ante caída de red.
- **`noc-fiber-baseline-source`** — resolución del baseline ("último valor antes de X"),
  topología desde `onu_signal_current`, selección de fuente (`postgres` | `influx` | `dual`) y
  config/cutover.

### Modified Capabilities
Ninguna capability de este repo. En el repo del colector se modifican `config.rs` (env nuevas,
retiro de `NOC_SHADOW`) y `main.rs` (wiring del loop señal/PON); `influx_client.rs` queda intacto
como fuente **opcional** de fallback.

## Approach

Cinco fases. Las 3 primeras son código y se pueden construir y testear **sin** el servicio de
EasyPanel (tests con service container en CI). La 4 y la 5 requieren el bloqueante resuelto.

| Fase | Entrega | Depende de |
|------|---------|-----------|
| **1 — Esquema + migraciones** | `migrations/0001_init.sql` embebido con `sqlx::migrate!`; conexión, pool, arranque perezoso. Tests de integración contra PG efímero. | Elección de crate (§Decisiones abiertas) |
| **2 — Deadband (lógica pura)** | `decide_write()` + estado en memoria + heartbeat + ONU nueva + dedup de batch. **100% unit tests, cero DB.** | 1 (solo por los tipos) |
| **3 — pg_client (IO)** | Bulk insert transaccional por ciclo, carga de estado al arrancar, query de baseline (LATERAL ×3), poda de retención. | 1, 2 |
| **4 — Wiring + config** | `main.rs` usa PG para baseline y topología; env nuevas; `NOC_SHADOW` retirado; log de métricas por ciclo. | 3 |
| **5 — Cutover operativo** | Deploy con `NOC_PG_URL`; maduración 7/15/30d; recién al final se saca `NOC_INFLUX_URL` del `.env`. | Servicio EasyPanel creado |

**Orden del cutover (importa):** el `NOC_INFLUX_URL` se saca **último**, no primero. Durante la
maduración el colector escribe a Postgres y (si se elige `dual`) puede seguir leyendo Influx sin
riesgo — los destinos son distintos, no hay conflicto posible con el Python.

## Affected Areas

| Área | Repo | Impacto | Descripción |
|------|------|---------|-------------|
| `migrations/0001_init.sql` | `ipnext-noc-collector` | New | Esquema versionado, embebido en el binario. |
| `src/pg_client.rs` | `ipnext-noc-collector` | New | Pool, migrate, bulk insert, baseline, poda. |
| `src/signal_store.rs` (o `sensors/deadband.rs`) | `ipnext-noc-collector` | New | Lógica **pura** del deadband + estado. |
| `src/config.rs` | `ipnext-noc-collector` | Modified | +5 env; **-`shadow`**. |
| `src/main.rs` | `ipnext-noc-collector` | Modified | Wiring del loop señal/PON; baseline y topología desde PG. |
| `src/influx_client.rs` | `ipnext-noc-collector` | Unchanged | Queda como fallback opcional. |
| `Cargo.toml` | `ipnext-noc-collector` | Modified | +1 dep de DB (ver decisión abierta). |
| `.github/workflows/deploy.yml` | `ipnext-noc-collector` | Modified | Service container Postgres en el job `ci`. |
| `env.example`, `README.md`, `deploy/noc-collector.service` | `ipnext-noc-collector` | Modified | Documentar env nuevas. |
| Infra `.37` | — | New | Servicio Postgres en EasyPanel + regla de red hacia VM 130. |

**Flags del proyecto (config.yaml):** este change **no** toca `src/infrastructure/http/app.ts` ni
agrega dependencias de Splynx. No aplica.

## Números que sostienen el diseño

| Concepto | Valor |
|---|---|
| ONUs medidas por ciclo | ~2.803 |
| Ciclos/día (30 min) | 48 |
| Filas/día **sin** deadband | ~134.500 |
| Piso de heartbeat (6 h → 4/día/ONU) | ~11.200 filas/día |
| Cambios reales estimados (deadband 0,5 dB) | ~3.800 filas/día |
| **Total estimado** | **~15.000 filas/día** (-89%) |
| Filas/año | ~5,5 M |
| Tamaño/año (heap + índices, medido por ancho de tupla) | **~570 MB** |
| Con retención de 24 meses | ~11 M filas, **~1,15 GB** |

Observación que hay que tener a la vista: **el heartbeat, no los cambios, es el 75% del volumen.**
Es el precio explícito de poder distinguir "no cambió" de "dejó de reportar" y de que la poda por
tiempo sea segura. Es un knob (`NOC_SIGNAL_HEARTBEAT_HOURS`): a 12 h el total baja a ~9,4k/día;
a 24 h a ~6,6k/día. Se arranca en 6 h por decisión del usuario y se mide.

## Rollback plan

El change es **puramente aditivo** desde el punto de vista operativo: escribe en una base nueva
que nadie más usa, y no toca Influx, ni el Python, ni el hub.

| Escenario | Rollback |
|---|---|
| El colector se porta mal con PG | Sacar `NOC_PG_URL` del `.env` + `systemctl restart`. El binario vuelve a correr sin path de PG (baseline vía Influx si `NOC_INFLUX_URL` sigue seteado, o sin baseline). **Cero downtime del loop `olt_watch`.** |
| El esquema quedó mal | `DROP SCHEMA` en la base nueva y arrancar de cero otra vez. No hay dato de terceros ahí. |
| El binario nuevo revienta | `systemctl stop noc-collector`. El sistema vuelve exactamente al estado previo: los scripts Python y Grafana nunca se apagaron. |

No hay migración de datos que revertir, no hay tabla compartida que restaurar, no hay consumidor
externo del store.

## Bloqueantes

1. 🔴 **Crear el servicio Postgres en EasyPanel del `.37`** — requiere token de API o login de UI.
   El asistente tiene SSH+root al `.37` pero **no** acceso a EasyPanel. Acción del usuario.
   Necesario: DB `noc_fiber`, rol dedicado con `CREATE`/`DML` sobre su schema, y **alcanzable por
   red desde `10.75.0.40`** (VM 130).
2. 🟡 **Deploy a la VM 130** sigue siendo manual (`.github/workflows/deploy.yml` job `deploy` es
   un stub no-op; la key `ipnext_flows` se perdió). No es nuevo de este change, pero lo hereda.

## Decisiones abiertas (requieren confirmación del usuario)

Ver el detalle con tradeoffs en `design.md` §Decisiones abiertas. Resumen:

| # | Decisión | Recomendación |
|---|---|---|
| D1 | ¿Modo dual (leer baseline de Influx mientras Postgres madura) o Postgres puro desde el día 1? | **Postgres puro**, con el código de `dual` disponible como escape hatch sin default. |
| D2 | Retención | **24 meses de detalle crudo**, poda diaria desde el propio colector. Sin rollups, sin particiones. |
| D3 | Crate de acceso a Postgres | **`sqlx`** (trae el runner de migraciones, que es justo lo que falta). |
