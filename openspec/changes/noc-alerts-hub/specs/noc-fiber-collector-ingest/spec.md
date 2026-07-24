# Noc Fiber Collector Ingest Specification

## Purpose

Contrato que el colector Rust (repo `ipnext-noc-collector`, aparte, Fase E) DEBE
cumplir al postear al hub. El colector es SOLO sensores (señal ONU, análisis PON,
`olt_watch`, OCR de la seed) — el ciclo de vida/ACK/escalado lo ABSORBE el hub
(`noc_metrics.py` se jubila, no se reescribe en Rust). El colector postea el shape
canónico **directo** a `POST /api/alerts/ingest` (el mismo endpoint genérico de
`noc-alert-hub`, Fase A — NO un sub-endpoint de mapeo como Grafana, porque el colector
ya habla el shape canónico) con `source: "fiber-collector"`, autenticado con
`fiberIngestKey` (mismo molde `apiKeyMiddleware` por fuente, ya cubierto
genéricamente en `noc-alert-hub` §Alert ingestion endpoint auth — este spec NO
reespecifica los escenarios de 401 sin/con key inválida). El código del colector Rust
en sí (repo aparte, VM 130, deploy con la key SSH `ipnext_flows`) está fuera del
alcance de este spec — acá se especifica solo lo que el HUB debe aceptar y cómo debe
comportarse ante ese tráfico.

## Requirements

### Requirement: PON suspect alert ingestion
El sistema DEBE (MUST) aceptar y persistir como `NocAlert` `firing` un payload
canónico con `entity.type: "pon"` posteado por el colector cuando detecta que
≥`PON_MIN_ABON` ONUs de la misma `(olt, pon)` cayeron ≥`PON_DELTA` dB vs su mediana
histórica (umbral leído del hub, ver `noc-alert-thresholds`).

#### Scenario: A suspicious PON alert creates a firing NocAlert
- GIVEN el colector detecta ≥`PON_MIN_ABON` ONUs con Δ≤`-PON_DELTA` dB en la misma `(olt, pon)`
- WHEN postea `POST /api/alerts/ingest` con `source: "fiber-collector"`, `entity: { type: "pon", name: "OLT-3/PON-5" }`, `status: "firing"`, autenticado con `fiberIngestKey`
- THEN se crea un `NocAlert` `source: "fiber-collector"`, `status: "firing"`, `entityType: "pon"`, `entityName: "OLT-3/PON-5"`

### Requirement: Individual ONU degradation alert ingestion
El sistema DEBE (MUST) aceptar y persistir como `NocAlert` `firing` un payload con
`entity.type: "onu"` cuando el colector detecta una ONU individual degradada (sin que
el resto de la PON esté afectada — drop individual, no troncal/splitter).

#### Scenario: A degraded single ONU alert creates a firing NocAlert
- GIVEN el colector detecta una sola ONU con señal por debajo de umbral, sin que otras ONUs de la misma PON estén afectadas
- WHEN postea `POST /api/alerts/ingest` con `source: "fiber-collector"`, `entity: { type: "onu", name: "ONU-abc" }`, `status: "firing"`
- THEN se crea un `NocAlert` `source: "fiber-collector"`, `status: "firing"`, `entityType: "onu"`, `entityName: "ONU-abc"`

### Requirement: Recovery ingestion resolves the matching alert
El sistema DEBE (MUST) cerrar la fila `NocAlert` `firing` correspondiente cuando el
colector reporta la recuperación de la condición (ej. una ONU vuelve de LOS a online),
reusando el comportamiento genérico de `resolved` ya cubierto por `noc-alert-hub` —
este spec solo agrega el fixture específico de fibra, no reespecifica la mecánica de
cierre.

#### Scenario: LOS-to-online recovery resolves the matching NocAlert
- GIVEN existe un `NocAlert` `firing` con `source: "fiber-collector"` y un `fingerprint` dado (ej. una ONU en LOS)
- WHEN el colector postea `POST /api/alerts/ingest` con el mismo `(source, fingerprint)` y `status: "resolved"` (la ONU volvió a estar online)
- THEN el `NocAlert` correspondiente pasa a `status: "resolved"` con `endsAt` seteado (mismo mecanismo que `noc-alert-hub` §NocAlert entity and lifecycle)

### Requirement: Collector reads thresholds from the hub
El sistema DEBE (MUST) exponer los umbrales de fibra (`CRIT_DBM`, `WARN_DBM`,
`DELTA_ALERT`, `PON_MIN_ABON`, `PON_DELTA`) por `GET /api/alerts/thresholds` para que
el colector los lea — el hub es la fuente de verdad de estos valores. La forma
completa del endpoint (auth dual humano/máquina, `PUT` de edición, defaults) se
especifica en `noc-alert-thresholds`; este escenario documenta únicamente el contrato
desde la perspectiva del colector como consumidor.

#### Scenario: Collector fetches current fiber thresholds
- GIVEN el hub tiene umbrales de fibra configurados (defaults o editados desde el panel)
- WHEN el colector hace `GET /api/alerts/thresholds` autenticado con `fiberIngestKey`
- THEN recibe `CRIT_DBM`, `WARN_DBM`, `DELTA_ALERT`, `PON_MIN_ABON`, `PON_DELTA` con los valores vigentes del hub

## Testing Notes

Estos escenarios se testean del lado HUB únicamente (supertest sobre
`POST /api/alerts/ingest` y `GET /api/alerts/thresholds` con fixtures que imitan lo
que el colector Rust postearía) — NO hay tests de este spec que corran código Rust; el
repo `ipnext-noc-collector` tiene su propia suite, fuera de este change. Reusar
`IngestAlert`/`InMemoryNocAlertRepository` reales (Fase A), sin mockear Prisma. Los
escenarios de auth (401 sin/con key inválida) NO se reespecifican acá — ya están
cubiertos genéricamente en `noc-alert-hub` §Alert ingestion endpoint auth con
`fiberIngestKey` como una de las fuentes parametrizadas.
