# Noc Alert Grafana Source Specification

## Purpose

Adapter `GrafanaWebhookSource`: mapea el webhook de Grafana Alerting
(`{status, alerts: [{status, labels, annotations, startsAt, endsAt,
fingerprint, generatorURL}]}`) al modelo `NocAlert`, delegando al MISMO
`IngestAlert` use-case de `noc-alert-hub` (el use-case no sabe de Grafana).
Reemplaza al `grafana-wa-relay` roto. **No reescribe Grafana** — solo agrega
un contact-point nuevo; el contact-point/canal Telegram existente NO se toca
ni se apaga (convivencia, Fase 2 futura corta lo viejo). Sigue en modo
oscuro: sin envío saliente desde el hub (hereda esa restricción de
`noc-alert-hub`).

## Requirements

### Requirement: Grafana webhook ingestion endpoint
El sistema DEBE (MUST) exponer `POST /api/alerts/ingest/grafana` (mismo
molde de auth shared-secret que `noc-alert-hub`, key propia
`grafanaIngestKey`), que parsea el payload de Grafana Alerting y llama a
`IngestAlert` una vez por cada alerta del array `alerts`.

#### Scenario: Firing webhook creates a NocAlert with source=grafana
- GIVEN Grafana envía un webhook con `alerts: [{status: "firing", fingerprint: "abc", labels: {alertname: "HighLatency", router: "r1"}, ...}]`
- WHEN se ingiere ese payload
- THEN se crea un `NocAlert` con `source: "grafana"`, `status: "firing"`, `type`/`alertname` desde `labels.alertname`

#### Scenario: Resolved webhook closes the matching NocAlert
- GIVEN existe un `NocAlert` `firing` con `source: "grafana"` y el `fingerprint` dado
- WHEN Grafana envía el webhook con `alerts: [{status: "resolved", fingerprint: "abc", ...}]`
- THEN el `NocAlert` correspondiente pasa a `status: "resolved"` con `endsAt` seteado

### Requirement: Label and annotation mapping
El sistema DEBE (MUST) mapear `labels.alertname` → `type`/`alertname`;
`labels.router`/`labels.network`/`labels.instance` (el que esté presente) →
`entityType`/`entityName`; `annotations.description` → `message`;
`annotations.runbook_url` → `runbook`; `generatorURL` → `link`;
`fingerprint` → llave de dedup.

#### Scenario: Labels and annotations map to the correct NocAlert fields
- GIVEN un alert de Grafana con `labels: {alertname: "BgpPeerDown", router: "core-1"}` y `annotations: {description: "BGP peer down", runbook_url: "https://..."}`
- WHEN se ingiere
- THEN el `NocAlert` resultante tiene `alertname: "BgpPeerDown"`, `entityName: "core-1"`, `message: "BGP peer down"`, `runbook` seteado desde `runbook_url`

### Requirement: Malformed payload rejection
El sistema DEBE (MUST) responder `400` y NO crear ningún `NocAlert` si el
payload no cumple la forma mínima esperada (falta `alerts`, o un elemento sin
`fingerprint`/`status`).

#### Scenario: Malformed payload is rejected without side effects
- GIVEN un payload sin el array `alerts`, o con un elemento sin `fingerprint`
- WHEN se hace `POST /api/alerts/ingest/grafana` con ese payload
- THEN responde `400` y no se crea ni actualiza ningún `NocAlert`

### Requirement: Grouped alerts produce N NocAlerts
El sistema DEBE (MUST) procesar cada elemento del array `alerts` de un mismo
webhook de forma independiente, generando/actualizando un `NocAlert` por
cada `fingerprint` distinto.

#### Scenario: A grouped webhook with multiple alerts creates one NocAlert per fingerprint
- GIVEN un webhook con `alerts: [{fingerprint: "a", status: "firing", ...}, {fingerprint: "b", status: "firing", ...}]`
- WHEN se ingiere ese payload
- THEN se crean 2 `NocAlert` distintos, uno por `fingerprint`

## Testing Notes

`GrafanaWebhookSource` se testea como mapper puro (payload → forma de
dominio) MÁS un test de ruta con `supertest` que recorre
control→ruta→`IngestAlert` real→`InMemoryNocAlertRepository` (mismo seam que
`noc-alert-hub`). No mockear Prisma. Reusa los mismos escenarios de auth
(401 sin/con token inválido) ya cubiertos en `noc-alert-hub` — no se
reespecifican acá para no duplicar.
