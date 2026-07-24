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
`labels.routerboard_name`/`labels.router`/`labels.nombre`/`labels.equipo`
(prioridad MikroTik) → `entityType: "router"`/`entityName`, con fallback a
`labels.instance` → `entityType: "instance"` y a `labels.network` →
`entityType: "network"`; `annotations.description` (fallback
`annotations.summary`) → `message`; `annotations.runbook_url` → `runbook`;
`generatorURL` → `link`; `fingerprint` → llave de dedup (ver Requirement
"Fingerprint with derived fallback" para el caso en que Grafana no lo manda).

#### Scenario: Labels and annotations map to the correct NocAlert fields
- GIVEN un alert de Grafana con `labels: {alertname: "BgpPeerDown", router: "core-1"}` y `annotations: {description: "BGP peer down", runbook_url: "https://..."}`
- WHEN se ingiere
- THEN el `NocAlert` resultante tiene `alertname: "BgpPeerDown"`, `entityName: "core-1"`, `message: "BGP peer down"`, `runbook` seteado desde `runbook_url`

### Requirement: Robust severity inference (FIX WAVE — revisado)
El sistema DEBE (MUST) inferir `severity` de forma insensible a
acentos/mayúsculas/separadores (espacio, guión, underscore) sobre el
vocabulario REAL de familias de alertnames del panel Grafana del .37 (36
reglas — ver skill `grafana-ipnext`), NO solo sobre la forma
pegada/con-guión asumida originalmente. `labels.severity`, cuando está
presente y mapea a un valor reconocido, GANA sobre la inferencia por
alertname. El default (ni `labels.severity` reconocible ni alertname
matcheado) es SIEMPRE `warning`, nunca `critical` — para no sobre-paginar por
una regla mal etiquetada.

Vocabulario de `labels.severity` aceptado (normalizado igual que el
alertname): `critical`/`crit`/`error`/`page`/`p1`/`p2` → `critical`;
`warning`/`warn`/`p3` → `warning`; `info`/`none` → `info`.

Familias de alertname que infieren `critical` (normalizadas — ejemplos
reales del .37): rectificador offline/sin AC/alarma crítica, router
caído/offline/sin métricas, telemetría ciega, carpet-bombing /24, cliente
CGNAT comprometido, BGP session/peer caído (`BgpPeerDown`), bus DC alto/bajo,
monitor de energía offline, ALGCom en batería. Familias que infieren
`warning`: CPU, memoria, errores/drops RX, saturación física, carga de
rectificador, interfaz/puerto/link down, batería descargándose.

**Decisión revisada (fix wave, F-B1)**: la versión original de este
requirement solo colapsaba acentos y asumía que el alertname llegaba
pegado o con guión (`"router-caido"`), por lo que variantes con espacio
(`"Router Caído"`, la forma real que manda Grafana) caían en `warning` —
un caso de under-paging (una caída de router real no alertaba como
crítica). El fix normaliza TODOS los separadores a una forma canónica antes
de matchear, y amplía el vocabulario a las familias reales en vez de nombres
sintéticos.

#### Scenario: Labels.severity explicit value wins over alertname inference
- GIVEN un alert con `labels: {alertname: "CPU > 80%", severity: "critical"}` (alertname que por sí solo inferiría `warning`)
- WHEN se ingiere
- THEN el `NocAlert` resultante tiene `severity: "critical"` (gana `labels.severity`)

#### Scenario: Real alertname with spaces/accents infers critical correctly
- GIVEN un alert con `labels: {alertname: "Router Caído"}` y SIN `labels.severity`
- WHEN se ingiere
- THEN el `NocAlert` resultante tiene `severity: "critical"` (antes del fix caía en `warning` por el espacio)

#### Scenario: Ambiguous "batería" family disambiguates by specific keyword
- GIVEN dos alerts: `labels: {alertname: "Batería descargándose"}` y `labels: {alertname: "ALGCom en batería"}`, ambos sin `labels.severity`
- WHEN se ingieren
- THEN el primero resulta `severity: "warning"` y el segundo `severity: "critical"` — el token genérico "batería" no pisa el match específico del segundo caso

### Requirement: Fingerprint with derived fallback (FIX WAVE — revisado)
El sistema DEBE (MUST) usar `fingerprint` del payload de Grafana cuando
viene; si NO viene (Grafana legacy que no lo emite), DEBE derivar uno
ESTABLE Y DETERMINÍSTICO a partir de `alertname` + labels ordenadas (mismo
input → mismo fingerprint siempre), en vez de rechazar el elemento. El
dedup `(source, fingerprint)` de `noc-alert-hub` sigue funcionando igual
sobre el fingerprint derivado.

**Decisión revisada (fix wave, F-B4)**: la versión original requería
`fingerprint` — su ausencia tiraba el elemento (y, antes del cambio
descrito abajo, todo el webhook) con un error. Eso hacía la ingesta frágil
ante versiones de Grafana que no lo mandan. **PENDIENTE**: verificar contra
la versión real de Grafana del .37 si emite `fingerprint` por alerta antes
del cutover — el fallback cubre el caso, pero conviene confirmar.

#### Scenario: Missing fingerprint derives a stable one instead of failing
- GIVEN un alert de Grafana sin campo `fingerprint`, con `labels: {alertname: "HighCpu", router: "r1"}`
- WHEN se ingiere
- THEN se crea un `NocAlert` con un `fingerprint` no vacío, derivado de `alertname` + labels
- AND ingerir el MISMO payload de nuevo produce el MISMO `fingerprint` derivado (upsert sobre la misma fila, no una fila nueva)

### Requirement: Malformed sobre rejection vs. independent per-element processing (FIX WAVE — revisado)
El sistema DEBE (MUST) responder `400` y NO crear ningún `NocAlert` SOLO
cuando el SOBRE del webhook no cumple la forma mínima esperada (falta el
array `alerts`, o está vacío). El sistema DEBE (MUST) procesar cada
elemento de `alerts[]` de forma INDEPENDIENTE: un elemento individual
malformado (p.ej. `status` inválido, sin `labels.alertname` resoluble) NO
tira el batch entero — se SALTEA y se reporta, y los elementos válidos del
mismo batch se ingieren igual. Un fallo del repositorio aislado a UN
elemento (no de mapeo, de persistencia) tampoco debe tumbar a sus hermanos
ni responder `500` con la persistencia parcial ya commiteada oculta al
caller. La respuesta DEBE incluir, además de `data` (los `NocAlert`
creados/actualizados), el detalle por elemento (`results`: índice,
fingerprint cuando se conoce, `status: "ok"|"error"|"skipped"`, motivo si
no fue `"ok"`). Código de respuesta: `201` si todos los elementos
resultaron `"ok"`; `207` (multi-status) si hubo al menos un `"skipped"` o
`"error"` mezclado con éxitos; `400` (sobre) solo en el caso de payload sin
`alerts[]`.

**Decisión revisada (fix wave, F-B2 + F-B3)**: la versión original de este
requirement (entonces "Malformed payload rejection" + "Grouped alerts
produce N NocAlerts") rechazaba TODO el webhook atómicamente ante CUALQUIER
elemento inválido, y el loop de ingesta en la ruta no aislaba fallos por
elemento — un throw a mitad de loop dejaba filas ya persistidas pero
respondía `500` total, ocultando el éxito parcial al caller (fan-out
parcial, hallazgo HIGH del review adversarial). El motivo del cambio:
**no perder alertas de red buenas por una hermana ruidosa** — en un webhook
agrupado de Grafana, descartar 4 alertas válidas porque la 5ª vino mal
formada es peor que aceptar las 4 y reportar la 5ª como fallida.

#### Scenario: Malformed sobre (no alerts array) is rejected without side effects
- GIVEN un payload sin el array `alerts`, o con `alerts: []`
- WHEN se hace `POST /api/alerts/ingest/grafana` con ese payload
- THEN responde `400` y no se crea ni actualiza ningún `NocAlert`

#### Scenario: One malformed element in a batch does not block its valid siblings
- GIVEN un webhook con 5 elementos en `alerts[]`, donde el elemento en índice 3 tiene `status` inválido
- WHEN se ingiere ese payload
- THEN los 4 elementos válidos se ingieren (se crean/actualizan 4 `NocAlert`), la respuesta es `207`, y `results` reporta el índice 3 como `"skipped"` con el motivo

#### Scenario: A repository failure isolated to one element does not roll back its siblings
- GIVEN un webhook con 3 elementos válidos, donde ingerir el 2º falla en el repositorio (error transitorio)
- WHEN se ingiere ese payload
- THEN los otros 2 elementos se persisten, la respuesta es `207` (no `500`), y `results` reporta el 2º elemento como `"error"` con el mensaje

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

**FIX WAVE (review adversarial de Fase B)** — cobertura agregada:
- Severidad robusta (F-B1): tests parametrizados sobre TODAS las familias
  reales de alertname del .37 (críticas y warning), casos de espacio/guión/
  pegado equivalentes, el caso ambiguo "batería", y el vocabulario completo
  de `labels.severity` (`crit`/`error`/`page`/`p1`/`p2`/`warn`/`p3`/`info`/
  `none`).
- Fan-out aislado (F-B2): test de ruta con un repo "flaky" que falla para UN
  fingerprint específico dentro de un batch de 3 — verifica que los otros 2
  se persisten y la respuesta reporta el fallo puntual, nunca `500`.
- Procesamiento independiente (F-B3): test de ruta con batch de 5 donde el
  índice 3 es inválido — los 4 válidos se ingieren, `207`, `results` reporta
  el índice 3 como `skipped`.
- Fingerprint derivado (F-B4): test de determinismo (mismo alertname+labels
  → mismo fingerprint derivado en dos llamadas independientes) y de
  divergencia (inputs distintos → fingerprints derivados distintos).

**PENDIENTE antes del cutover**: confirmar contra la versión real de
Grafana instalada en el .37 (a) si emite `fingerprint` por alerta, y
(b) qué vocabulario de `labels.severity` usa realmente esa instalación —
el fallback de F-B4 y el mapeo de F-B1 cubren el caso general, pero conviene
verificar contra el payload real antes de dar por cerrada la integración.
