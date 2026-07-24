# Design: NOC Alerts Hub

> Base: `proposal.md` (Fases A–F cerradas) + `exploration.md` + decisiones de engram
> (`noc-alerts-hub/{architecture,scope-decisions,collector-scope,telegram-ack-bidireccional}`).
> Este design NO reabre decisiones — las aterriza. Citas `archivo:línea` = worktree BE actual.
> Nota de tamaño: excede el budget de 800w a propósito — el entregable pedido cubre 6 fases +
> contrato Rust + SSE + Telegram bidireccional. Densidad por tablas.

## Technical Approach

El HUB es un **módulo hexagonal nuevo** en el BE (`alerts/`), aditivo, que recibe cada alerta UNA vez
(`POST /api/alerts/ingest`), persiste el ciclo de vida `firing→resolved` deduplicado por
`(source, fingerprint)`, y hace **fan-out** a (a) panel FE vía **SSE** sobre un event-bus in-memory y
(b) **Telegram** con botón inline, con **ACK bidireccional** sincronizado en el hub. Dirección de
dependencias intacta: `infra → application → domain`; el dominio no conoce Express/Prisma/Telegram.

**Restricción dura de convivencia** (lo más importante): durante toda la construcción y hasta el
cutover explícito, los scripts Python de la VM 130 (`noc_metrics.py`, `fibra_report.py`, `olt_watch.py`,
`onu_signal_poll.py`) siguen corriendo INTACTOS y Grafana sigue mandando a Telegram por su path actual.
El hub se **dark-launchea**: persiste + sirve el panel, pero su **envío saliente a Telegram queda OFF por
feature-flag**. El colector Rust puede **dark-emitir** al hub sin efecto visible. El cutover es un evento
posterior (flip de flags + baja del path viejo), con OK del usuario.

## Architecture Decisions

### Decision: Entidad `NocAlert` nueva (no reusar `MonitoringAlert`)

| Opción | Tradeoff | Decisión |
|---|---|---|
| Extender `MonitoringAlert` | Reusa router/RBAC/FE, pero `type` es enum cerrado device-céntrico y `deviceId` FK asume "device" — incompatible con BGP/DDoS/rectificador/ONU/PON; migración ≈ igual de cara que tabla nueva | ❌ |
| **`NocAlert` nueva, tabla propia** | +1 tabla alert-like, requiere documentar coexistencia | ✅ **elegida** |

`MonitoringAlert`/`MonitoringDevice`/`Notification` quedan dormidos e intactos. **Por qué NO es
duplicación**: `Notification` = bandeja de campana genérica (title/read); `MonitoringAlert` = scaffold
device-céntrico vacío y **roto** (`resolvedAt` hardcodeado a `null`, columna inexistente —
`PrismaMonitoringRepository.ts:57`; 0 `.create()` reales). `NocAlert` = telemetría operacional
polimórfica con `fingerprint`/ciclo de vida, que ninguna de las otras dos modela. Se documenta en un
comentario del schema. `IngestAlert` PUEDE, best-effort, escribir también una fila `Notification` para la
campana del FE (integración limpia, no duplicación) — opcional, Fase C+.

### Decision: `POST /api/alerts/ingest/{source}` — un path por fuente, key por fuente

**ACTUALIZADO (fix wave F3, revisión adversarial Fase A)**: la ruta NO es `/ingest` con `source` leído
del BODY — eso permitía spoofing (con la key de `fiber-collector` se podía postear `source:"grafana"` y
colarse). El contrato real (spec.md "Alert ingestion endpoint auth") es `POST /api/alerts/ingest/{source}`:
el `:source` del PATH es la ÚNICA fuente de verdad — resuelve qué key lo guarda (map `ingestKeys` en
`AlertsRouterDeps`, `fiber-collector`→`fiberIngestKey`, `grafana`→`grafanaIngestKey`) y termina siendo el
`source` persistido en el `NocAlert` (un `source` distinto en el body se ignora). Un `:source` fuera del
map → `404` ANTES de comparar ninguna key. El contrato de dominio sigue siendo **único y canónico**
(compartido BE↔Rust): el colector Rust postea el shape canónico directo a `/api/alerts/ingest/fiber-collector`
(⚠ **antes apuntaba a `/ingest` a secas** — el `hub_client` de `ipnext-noc-collector` necesita actualizarse,
lo sincroniza el orquestador). Grafana tiene un shape de webhook **fijado por Grafana** que no controlamos
→ `POST /api/alerts/ingest/grafana` lo recibe; `GrafanaWebhookSource` (adapter, Fase B) lo **mapeará al
canónico server-side** delegando al **mismo** `IngestAlert` — hasta que esa Fase B aterrice, `/ingest/grafana`
acepta el mismo shape canónico que `/ingest/fiber-collector` (la ruta no sabe de Grafana todavía). Ambas
rutas quedan detrás de `apiKeyMiddleware` con key por fuente para rotar una sin tocar la otra.

### Decision: Real-time por SSE + event-bus in-memory (scale-out VERIFICADO seguro)

| Riesgo | Resolución |
|---|---|
| Event-bus in-memory se rompe con >1 réplica | **VERIFICADO single-instance**: `deploy.yml` corre UN `docker run -d --name ipnext-new-backend` (sin `replicas`, borra el viejo y levanta uno). El bus in-memory es correcto HOY. Se documenta el invariante: si algún día se agregan réplicas, migrar a Redis pub/sub o pg `LISTEN/NOTIFY`. NO se sobre-ingeniería ahora. |
| Buffering del proxy EasyPanel | Headers `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` + `Connection: keep-alive`, `res.flushHeaders()` inmediato, heartbeat `: ping\n\n` cada 15s. Plan B ya incluido: fallback a polling (`refetchInterval` gateado por `useDocumentVisible()`, molde `useWhatsapp.ts:78-85`). Spike de 30min en vivo temprano en Fase C. |
| Reconexión | FE hace **refetch completo al (re)conectar** el `EventSource` (reconcilia estado) y luego consume deltas; `Last-Event-ID` + ring-buffer de replay = opcional (over-engineering para el volumen actual). |

Mecanismo hexagonal: port `AlertEventPublisher` (domain) publicado por los use-cases **después** de
persistir OK; `AlertEventBus` (infra, wrapper sobre `EventEmitter`) lo implementa; la ruta SSE se suscribe
al bus, NUNCA al use-case. SSE auth = **cookie de sesión** (`createAuthMiddleware`), NO apiKey (el
`EventSource` del browser no manda headers custom pero sí cookies con `withCredentials`).

### Decision: Flags de convivencia = filas `FeatureFlag` DB-backed (molde chatwoot-hub-sendpath)

El patrón dark-launch del repo NO usa env vars: usa la tabla `FeatureFlag` (`FeatureFlagRepository.get(key)?.enabled`),
seed OFF via migración idempotente (`INSERT ... ON CONFLICT DO NOTHING`), toggle runtime desde la UI sin
deploy (kill-switch). Se replica exacto.

| Flag (FeatureFlag key) | Gobierna | Estado en convivencia |
|---|---|---|
| `noc-alerts-hub-enabled` | Ingesta + persistencia + panel + SSE | **ON** (dark: recibe y muestra, sin notificar afuera) |
| `noc-alerts-telegram-send` | Envío SALIENTE de Telegram del hub | **OFF** (noc_metrics.py + Grafana→Telegram siguen siendo los únicos que notifican) |

Grafana→Telegram y los systemd de la VM 130 son infra fuera del repo — el hub NO los toca, NO los para.
**Cutover** (evento explícito, OK del usuario): flip `noc-alerts-telegram-send` **ON** + baja manual del
Grafana→Telegram contact-point + stop de `noc_metrics.py`/sensores Python. Sin ese flip no hay
doble-notificación posible (el hub calla). Rust dark-emite mientras el hub esté oscuro: persiste, no
notifica.

### Decision: ACK local al hub, bidireccional panel↔Telegram

ACK vive SOLO en el hub (`ackBy`/`ackAt`/`ackNote`); Grafana no se entera (sigue firing de su lado).
El hub es fuente de verdad del estado operativo. `AcknowledgeAlert` (desde panel o desde callback de
Telegram) escribe UN estado, publica al bus (→SSE) y **edita el mensaje de Telegram** ("tomado por X")
si la fila tiene `telegramChatId`/`telegramMessageId`. MTTA = `ackAt − startsAt`, computado en el DTO.

### Decision: Colector Rust = SOLO sensores; el ciclo de vida/ACK/escalado lo ABSORBE el hub

`noc_metrics.py` (ciclo de vida/ACK/escalado Telegram) hace lo MISMO que el hub → NO se reescribe en Rust
(sería duplicar y tirar). Rust = poll/parse/POST. `noc_metrics.py` se jubila en el cutover.

## Data Flow

```
  Grafana(.37) ─POST /ingest/grafana─────────┐
                                              ├─→ [GrafanaWebhookSource → NocAlertInput]
  Colector Rust ─POST /ingest/fiber-collector─┘        │ (canónico directo)
   (VM130 sensores)                                    ▼
                                        IngestAlert (upsert por source+fingerprint)
                                          │ persist          │ publish
                                          ▼                  ▼
                                    NocAlertRepo        AlertEventPublisher(port)
                                                             │
                          ┌──────────────────────────────────┼─────────────────┐
                          ▼ (flag telegram-send)              ▼ AlertEventBus    │
                   TelegramBotGateway ──botón inline──→ Telegram   │             │
                          ▲   callback ack:<id>                    ▼ SSE         │
                          │   POST /alerts/telegram/webhook   GET /alerts/stream │
                          └───────── AcknowledgeAlert ←── panel FE (cookie auth)─┘
```

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | +`NocAlert` (A), +`NocAlertThresholdsConfig` singleton (F). Comentario de coexistencia. NO toca `MonitoringAlert`/`Notification`. |
| `prisma/migrations/*_noc_alert/` | Create | Tabla `NocAlert` + seed `FeatureFlag` (`noc-alerts-hub-enabled` ON, `noc-alerts-telegram-send` OFF). Aditiva. |
| `src/domain/entities/nocAlert.ts` | Create | Entidad `NocAlert` + `NocAlertInput` + tipos. |
| `src/domain/ports/NocAlertRepository.ts` | Create | `upsertByFingerprint`, `findById`, `list(filters)`, `acknowledge`. |
| `src/domain/ports/AlertSource.ts` | Create | `map(raw): NocAlertInput`. |
| `src/domain/ports/AlertEventPublisher.ts` | Create | `publish(event)`. |
| `src/domain/ports/AlertNotifier.ts` | Create | `notify(alert)` / `editAck(alert)` (Telegram, Fase D). |
| `src/domain/ports/NocAlertThresholdsConfigRepository.ts` | Create | singleton get/update (Fase F). |
| `src/application/use-cases/alerts/{IngestAlert,AcknowledgeAlert,ListAlerts,GetAlert}.ts` | Create | Casos de uso (verbo+sustantivo). |
| `src/application/use-cases/alerts/{GetAlertThresholds,UpdateAlertThresholds}.ts` | Create | Fase F. |
| `src/application/dto/nocAlert.ts` | Create | `NocAlertDto` (+ MTTA computada; oculta `fingerprint` crudo si hace falta). |
| `src/infrastructure/adapters/prisma/PrismaNocAlertRepository.ts` | Create | Naming `Prisma{Entity}Repository`. Mapea row→entidad (nunca Prisma crudo). |
| `src/infrastructure/adapters/in-memory/InMemoryNocAlertRepository.ts` | Create | Para tests de use-case (NO mockear Prisma). |
| `src/infrastructure/adapters/grafana/GrafanaWebhookSource.ts` | Create | Mapper webhook Grafana→canónico (Fase B). |
| `src/infrastructure/adapters/telegram/TelegramBotGateway.ts` | Create | Envío saliente (botón inline) + edit msg (Fase D). |
| `src/infrastructure/events/AlertEventBus.ts` | Create | `EventEmitter` wrapper (impl de `AlertEventPublisher`). |
| `src/infrastructure/http/routes/alerts.routes.ts` | Create | `/ingest/{source}` (F3 — path-based, no `/ingest` a secas), `/stream` (SSE), `GET /`, `POST /:id/acknowledge`, `/telegram/webhook`, `/thresholds`. |
| `src/infrastructure/http/middleware/apiKeyMiddleware.ts` | Modify | Parametrizar key por fuente (factory que recibe la key configurada). |
| `src/infrastructure/http/app.ts` | Modify | **⚠ God Object (617 líneas, known_debt)**: montar `/api/alerts`. Extraer `composeAlertsModule()` para NO inflar el God Object. |
| `src/infrastructure/config.ts` | Modify | fail-fast de `grafanaIngestKey`/`fiberIngestKey`/`telegramBotToken`/`telegramWebhookSecret`. |
| `.github/workflows/deploy.yml` | Modify | +`-e` de los secrets nuevos. |
| `ipnext-frontend/src/pages/alerts/AlertsPage.tsx` + `hooks/useAlerts.ts` | Create | Panel filtros(fuente/severidad/estado)+ACK; hook SSE+fallback polling (`<Can permission="monitoring.*">`). |
| Repo `ipnext-noc-collector` (Rust, aparte) | Create | Sensores → POST canónico al hub. |

## Interfaces / Contracts

### Contrato de ingesta canónico (compartido BE↔Rust — campo por campo, para no driftear)

```jsonc
{
  "source":      "grafana | fiber-collector",   // requerido; parte de la dedup key
  "fingerprint": "string",                        // requerido; estable por condición distinta
  "status":      "firing | resolved",             // requerido
  "alertname":   "string",                        // requerido (ej "ONU signal critical","BGP peer down")
  "severity":    "critical | warning | info",     // requerido
  "entity": {                                      // entidad afectada (polimórfica, NO FK)
    "type": "router|network|instance|onu|pon|bgp_peer|rectifier|olt",
    "name": "string",                              // "RDA2","OLT-3/PON-5","ONU-abc"
    "ref":  "string?"                              // id estable opcional
  },
  "metric": { "name":"string?", "value":"number?", "unit":"dBm|%|Gbps|pps|V|s|null" },
  "threshold":   "number?",                        // umbral vulnerado (ej -30)
  "message":     "string",                         // resumen corto
  "explanation": "string?",                        // runbook / por qué
  "link":        "string?",                        // dashboard / generatorURL
  "startsAt":    "ISO8601",                         // inicio de la condición (de la fuente)
  "endsAt":      "ISO8601?",                        // solo en status=resolved
  "labels":      { }                               // passthrough opaco (debug), opcional
}
```

**Mapeo Grafana→canónico** (`GrafanaWebhookSource`): `labels.alertname`→`alertname`; `labels.severity`
(o mapeo fijo por alertname)→`severity`; `annotations.description`→`message`; `annotations.runbook_url`→
`explanation`; `generatorURL`→`link`; `fingerprint`→`fingerprint`; `labels.instance/router/...`→`entity`;
`startsAt`/`endsAt`→as-is. (Shape estándar de Grafana Alerting, NO verificado contra las 36 reglas del .37 —
asumido por doc pública; validar en el spike de Fase B.)

### Modelo `NocAlert` + ciclo de vida

| Grupo | Campos |
|---|---|
| Identidad/dedup | `id`, `source`, `fingerprint` — **@@unique([source, fingerprint])** |
| Clasificación | `alertname`, `severity`, `status` (`firing`\|`resolved`) |
| Entidad | `entityType`, `entityName`, `entityRef?` |
| Métrica | `metricName?`, `metricValue?`, `metricUnit?`, `threshold?` |
| Texto | `message`, `explanation?`, `link?` |
| Tiempos | `startsAt`, `firstSeen`, `lastSeen`, `endsAt?`, `createdAt`, `updatedAt` |
| ACK | `acknowledged`(bool), `ackBy?`, `ackAt?`, `ackNote?` — ortogonal a firing/resolved |
| Escalado | `escalationState?` (Fase D+, absorbe el nivel N1/N2/N3 de olt_watch) |
| Telegram | `telegramChatId?`, `telegramMessageId?` (para editar el msg al ackear) |

**Ciclo de vida**: `IngestAlert` hace **upsert por `(source, fingerprint)`** — si `status=firing` y no
existe → crea (`startsAt`, `firstSeen`); si existe firing → NO duplica (Grafana re-evalúa y reenvía;
actualiza `lastSeen`). `status=resolved` → marca `endsAt`/`resolved` la MISMA fila. Re-fire tras resolved:
resucita la fila (firing, resetea ack). **Historial por-ocurrencia diferido** (InfluxDB ya guarda la
serie temporal; una tabla `NocAlertEvent` de auditoría es Fase F+, no ahora). **MTTA** = `ackAt−startsAt`,
en el DTO.

### Puertos (firmas clave)

```ts
interface NocAlertRepository {
  upsertByFingerprint(input: NocAlertInput): Promise<NocAlert>;   // dedup (source,fingerprint)
  findById(id: string): Promise<NocAlert | null>;
  list(f: { source?; severity?; status?; acknowledged? }): Promise<NocAlert[]>;
  acknowledge(id: string, by: string, at: string, note?: string): Promise<NocAlert | null>;
}
interface AlertSource { map(raw: unknown): NocAlertInput; }          // GrafanaWebhookSource impl
interface AlertEventPublisher { publish(e: { type:'firing'|'resolved'|'acked'; alert: NocAlert }): void; }
interface AlertNotifier { notify(a: NocAlert): Promise<{chatId;messageId}|null>; editAck(a: NocAlert): Promise<void>; }
```

## Colector Rust — forma de módulos (repo `ipnext-noc-collector`)

| Módulo | Reemplaza (en cutover) | Contenido |
|---|---|---|
| `sensors/onu_signal` | `onu_signal_poll.py` | SmartOLT `get_onus_signals` cada 30min → Influx `onu_signal` + evalúa vs umbral → POST firing/resolved |
| `sensors/fibra_pon` | `fibra_report.py` | Agrupa por `(olt,pon)`; ≥`PON_MIN_ABON`(2) ONUs con Δ≤`-PON_DELTA`(1.5) vs mediana histórica 7/15/30d = PON sospechoso → alerta N2 |
| `sensors/olt_watch` | `olt_watch.py` | Watchdog OLT por transiciones LOS/power/uptime, cooldowns (LOS 24h / power 6h) |
| `sensors/seed_ocr` | `seed_signal.py` | **Milestone aislado, mayor riesgo**: tesseract (`leptess`, FFI a leptonica) — curva px→dBm |
| `hub_client` | — | POST canónico a `/api/alerts/ingest/fiber-collector` (key `fiberIngestKey`) — **F3**: antes apuntaba a `/ingest` a secas, hay que actualizarlo |
| `thresholds` | — | `GET /api/alerts/thresholds` cacheado; **fallback a defaults locales si el hub está caído** |
| `influx` | — | lee baselines (mediana histórica) |

Crates: `reqwest`, `tokio`, `serde`/`serde_json`, `influxdb2`, `leptess` (OCR), `tokio-cron-scheduler`,
`config`. Deploy: binario único + systemd, push=deploy (molde orchestrator RADIUS). Umbrales fibra
conocidos (defaults): `CRIT_DBM=-30`, `WARN_DBM=-27`, `DELTA_ALERT=2.0`, `PON_MIN_ABON=2`, `PON_DELTA=1.5`.
El hub es dueño (editables desde el panel, singleton molde `NocBroadcastConfig`); el Rust los LEE por API.
**Bloqueante de deploy (SOLO Fase E)**: reponer key SSH `ipnext_flows` de la VM 130 (10.75.0.40).

## Permisos (LAS DOS capas)

| Ruta | BE | FE |
|---|---|---|
| `GET /api/alerts`, `/stream` | `requirePerm('monitoring.read')` + `createAuthMiddleware` | `<Can permission="monitoring.read">` |
| `POST /api/alerts/:id/acknowledge` | `requirePerm('monitoring.acknowledge_alert')` | `<Can permission="monitoring.acknowledge_alert">` |
| `GET/PUT /api/alerts/thresholds` (F) | `requirePerm('monitoring.manage')` | `<Can permission="monitoring.manage">` |
| `POST /api/alerts/ingest/{source}` | `apiKeyMiddleware` por fuente, resuelta por el `:source` del path — `:source` desconocido → 404 (F3) | — |
| `POST /api/alerts/telegram/webhook` | secret-token (`X-Telegram-Bot-Api-Secret-Token`) | — |

`monitoring.read/manage/acknowledge_alert` YA existen en RBAC (`rbac.ts:41,115`). Las rutas nuevas NO
heredan el gap de `/api/monitoring`//`/api/notifications` (que montan sin auth): `requirePerm` desde el día 1.

## Testing Strategy (Strict TDD — red→green→refactor)

| Layer | Qué | Cómo |
|---|---|---|
| Unit (use-case) | `IngestAlert` dedup por fingerprint (firing repetido no duplica; resolved cierra la misma; re-fire resucita); `AcknowledgeAlert` MTTA + publish; mapeo Grafana | `InMemoryNocAlertRepository` + fakes de publisher/notifier (NUNCA mockear Prisma) |
| Unit (mapper) | `GrafanaWebhookSource.map` campo por campo | fixtures de webhook Grafana |
| Integration (routes) | supertest: `/ingest` 401 sin key (fail-closed); `/acknowledge` exige perm; `/stream` headers SSE correctos | app Express con repos in-memory |
| Composition-root | `app.ts` cablea el módulo alerts con los ports correctos (lección W6) | test de composición |
| E2E vivo | Grafana real → hub → panel (Fase B/C); ACK Telegram↔panel (Fase D) | contra `.37` (memoria e2e-envelope) |

## Migration / Rollout (secuencia por fases + DAG)

```
A(fundación) ─→ B(Grafana→hub) ─→ C(panel+SSE) ─→ D(Telegram bidi)
     └─────────────────────────────→ E(colector Rust) ─→ F(umbrales editables + sync Grafana)
```

| Fase | Entrega | Dep | Bloqueante |
|---|---|---|---|
| **A** | `NocAlert`+tabla+`AlertSource`+`IngestAlert`+`POST /ingest`(auth)+ciclo de vida+ACK API+permisos+DTO+flags seed | — | — |
| **B** | `GrafanaWebhookSource` + `/ingest/grafana`; Grafana +1 contact-point (dark, hub-enabled ON) | A | — |
| **C** | `AlertEventBus`+SSE `/stream`+panel FE+fallback polling. Spike proxy EasyPanel temprano | A,B | — |
| **D** | `TelegramBotGateway` saliente(botón)+webhook entrante(callbacks)+ACK sincronizado. Flag `telegram-send` OFF | A,C | token+webhook bot (secret) |
| **E** | Colector Rust (sensores→POST); dark-emite mientras hub oscuro | A | **key SSH `ipnext_flows`** + deploy VM130 |
| **F+** | Umbrales editables (`NocAlertThresholdsConfig`) + sync Grafana + otros vigías + PagerDuty | A–E | — |
| **Cutover** | flip `telegram-send` ON + baja Grafana→Telegram + stop `noc_metrics.py`/sensores Python | todas | **OK explícito del usuario** |

**Rollback**: migración aditiva → `down` dropea `NocAlert`, nada existente se altera. Desmontar
`/api/alerts` en `app.ts` deja el resto intacto. Flags OFF = kill-switch sin deploy. Quitar el
contact-point de Grafana restaura el estado previo. Detener el systemd del Rust no afecta al hub.

## Open Questions (residuales — no bloquean el diseño)

- [ ] **Retención**: ¿cuánto vive un `NocAlert` resolved antes de purgar? ¿InfluxDB `onu_signal` sigue en paralelo como base histórica? (afecta si se agrega `NocAlertEvent` en F).
- [ ] **Reuso de `NocBroadcastGateway`/`EvolutionApiHttpGateway`** para WhatsApp del hub — depende de confirmar si es la misma instancia Evolution (no verificable desde el repo). Telegram es el canal decidido; WhatsApp queda como extensión opcional.
- [ ] **Fase F sync Grafana**: ¿editar un umbral en el panel toca la regla vía API de Grafana (sync real) o es visualización? Define el costo real de F.
- [ ] **`WebhookDeliveryRepository`** para trazabilidad de deliveries crudas: el upsert-por-fingerprint ya cubre el negocio; el ledger sería solo auditoría. Diferido.
- [ ] **Payload real de las 36 reglas de Grafana**: validar el mapeo en el spike de Fase B (asumido por doc, no verificado en vivo).
