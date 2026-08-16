# Design: NOC Alerts — Reconciliación por Nivel (olt_watch)

## Technical Approach

Un ciclo = **observar → reconciliar → anunciar**. Nada se recuerda entre ciclos
que no sea recomputable a partir de observaciones.

```
SmartOLT ─┐
          ├─▶ observe()  ──▶ desired: Map<Fp, Firing|Clear>   (ausente = Unknown)
store PG ─┘                        │
                                   ▼
GET /api/alerts/ingest/            reconcile(desired, announced)
    fiber-collector/state ──▶ announced: Set<Fp firing>  (SOLO prefijo propio)
                                   │
                                   ▼
                            actions: [Fire(fp) | Resolve(fp)]
                                   │  rate-limiter del ANUNCIO
                                   ▼
                    POST /api/alerts/ingest/fiber-collector   (uno por acción)
```

**Invariante rector**: el estado ANUNCIADO **nunca** se deriva de lo último
visto, ni se guarda localmente — se **lee del hub en cada ciclo**. Un anuncio
suprimido o fallido deja `announced` intacto ⇒ el delta **sobrevive** y se
re-emite el ciclo siguiente. **Nada se pierde jamás.**

## Modelo de datos

```rust
enum Observation { Firing(Severity), Clear }   // ausente del mapa = Unknown

struct Snapshot {                  // lo que devolvió SmartOLT ESTE ciclo
    olt: OltId,
    uptime_s: Option<i64>,
    onus: Vec<ObservedOnu>,        // sn, pon, condition, signal
}
enum Condition { Online, Los, PowerFail, NotReported }
enum SignalLevel { Ok, Warning, Critical, Unmeasurable }

struct ObserveMemory {             // SOLO observación, todo self-healing
    last_online_at: HashMap<Sn, i64>,      // freshness
    pending_since:  HashMap<Fp, i64>,      // histéresis `for:`
    api_miss:       HashMap<OltId, u32>,
    skipped_cycles: HashMap<OltId, u32>,
    last_announced_at: HashMap<Fp, i64>,   // rate-limiter (soft)
}
```

### Catálogo de condiciones (fingerprints estables, SIN timestamp)

| Fingerprint | Predicado de NIVEL | Sev | Tier |
|---|---|---|---|
| `olt-level/olt-unreachable/{olt}` | uptime ausente ≥2 ciclos consecutivos | critical | 4 |
| `olt-level/olt-recent-restart/{olt}` | `uptime_s < RESTART_WINDOW` (900s) | critical | 4 |
| `olt-level/olt-mass-los/{olt}` | LOS-fresh ≥ `OLT_MASS_MIN` (3) en ≥2 PONs | critical | 3 |
| `olt-level/olt-power-outage/{olt}` | PowerFail-fresh ≥ `PWR_ZONAL_MIN` (5) | warning | 3 |
| `olt-level/pon-outage/{olt}/{pon}` | LOS-fresh en el PON ≥ `PON_MIN` (2) | critical | 2 |
| `olt-level/onu-los/{sn}` | LOS-fresh no suprimida | warning | 1 |
| `olt-level/onu-signal-critical/{sn}` | `signal == Critical` | warning | 1 |
| `olt-level/collector-stale/{olt}` | ≥ `STALE_CYCLES` (3) ciclos salteados | warning | meta |

`olt-recent-restart` es **stateless a propósito**: derivarlo de `uptime_s <
ventana` en vez de "el uptime retrocedió vs. el ciclo anterior" lo vuelve
idempotente, auto-resolutivo y sobreviviente a reinicios del colector.

## Architecture Decisions

### Decision 1 — Estado ANUNCIADO: preguntárselo al hub (opción **a**)

**Choice**: `GET /api/alerts/ingest/:source/state` en el BE, auth con la ingest
key de esa misma fuente. El colector **no persiste** estado anunciado.

| Opción | Costo | Riesgo | Veredicto |
|---|---|---|---|
| (a) Preguntar al hub | 1 ruta aditiva en el BE (`ListAlerts` ya filtra `source`+`status`) | ninguno: el hub YA es la fuente de verdad | **ELEGIDA** |
| (b) Store PG propio | **migración DDL nueva** ⇒ paso manual con superusuario (`noc_collector` no tiene CREATE, `NOC_PG_RUN_MIGRATIONS=false` — ver `migrations/0002_role_and_grants.sql`) | es un **espejo**: POST OK + crash antes del commit local ⇒ huérfano permanente (el bug que venimos a matar) | rechazada |
| (c) Híbrido | (a)+(b) | dos verdades que pueden divergir | rechazada |

**Rationale**: el costo de (a) es BAJO y hay **precedente probado en el mismo
router**: `createThresholdsReadAuth` ya hace dual-auth (ingest key de máquina ∨
sesión+`monitoring.manage`) sobre `GET /thresholds`. Reusamos el molde y la
MISMA `fiberIngestKey` (rotar una key no olvida la otra). Endpoint **dedicado y
scopeado por fuente** en vez de abrir `GET /` con key de máquina: mínimo
privilegio (fiber solo ve lo suyo) y fuente desconocida → 404 antes de comparar
key alguna. Respuesta **array plano, sin envelope `{data}`** — mismo criterio que
`/thresholds`, y evita el mismatch de shape que ya nos mordió.

**Cadencia**: se pide **en cada ciclo** (288 GETs/día, payload chico). Auto-sana
cualquier deriva. Si el GET falla ⇒ **se saltea la reconciliación** (nunca
reconciliar contra un anunciado vacío: eso sería un re-anuncio masivo).

### Decision 2 — Ownership por prefijo (protege el ciclo señal/PON)

El reconciliador **solo considera** fingerprints con prefijo `olt-level/`.
Todo lo demás del set anunciado (`onu-signal-degraded-*`, `pon-suspect-*`, y los
`olt-watch-*` legacy) es **invisible** para él: nunca los resuelve, nunca los
toca. Sin este filtro, la primera reconciliación cerraría las alertas del ciclo
señal/PON — catastrófico.

### Decision 3 — Tri-estado `Firing | Clear | Unknown`

| Observación | Acción del reconciliador |
|---|---|
| `Firing` y no anunciado | → POST `firing` |
| `Firing` anunciado con severidad distinta | → POST `firing` (upsert; el hub **preserva el ACK** salvo resurrección) |
| `Clear` y anunciado | → POST `resolved` |
| **Unknown** (ausente del mapa) | **nada** — se arrastra el estado anunciado |

`Unknown` es la pieza estructural que resuelve C1, C5 y el reinicio **con un solo
mecanismo**. Un mapa `desired` vacío no resuelve nada: no puede haber un
"resolve masivo por snapshot vacío".

### Decision 4 — Señal no medible = **sin dato**, no un nivel

`Offline` / `Power fail` / `N/A` ⇒ `SignalLevel::Unmeasurable` ⇒ la condición
`onu-signal-critical/{sn}` se emite como **Unknown**, jamás como `Clear`. Una ONU
con señal crítica que se apaga NO resuelve su alerta de señal (seguiría siendo
mentira que la señal mejoró); además dispara en paralelo su condición de
LOS/PowerFail. Este es exactamente el hallazgo **C5**, cerrado por construcción.

### Decision 5 — Freshness: el nivel crudo no alcanza

Una red tiene población **crónica** en LOS (clientes de baja, ONUs retiradas):
"LOS es un nivel" a secas dispararía cientos de alertas. Nivel real:

> `LOS-fresh(sn)` ⟺ `condition == Los` **∧** `now - last_online_at[sn] ≤ LOS_FRESH_WINDOW` (24h)

**Regla de freshness desconocida** (arranque en frío): una ONU en LOS sin
`last_online_at` NO abre condición nueva, pero **si ya estaba anunciada, se
arrastra** (Unknown). Consecuencia: día uno sin inundación, y las alertas
abiertas antes del reinicio sobreviven. Análogo para PowerFail
(`PWR_FRESH_WINDOW` 6h).

### Decision 6 — Jerarquía con supresión por contención (mata C3)

Precedencia **top-down**; cada ONU contribuye a **exactamente un** tier:

```
Tier 3: olt-mass-los ──suprime──▶ Tier 2 (todos los PON de esa OLT)
Tier 2: pon-outage   ──suprime──▶ Tier 1 (las ONUs de ese PON)
Tier 1: onu-los
```

Lo suprimido se emite como **`Clear`** (no `Unknown`): así una individual que
escala a ramal **se cierra visiblemente** y no queda duplicada junto a la
agrupada. La agrupada lleva los `sn` afectados (y el nombre del cliente) en el
mensaje — no se pierde información. Al reparar parcialmente un ramal el conteo
baja de 2 ⇒ el `pon-outage` resuelve y reabren las individuales restantes:
**computado, no recordado**.

Criterio heredado del Python (≥3 nuevas en un ciclo o ≥2 en el mismo PON =
ramal) traducido a nivel: `PON_MIN=2` sobre el conteo **actual fresh** del PON, y
`OLT_MASS_MIN=3` **con ≥2 PONs distintos** (si fuera un solo PON ya es
`pon-outage`, no hay solape).

### Decision 7 — Anti-flapping en la OBSERVACIÓN + rate-limit del ANUNCIO

Dos capas, ninguna pierde estado:

1. **Histéresis `for:`** (estilo Prometheus): una condición entra en `desired`
   recién tras `FIRE_FOR` ciclos consecutivos cumpliéndose, y sale tras
   `CLEAR_FOR` ciclos consecutivos sin cumplirse. Asimétrica (resolver más lento
   que disparar). LOS: 2/2. Señal crítica: 3/6 (30 min de "pegajosidad" — mata la
   ONU parada en el umbral Warning/Critical). Es memoria de **observación**:
   recomputable, y perderla en un reinicio cuesta a lo sumo 2-3 ciclos.
2. **Rate-limiter del anuncio**: intervalo mínimo por fingerprint
   (`ANNOUNCE_MIN_INTERVAL`, 30 min) + techo global por ciclo
   (`MAX_ANNOUNCES_PER_CYCLE`, 50, ordenado por severidad descendente).

**La regla que cierra C4-bis**: el limiter **no muta nada**. Si suprime o si el
POST falla, `announced` no se actualiza (de hecho ni existe local: se relee del
hub) ⇒ el mismo delta se recalcula y se reintenta el ciclo siguiente. Una
escalada suprimida **se anuncia con retraso, nunca se pierde**.

### Decision 8 — Guarda de sanidad con escape hatch (mata C1/HIGH#1)

Un snapshot es **no confiable** si: (a) el envelope de SmartOLT vino
`status:false` o hubo error de transporte (ya devuelve `Err`, mergeado a main);
(b) HTTP 429/5xx; (c) **cobertura**: `filas_devueltas < COVERAGE_FLOOR (0.5) ×
filas_esperadas`, donde *esperadas* = `COUNT(*) FROM onu_signal_current WHERE olt
= $1` — el **store propio**, NO el ciclo anterior (el ciclo anterior es la trampa
perpetua) — y se cuenta **filas devueltas de cualquier estado**, NO filtradas por
condición (un apagón zonal devuelve las 2797 filas en `Power fail`: cobertura
100%, la guarda **no** se dispara — el falso positivo del parche #4).

Snapshot no confiable ⇒ `desired = {}` para esa OLT ⇒ **todo Unknown** ⇒ ni fire
ni resolve, cero mutación de estado. **No puede trabarse**: el ciclo siguiente
evalúa datos frescos, sin latch. Escape hatch: tras `STALE_CYCLES` (3)
consecutivos, se anuncia `olt-level/collector-stale/{olt}` — la OLT nunca queda
ciega **en silencio**.

## Data Flow (secuencia de un ciclo)

```
loop olt_watch (5 min)          hub (BE)              SmartOLT        store PG
      │                            │                     │               │
      ├─ GET /ingest/fiber-collector/state ──────────────▶│               │
      │◀─ [ {fingerprint, severity}, ... ] ───────────────┤               │
      │   (filtra prefijo olt-level/ → announced)         │               │
      ├─ get_olts_uptime_and_env_temperature ────────────▶│               │
      ├─ get_onus_statuses(olt) ─────────────────────────▶│               │
      ├─ get_onus_signals(olt) ──────────────────────────▶│               │
      ├─ COUNT(*) onu_signal_current WHERE olt ──────────────────────────▶│
      │   sanity(snapshot) ─── no confiable ──▶ desired={} (todo Unknown)
      │   observe(snapshot, memory) → freshness → tiers → histéresis
      │                              → desired: Map<Fp, Firing|Clear>
      │   reconcile(desired, announced) → actions
      │   rate_limit(actions) → to_post   (lo suprimido NO se pierde)
      ├─ POST /ingest/fiber-collector  (× |to_post|) ─────▶│
      └─ (sin POST OK → sin cambio; el próximo ciclo recalcula el MISMO delta)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `ipnext-noc-collector/src/sensors/olt_watch.rs` | Rewrite | `observe()` + `reconcile()` puros; se van `WatchState`, `evaluate_*_transitions`, `Cooldowns`, `Event` |
| `ipnext-noc-collector/src/sensors/olt_level.rs` | Create (opcional) | Catálogo de condiciones + jerarquía de supresión, si `olt_watch.rs` queda >600 líneas |
| `ipnext-noc-collector/src/main.rs` | Modify | `olt_watch_cycle` reescrito; `olt_event_alert` → `condition_alert` (fingerprints `olt-level/`, sin `now`); flag `NOC_OLT_WATCH_MODE` |
| `ipnext-noc-collector/src/hub_client.rs` | Modify | `fetch_announced_state()` (GET, bearer, array plano) |
| `ipnext-noc-collector/src/pg_client.rs` | Modify | `count_onus_by_olt()` (SELECT, sin DDL) |
| `ipnext-noc-collector/src/config.rs` | Modify | Env nuevas (ventanas, umbrales, límites) con defaults |
| `ipnext-backend/.../routes/alerts.routes.ts` | Modify | `GET /ingest/:source/state` + reuso de `createApiKeyMiddleware(ingestKeys[source])` |
| `ipnext-backend/.../use-cases/alerts/ListAlerts.ts` | Reuse | Ya filtra `source`+`status`; sin cambios de firma |
| `ipnext-backend/.../dto/nocAlert.ts` | Modify | `toNocAlertStateDto` (proyección mínima) |

**Sin migraciones**: ni Prisma ni `noc-fiber-db`.

## Interfaces / Contracts

```http
GET /api/alerts/ingest/fiber-collector/state
Authorization: Bearer <fiberIngestKey>
200 OK   (array PLANO, sin envelope {data})
[ { "fingerprint": "olt-level/onu-los/GPON00B904C1",
    "severity": "warning", "startsAt": "2026-07-27T10:00:00Z",
    "acknowledged": false } ]
401  key ausente/inválida       404  fuente desconocida
```

```rust
pub fn observe(snap: &Snapshot, mem: &mut ObserveMemory, cfg: &LevelConfig, now: i64)
    -> HashMap<Fingerprint, Observation>;                       // puro salvo `mem`

pub fn reconcile(desired: &HashMap<Fingerprint, Observation>,
                 announced: &HashMap<Fingerprint, Severity>)
    -> Vec<Action>;                                             // 100% puro
pub enum Action { Fire { fp, severity }, Resolve { fp } }
```

## Testing Strategy

| Layer | Qué se testea | Cómo |
|---|---|---|
| Unit (Rust) | `reconcile` (tabla de verdad ×3 estados), jerarquía de supresión, freshness, histéresis, sanidad/cobertura, rate-limiter que NO muta | funciones puras, sin IO — molde de los 207 tests actuales |
| **Regresión de los 4 CRITICAL** | escalada suprimida que reaparece; snapshot vacío que no resuelve nada; oscilación acotada; guarda que se destraba sola; apagón zonal que NO dispara la guarda | escenarios dedicados en `spec.md`, uno por CRITICAL |
| Integration (Rust) | `fetch_announced_state` (URL/headers/parseo de array plano), `count_onus_by_olt` contra PG efímero | molde `mod integration_tests` de `pg_client.rs` |
| Integration (BE) | `GET /ingest/:source/state`: 200 con key, 401 sin key, 401 con key de OTRA fuente, 404 fuente desconocida, filtro `firing`, shape plano | Jest + supertest con `InMemoryNocAlertRepository` |
| E2E | un ciclo real contra el hub de staging antes del cutover | manual, gateado por `NOC_OLT_WATCH_MODE` |

## Migration / Rollout

1. **BE primero** (aditivo, sin migración): deploy del endpoint. El colector
   viejo no lo usa — riesgo cero.
2. **Colector** con `NOC_OLT_WATCH_MODE=legacy` (default): binario nuevo, camino
   viejo activo. Verificar que el GET responde y el modo nuevo **loguea el delta
   sin postear** (`dry-run`, un ciclo shadow).
3. **Cutover**: `NOC_OLT_WATCH_MODE=reconcile` + restart.
4. **Limpieza de las ~400 legacy** (§6, paso operativo, **una vez**, después del
   cutover — nunca automático al arranque: el reconciliador no es dueño de esos
   fingerprints y un sweeper al arranque correría en cada restart):
   ```sql
   UPDATE "NocAlert" SET status='resolved', "endsAt"=now(), "updatedAt"=now()
   WHERE source='fiber-collector' AND status='firing'
     AND fingerprint LIKE 'olt-watch-%';   -- NO toca onu-signal-degraded-* ni pon-suspect-*
   ```
   El prefijo legacy (`olt-watch-`, guion) y el nuevo (`olt-level/`, barra) son
   **disjuntos** — por eso el namespace nuevo no reusa la palabra `olt-watch`.
5. **Rollback**: flip de la env var + restart (binario `.bak-*` en la VM 130 como
   red de seguridad).

## Open Questions

- [ ] **P1 — ¿Se aprueba tocar el BE?** (Decision 1). Es 1 ruta aditiva sin
      migración, con molde existente. La alternativa (store propio) exige DDL con
      superusuario y reintroduce el espejo que puede divergir.
- [ ] **P2 — ¿Se elimina `SignalWarning` de `olt_watch`?** Propuesto: sí, dejar
      solo `Critical` como nivel. `Warning` duplica —peor— lo que ya hace bien
      `onu-signal-degraded-{sn}` (baseline + delta), e inundaría el panel. Efecto
      colateral positivo: la escalada Warning→Critical se vuelve "abre el
      fingerprint de Critical", sin mutar severidad.
- [ ] **P3 — Valores por defecto** de `LOS_FRESH_WINDOW` (24h),
      `PWR_FRESH_WINDOW` (6h), `RESTART_WINDOW` (15min), `COVERAGE_FLOOR` (0.5):
      propuestos por analogía con los cooldowns del Python. ¿Se confirman o se
      calibran contra un ciclo shadow real?
- [ ] **P4 — ¿La limpieza de las 400 legacy va antes o después del cutover?**
      Propuesto: después (así se ve el set nuevo abrirse limpio contra un panel
      con historia, y si hay rollback lo viejo sigue coherente).
