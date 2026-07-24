# Proposal: NOC Alerts Hub

## Intent

El NOC no tiene una central de alertas: Grafana del .37 (36 reglas: red/MikroTik, energía/rectificadores DC, DDoS/BGP) rutea a Telegram y a un `grafana-wa-relay` **roto** (Evolution 404); la fibra (VM 130) corre sensores Python + un motor `noc_metrics.py` con su propio ciclo de vida/ACK/escalado en Telegram. No hay panel, ni estado operativo unificado, ni ACK sincronizado. El scaffold `MonitoringAlert`/`Notification` existe pero está vacío y roto (`resolvedAt` hardcodeado a `null`, columna inexistente).

Construir **el HUB en Prominense (BE hexagonal Node/TS)** como única central: recibe cada alerta una vez, persiste el ciclo de vida completo, y hace **fan-out** a panel (SSE) + Telegram (botón inline), con **ACK bidireccional** sincronizado.

## Scope

### In Scope
- Entidad `Alert` **nueva** (tabla propia, migración aditiva) con ciclo de vida firing→resolved + `fingerprint` como llave de upsert. NO se reusa `MonitoringAlert` (cubre 1/12 campos, enum device-céntrico, FK `deviceId` incompatible con BGP/DDoS/rectificador).
- Port `AlertSource` + `IngestAlert` use-case + endpoint `POST /api/alerts/ingest/*` (auth shared-secret por fuente, molde `apiKeyMiddleware`).
- Adapter `GrafanaWebhookSource` (reemplaza el relay roto; +1 contact point, NO se reescribe Grafana).
- ACK con MTTA, **local al hub** (Grafana sigue firing de su lado).
- Real-time por **SSE** + event-bus in-memory (`AlertEventPublisher` port); fallback polling (`refetchInterval` gateado por visibilidad).
- Bot de Telegram: envío saliente + webhook **entrante** (callbacks `ack:<id>`), ACK sincronizado panel↔Telegram.
- Panel FE (filtros fuente/severidad/estado + ACK); permisos `monitoring.*` enforced en BE+FE.
- Contrato de ingesta para el **colector Rust** de fibra (sensores en Rust, repo aparte).

### Out of Scope
- Reescribir Grafana o el stack DDoS (fastnetmon/exabgp — se toca).
- `noc_metrics.py`: NO se reescribe en Rust — lo **absorbe el hub** y se jubila.
- Umbrales editables con sync a Grafana (fase posterior, la pieza más cara).
- Otros vigías NO-fibra (`loop911_watch`, `infra_watch`, `maint`) y PagerDuty fino (fase posterior).
- Deprecar/borrar `MonitoringAlert`/`MonitoringDevice`/`Notification` (quedan dormidos, documentados).

## Capabilities

### New Capabilities
- `noc-alert-hub`: entidad `Alert`, ciclo de vida firing/resolved + dedup por fingerprint, `AlertSource` port, `IngestAlert`, endpoints de ingesta con auth por fuente, ACK+MTTA local, rutas de lectura/ACK con `requirePerm`, DTO. (Fase A)
- `noc-alert-grafana-source`: mapper del webhook de Grafana → `Alert`; reemplazo del relay WhatsApp roto. (Fase B)
- `noc-alert-realtime`: SSE `GET /api/alerts/stream` + event-bus in-memory + panel FE (filtros/ACK) + fallback polling. (Fase C)
- `noc-alert-telegram`: envío saliente con botón inline + webhook entrante de callbacks; ACK bidireccional sincronizado. (Fase D)
- `noc-fiber-collector-ingest`: contrato de ingesta del colector Rust (sensores señal ONU / análisis PON / olt_watch / OCR seed). (Fase E)
- `noc-alert-thresholds`: config singleton de umbrales editable; colector Rust la lee por API; sync a Grafana diferido. (Fase F+)

### Modified Capabilities
None. Se **enforcean** los permisos `monitoring.read/manage/acknowledge_alert` (ya en el catálogo RBAC) en rutas nuevas; no cambia el spec del catálogo. Cualquier permiso de umbrales nuevo entra recién en Fase F.

## Approach — Fases (orden = valor temprano; A→B→C dan panel útil sin tocar la fibra)

El eje **Grafana NO depende** de la VM 130, ni de Rust, ni de la key SSH perdida → se entrega PRIMERO. La fibra/Rust va después (tiene el bloqueante del deploy en la VM).

| Fase | Entrega | Desbloquea | Dependencias / bloqueantes |
|------|---------|-----------|----------------------------|
| **A — Fundación** | Entidad `Alert` + tabla (migración aditiva) + `AlertSource` + `IngestAlert` + `POST /ingest` (auth) + ciclo de vida + ACK vía API + permisos + DTO. Sin real-time. | B, C, E | Ninguno |
| **B — Grafana→hub** | Adapter `GrafanaWebhookSource`; Grafana postea al hub (+1 contact point). Se ven alertas red/energía/DDoS. | — | A |
| **C — Panel + SSE** | Panel FE (filtros/ACK) + SSE (event-bus→stream) + fallback polling. Usable end-to-end. | D | A, B |
| **D — Telegram bidireccional** | Bot: saliente con botón + webhook entrante; ACK sincronizado panel↔Telegram. | — | A, C |
| **E — Colector Rust fibra** | Sensores Rust en VM 130 (señal/PON/olt_watch/OCR) → POST al hub. | F | A. **Bloqueante: reponer key SSH `ipnext_flows` + definir deploy (push=deploy, systemd)** |
| **F+ — Posterior** | Umbrales editables + sync Grafana; otros vigías; PagerDuty fino. | — | A–E |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | Tabla `Alert` (+ `AlertThresholdsConfig` singleton en F). Aditivo, no toca `MonitoringAlert`/`Notification`. |
| `src/domain/entities/`, `src/domain/ports/` | New | `Alert`, `AlertSource`, `AlertEventPublisher`. |
| `src/application/use-cases/alerts/` | New | `IngestAlert`, `AcknowledgeAlert`, `ListAlerts`, etc. |
| `src/infrastructure/adapters/prisma/`, `.../in-memory/` | New | `PrismaAlertRepository` / `InMemoryAlertRepository` (respetar naming). |
| `src/infrastructure/http/app.ts` | Modified | **⚠ God Object (617 líneas, known_debt)**: se suma wiring del router `/api/alerts` + SSE + Telegram webhook. Mantener el patrón, considerar extraer un `alertsModule` de composición. |
| `src/infrastructure/http/middleware/apiKeyMiddleware.ts` | Reference | Molde a parametrizar (key por fuente). |
| `ipnext-frontend/src/pages/`, `.../hooks/` | New | Panel `AlertsPage` + hook con SSE/fallback (molde `useWhatsapp.ts`). |
| Repo Rust nuevo (aparte) | New | Colector de sensores fibra. |

**Splynx**: este change NO agrega dependencias de Splynx (cumple la restricción arquitectónica).

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| SSE buffereado por el proxy EasyPanel (no verificado) | Med | Spike de 30 min en vivo temprano (Fase C); plan B = polling ya incluido como fallback. |
| Event-bus in-memory se rompe en scale-out horizontal (>1 réplica → clientes pierden eventos silenciosamente) | Med | Verificar replica count del deploy antes de Fase C; si >1, bus externo o sticky sessions. |
| Key SSH `ipnext_flows` perdida | High | Bloquea SOLO el **deploy** del colector (Fase E), NO el diseño ni el eje Grafana (A–D avanza). Pre-requisito explícito de E. |
| OCR en Rust (tesseract/leptonica FFI) | Med | Aislar el OCR como milestone propio dentro de E; mayor esfuerzo/incertidumbre. |
| Doble emisión Grafana→hub y Grafana→Telegram durante coexistencia | Med | Time-boxear la convivencia; Fase 2 (post-confiabilidad) corta el contact-point viejo. |
| 3 tablas alert-like coexistiendo (`Notification`/`MonitoringAlert`/`Alert`) | Low | Documentar POR QUÉ en el schema para no leerlo como duplicación accidental. |
| Bot de Telegram del hub = token/webhook nuevos (secret) | Low | Config fail-fast en `config.ts`; documentar en `env.example`. |
| Gap de auth heredado (`/api/monitoring` y `/api/notifications` sin `requirePerm`) | Med | Las rutas NUEVAS del hub NO heredan el gap: `requirePerm` desde el día 1. |
| `app.ts` God Object crece más | Med | Extraer composición del módulo alerts; no inflar el archivo God. |

## Rollback Plan

- Migración **aditiva** (tabla `Alert` nueva) → rollback = migración `down` que dropea la tabla; nada existente se altera.
- Wiring en `app.ts` detrás de flags/mounts nuevos → desmontar el router `/api/alerts` deja el resto intacto.
- Grafana (Fase B): quitar el contact-point extra restaura el estado previo (Telegram sigue).
- Telegram bot (Fase D): flag de apagado en config (Telegram opcional).
- Colector Rust (Fase E): binario independiente en la VM; detener el systemd no afecta al hub.

## Dependencies

- Reponer key SSH `ipnext_flows` + definir deploy en VM 130 (SOLO para Fase E).
- Confirmar replica count del deploy EasyPanel (para Fase C, event-bus).
- Token + webhook del bot de Telegram del hub (para Fase D).

## Success Criteria

- [ ] Fase A: una alerta ingerida por API persiste como `Alert`, ackeable por API con MTTA; ingesta rechaza sin key (fail-closed).
- [ ] firing repetido del mismo `fingerprint` NO duplica fila; `resolved` cierra la misma.
- [ ] Fase B: las 36 reglas de Grafana llegan al hub; el relay WhatsApp roto queda reemplazado.
- [ ] Fase C: el panel muestra alertas en tiempo real (SSE) con fallback a polling; filtros y ACK operativos.
- [ ] Fase D: ACK desde Telegram se refleja en el panel y viceversa (bidireccional).
- [ ] Rutas de usuario del hub exigen `monitoring.*` en BE (no solo ocultas en FE).
- [ ] Fase E: el colector Rust postea señal/PON/olt_watch al hub; `noc_metrics.py` se jubila.

## Preguntas abiertas (para design / confirmación del usuario)

1. **Retención**: ¿cuánto vive una alerta `resolved` antes de purgarse? ¿InfluxDB `onu_signal` sigue en paralelo o el hub es la única base histórica?
2. **Nombre tabla/módulo**: ¿`Alert` a secas, o `NocAlert`/`OpsAlert` para no confundir con `MonitoringAlert`?
3. **Reuso de `NocBroadcastGateway`/`EvolutionApiHttpGateway`** para el WhatsApp del hub — depende de confirmar si es la misma instancia Evolution (no verificable desde el repo).
4. **Fase F**: al editar un umbral de Grafana en el panel, ¿toca la regla vía API de Grafana (sync real) o es solo visualización? (define el costo real de F).
5. ¿Sumar `WebhookDeliveryRepository` para trazabilidad de deliveries crudas, o alcanza el upsert-por-fingerprint?
