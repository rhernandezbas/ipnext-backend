# Exploration: noc-alerts-hub

> Hub unificado de alertas NOC (BE hexagonal Node/TS) + panel FE + colector Rust
> para la fibra. Arquitectura ya decidida por el usuario (ver BACKLOG.md #entry
> 2026-07-24 y el prompt de esta exploración) — este documento NO reabre esas
> decisiones, investiga el código real para alimentar el `sdd-propose`.

## Resumen ejecutivo

- El scaffold `Notification` + `MonitoringDevice`/`MonitoringAlert` **existe pero
  está genuinamente vacío y parcialmente roto**: un campo del dominio
  (`resolvedAt`) está hardcodeado a `null` porque la columna ni siquiera existe
  en la tabla Prisma (`src/infrastructure/adapters/prisma/PrismaMonitoringRepository.ts:57`).
  Nadie escribe en `MonitoringAlert`/`MonitoringDevice`/`Notification` hoy (cero
  `.create()` fuera de fixtures de test/seed in-memory).
- **Recomendación de modelo: entidad `Alert` NUEVA**, no extender
  `MonitoringAlert`. El `type` de `MonitoringAlert` es un enum cerrado
  device-céntrico (`offline|high_latency|packet_loss|bandwidth_exceeded|config_changed`)
  y su única FK (`deviceId`) asume que toda alerta cuelga de un
  `MonitoringDevice` — ninguna de las dos cosas encaja con BGP/DDoS/rectificador
  (sin "device") ni con el ciclo de vida firing/resolved con fingerprint que
  pide Grafana. Detalle completo en la sección 1.
- **Hallazgo no pedido pero relevante**: ya existe en este mismo backend un
  gateway de WhatsApp vivo — `EvolutionApiHttpGateway` +
  `NocBroadcastGateway` + `BroadcastToNoc` (`src/application/use-cases/nocBroadcast/BroadcastToNoc.ts`,
  `src/infrastructure/adapters/evolution/EvolutionApiHttpGateway.ts`) — que ya
  postea a una instancia Evolution API ("ronald noc", Raspberry Pi) para
  news/tareas de red. Es candidato fuerte a **reemplazar el `grafana-wa-relay`
  roto** reusando esta MISMA infraestructura en vez de escribir un cliente
  Evolution nuevo. **No pude confirmar que sea la MISMA instancia Evolution que
  usa el relay del .37** (no tengo acceso a los scripts/infra de la VM 130 ni
  del .37 desde este repo) — es una hipótesis a validar con el usuario, no un
  hecho verificado.
- `MonitoringPage.tsx` (FE) es un mapa de dispositivos lat/lng + tabla, NO un
  panel de alertas filtrable — no sirve como base para el nuevo panel sin
  reescritura sustancial (ver sección 5).
- Los hooks `useMonitoring`/`useNotifications` **NO pollean hoy** (solo
  `staleTime: 30_000`, sin `refetchInterval` — el botón "Actualizar" de
  `MonitoringPage` hace `window.location.reload()`). El patrón
  `refetchInterval` gateado por `useDocumentVisible()` sí es maduro (16
  archivos), pero vive en otros hooks (`useWhatsapp.ts`, `useUispSyncStatus.ts`),
  no en estos dos.
- El módulo RBAC `monitoring` YA tiene las acciones `read`/`manage`/
  `acknowledge_alert` cargadas (`src/domain/entities/rbac.ts:41,115`) y el FE
  ya usa `<Can permission="monitoring.acknowledge_alert">`
  (`ipnext-frontend/src/pages/monitoring/MonitoringPage.tsx:211`) — pero
  ninguna ruta BE (`/api/monitoring`, `/api/notifications`) aplica
  `requirePerm` ni `authAdapter` hoy (confirmado, ver sección 7). Es un gap de
  seguridad preexistente, no introducido por este change, pero el hub lo hereda
  si no se corrige.
- Patrón de webhook entrante con idempotencia YA EXISTE y es el molde correcto
  a imitar/reusar parcialmente: `WebhookDeliveryRepository` (dedup ledger) +
  `chatwootSignatureMiddleware` (HMAC) para Chatwoot, y `apiKeyMiddleware` (
  shared-secret simple) para `/api/external/v1`. Grafana no firma HMAC por
  defecto — el molde que aplica es `apiKeyMiddleware`, no el de Chatwoot.
- **NO hay precedente de SSE ni de un event-bus in-memory en todo el
  backend** — es un patrón genuinamente nuevo para este repo (`grep` sobre
  `text/event-stream`/`EventSource` no dio ningún hit real, solo falsos
  positivos de la palabra "asset").
- Precedente sólido para "umbrales editables" = tabla singleton (`id:
  "singleton"`), igual que `GestionRealIngestConfig` y `NocBroadcastConfig`
  (`prisma/schema.prisma:2313`, `:2335`).
- **Bloqueante de implementación confirmado por el usuario** (no verificable
  desde este repo): la key SSH `ipnext_flows` de la VM 130 está perdida — el
  colector Rust no se puede probar en vivo hasta reponerla.

---

## 1. Modelo de dominio "Alerta" unificado

### Lo que existe (verificado)

`src/domain/entities/monitoring.ts:19-29`:
```ts
export interface MonitoringAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  type: 'offline' | 'high_latency' | 'packet_loss' | 'bandwidth_exceeded' | 'config_changed';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  occurredAt: string;
  resolvedAt: string | null;
  acknowledged: boolean;
}
```

Tabla Prisma real (`prisma/schema.prisma:2287-2299`):
```prisma
model MonitoringAlert {
  id             String    @id @default(uuid())
  deviceId       String?
  type           String
  severity       String    @default("warning")
  message        String
  acknowledged   Boolean   @default(false)
  acknowledgedAt DateTime?
  acknowledgedBy String?
  createdAt      DateTime  @default(now())
  @@index([acknowledged])
}
```

**Gap verificado**: el dominio declara `resolvedAt: string | null` pero la
tabla NO tiene esa columna. `PrismaMonitoringRepository.toMonitoringAlert`
(`src/infrastructure/adapters/prisma/PrismaMonitoringRepository.ts:38-60`)
hardcodea `resolvedAt: null` siempre (línea 57) y `deviceName: ''` siempre
(línea 52, nunca hace join con `MonitoringDevice`). Esto es dead code que
nunca se ejecutó contra datos reales — coherente con "nadie alimenta esto".

`Notification` (`src/domain/entities/notification.ts:1-16` +
`prisma/schema.prisma:335-345`) SÍ está completo y consistente
dominio↔tabla, pero es un modelo de "bandeja de campana" genérico (title +
message + link + read/unread), sin severidad operacional rica ni ciclo de
vida firing/resolved — es complementario, no sustituto.

### Comparación campo a campo contra lo que pide el hub

| Campo necesario | `MonitoringAlert` hoy | `Notification` hoy | Encaja? |
|---|---|---|---|
| status firing/resolved | No (solo `acknowledged` bool + `resolvedAt` MUERTO) | No | ❌ ninguno |
| severidad | Sí (`critical/warning/info`, 3 valores) | Sí (`info/warning/error/success`, 4 valores, DISTINTOS) | Parcial, escalas distintas |
| fuente/origen (grafana/fiber) | No | No | ❌ |
| tipo/alertname libre | No — enum cerrado de 5 valores device-céntricos | Sí (`NotificationType`, pero también enum cerrado de 10 valores de dominio de negocio, no de red) | ❌ ambos |
| entidad afectada (router/network/instance/ONU) | Solo `deviceId` → FK a `MonitoringDevice` (asume "device" siempre) | No | ❌ no polimórfico |
| interfaz / peer | No | No | ❌ |
| métrica + valor + unidad | No (solo `message` de texto libre) | No | ❌ |
| umbral | No | No | ❌ |
| timestamp_inicio (distinto de "recibido") | Solo `createdAt` (=processing time, no `startsAt` de Grafana) | Solo `createdAt` | ❌ |
| requiere ACK / ack_age | `acknowledged`+`acknowledgedAt` sí existen y sirven tal cual | No | ✅ MonitoringAlert |
| link/dashboard | No | Sí (`link`, pero pensado para rutas del FE, no URLs de Grafana externas) | Parcial |
| explicación/runbook | No (`message` es lo único, sin separar resumen de explicación) | No | ❌ |
| fingerprint/dedup de la MISMA alerta a través de firing→resolved | No existe ningún campo así en ninguna tabla | No | ❌ ninguno |

**Conclusión**: de 12 campos pedidos, `MonitoringAlert` cubre bien 1
(ack/ack_age) y parcialmente 1 más (severidad, con escala distinta).
`Notification` cubre 0 de los operacionales (es un modelo de otro dominio:
bandeja de usuario, no telemetría de red). Ninguna de las dos tablas tiene
noción de fingerprint, lo cual es el requisito más crítico para no duplicar
la MISMA alerta en cada evaluación del intervalo de Grafana.

### Opciones

**Opción A — Extender `MonitoringAlert`.**
- Pros: reusa router/RBAC/AcknowledgeAlert/FE `<Can permission="monitoring.acknowledge_alert">`
  ya cableados.
- Contras: hay que (1) volver `type` de enum cerrado a string libre —
  redefine la semántica del campo bajo el mismo nombre; (2) volver `deviceId`
  nullable-y-generalmente-null porque BGP/DDoS/rectificador no tienen
  `MonitoringDevice`, lo cual vacía de sentido esa FK; (3) agregar ~7 columnas
  nuevas (`source`, `alertname`, `fingerprint`, `entityType`, `entityName`,
  `metricValue`, `metricUnit`, `threshold`, `startsAt`, `link`, `runbook`) a
  una tabla que ya tiene un nombre y una FK que ya no describen lo que
  contiene. Es "reuso" solo de nombre — el resultado ya no es
  `MonitoringAlert`, es `Alert` con un alias viejo.
- Esfuerzo real: Medio-Alto (la migración es casi la misma que crear la tabla
  nueva, más el costo de reinterpretar los datos/tests existentes que asumen
  el enum cerrado, p. ej. `MonitoringUseCases.test.ts` y el sweep de rutas
  `asyncErrorSweep2.crud.routes.test.ts:79`).

**Opción B (recomendada) — Entidad `Alert` nueva, tabla propia,
`AlertRepository` propio, rutas `/api/alerts/*` dedicadas.**
- `MonitoringAlert`/`MonitoringDevice` quedan tal cual, dormidos (candidatos a
  deprecar/borrar en un cleanup futuro, fuera de alcance de este change).
- El use-case de ingesta, además de escribir en `Alert`, puede
  OPCIONALMENTE escribir una fila `Notification` (fan-out best-effort) para
  que la campana genérica del FE también se entere de alertas críticas — esto
  es integración limpia entre dos conceptos distintos, no duplicación.
- Pros: modelo polimórfico correcto desde el día 1 (entidad afectada como
  `entityType/entityName` libres, no FK), ciclo de vida firing→resolved con
  `fingerprint` como llave natural de upsert, metric/threshold/link/runbook
  de primera clase, sin arrastrar semántica vieja.
- Contras: una tabla más en un schema que ya tiene 3 conceptos parecidos
  (`Notification`, `MonitoringAlert`, `Alert`) — requiere dejar bien
  documentado en el `proposal.md` POR QUÉ coexisten (para que el próximo
  que lea el schema no lo lea como duplicación accidental).
- Esfuerzo: Medio (1 migración aditiva, 1 entidad, 1 port, 2 adapters
  in-memory/Prisma, use-cases nuevos siguiendo el molde exacto de
  `Monitoring*`).

**Recomendación: Opción B.** El mismatch de Opción A no es cosmético —
`deviceId` como única forma de asociar una alerta a "lo que falló" es
estructuralmente incompatible con BGP peers, DDoS, rectificadores DC y
señal óptica de ONU, que son la mayoría de las 36 reglas de Grafana + toda
la fibra.

### Ciclo de vida propuesto (para que `sdd-design` lo aterrice)

- **firing** (Grafana envía `status: "firing"` o el colector Rust reporta
  breach): upsert por `(source, fingerprint)` → si no existe, crea con
  `status: 'firing'`, `startsAt`; si existe y sigue `firing`, NO duplica (
  Grafana re-evalúa la regla cada N segundos y reenvía el webhook mientras
  siga en breach — esto es evaluación repetida, no un evento nuevo).
- **resolved** (Grafana envía `status: "resolved"` para el mismo
  `fingerprint`): actualiza la fila existente a `status: 'resolved'`,
  `endsAt`. Si no hay fila `firing` previa con ese fingerprint (reinicio del
  hub, race), decidir en design si se crea igual (con `startsAt=endsAt`) o
  se descarta — abierto.
- **acknowledged**: ortogonal a firing/resolved (una alerta puede reconocerse
  mientras sigue firing, y seguir reconocida cuando resuelve — mismo patrón
  que `MonitoringAlert.acknowledged` ya tiene).
- **dedup de firing repetido**: la llave `(source, fingerprint)` cubre esto
  sin necesitar el `WebhookDeliveryRepository` genérico — a diferencia de
  Chatwoot (donde cada delivery crea un mensaje independiente), acá SÍ
  queremos mutar la misma fila, así que upsert-por-fingerprint es más
  correcto que un ledger de "ya visto, ignorar".

---

## 2. Puerto `AlertSource` y flujo de ingesta

### Patrones existentes a imitar

- **HMAC + anti-replay** (no aplica a Grafana por defecto, pero es el molde
  de máxima seguridad): `src/infrastructure/http/middleware/chatwootSignatureMiddleware.ts` +
  `rawBodyJsonParser()`, wireados en `app.ts:1040` (`app.use('/api/messaging/webhook', rawBodyJsonParser())`)
  ANTES del `express.json()` global, exactamente para poder recomputar el HMAC
  sobre bytes crudos.
- **Shared-secret simple** (el molde que SÍ aplica a Grafana/Rust):
  `src/infrastructure/http/middleware/apiKeyMiddleware.ts` — lee
  `X-API-Key` o `Authorization: Bearer`, 401 fail-closed si no hay key
  configurada. Ya protege `/api/external/v1`.
- **Dedup ledger genérico**: `src/domain/ports/WebhookDeliveryRepository.ts`
  — patrón "process-then-record": `hasSeen()` ANTES de procesar,
  `recordIfNew()` DESPUÉS de procesar con éxito (para no perder eventos si el
  handler tira). Útil si se quiere blindar contra reintentos HTTP de Grafana
  en 5xx, PERO como se explicó arriba, el upsert-por-fingerprint ya
  resuelve el caso de negocio (alertas repetidas) — este ledger sería
  redundante salvo que se quiera loguear cada delivery cruda para auditoría.
  **Abierto**: ¿vale la pena sumarlo igual, solo para trazabilidad?

### Propuesta de forma (para proposal/design, no cerrada acá)

- Rutas de ingesta separadas por fuente (evita tener que "adivinar" el shape
  del payload): `POST /api/alerts/ingest/grafana` y
  `POST /api/alerts/ingest/fiber-collector`, ambas detrás de
  `apiKeyMiddleware` (o una variante con una key por fuente —
  `config.alertsHub.grafanaIngestKey` / `...fiberIngestKey` — para poder
  rotar una sin afectar la otra).
- `GrafanaWebhookSource` (adapter) = una función/clase que mapea el JSON del
  contact-point de Grafana (`{ status, alerts: [{ status, labels, annotations,
  startsAt, endsAt, fingerprint, generatorURL, ... }] }` — forma estándar de
  Grafana Alerting, NO verificada contra el payload real de las 36 reglas del
  .37 porque no tengo acceso SSH desde este repo; **asumido por
  documentación pública de Grafana, no confirmado en vivo**) hacia el
  `Alert` de dominio. `labels.alertname` → `alertname`; `labels.severity` (si
  las reglas lo taggean así) o un mapeo fijo → `severity`; `annotations.description`
  → `message`/`explanation`; `annotations.runbook_url` → `runbook`;
  `generatorURL` → `link`; `fingerprint` → dedup key.
- El colector Rust postea a su propio sub-endpoint con su propio shape (a
  definir en su repo aparte) — mismo patrón de ingesta, mapper distinto
  (`FiberCollectorSource`).
- Ambos sub-endpoints delegan al MISMO use-case `IngestAlert` una vez
  mapeado a la forma de dominio — el use-case no sabe de Grafana ni de Rust,
  solo de `Alert`.

---

## 3. SSE (`GET /api/alerts/stream`)

- **Sin precedente en el repo** — no hay ningún uso de
  `text/event-stream`/`EventSource`/`res.write` streaming, ni ningún
  event-bus in-memory (`EventEmitter`) en `src/`. Es un patrón 100% nuevo.
- Auth: debe ir detrás de `createAuthMiddleware(authAdapter, sessionRepo)`
  (el MISMO middleware de sesión-cookie que protege el resto de rutas
  GET, ver `app.ts:1570`, `:1705`, `:1784` etc.) — NO el `apiKeyMiddleware`
  (ese es machine-to-machine para ingesta, no para el navegador). El
  `EventSource` del navegador no puede mandar headers custom, pero SÍ manda
  cookies con `withCredentials: true` — hay que confirmar que
  `config.cookieSecure`/`corsOrigin` (`src/infrastructure/config.ts:38-40`)
  ya soportan credentials cross-origin (el resto del FE ya depende de la
  cookie de sesión para sus fetch normales, así que debería funcionar igual,
  pero no lo verifiqué explícitamente para el caso `EventSource`).
- Mecanismo hexagonal limpio: un `AlertEventBus` en
  `infrastructure/` (NO en domain — domain no hace I/O), un simple wrapper
  sobre `EventEmitter` de Node. `IngestAlert` (use-case) recibe el bus como
  dependencia inyectada (vía un port `AlertEventPublisher` en domain/ports,
  para no romper DIP) y publica DESPUÉS de persistir con éxito. La ruta SSE
  se suscribe al bus, no al use-case.
- El bus in-memory implica: **si el proceso Node escala a más de una
  instancia, cada instancia tiene su propio bus y un cliente conectado a la
  instancia A nunca ve alertas ingeridas vía la instancia B** — hay que
  confirmar que el deploy actual (EasyPanel, `docker network
  easypanel-bd_owners`, ver `.github/workflows/deploy.yml:21`) es
  single-instance antes de asumir que esto no importa. No pude confirmar el
  `replica count` desde este repo.
- Reconexión: `EventSource` reconecta solo por spec (con backoff del propio
  browser) — el fallback real es que el FE, en `onerror`, deje de confiar en
  el stream y arranque el polling normal (`refetchInterval` gateado por
  `useDocumentVisible()`, molde exacto de `ipnext-frontend/src/hooks/useWhatsapp.ts:78-85`).
- **Riesgo de proxy**: EasyPanel corre detrás de Traefik (inferido del
  patrón `easypanel-bd_owners`, no confirmado el proxy exacto desde este
  repo) — hay proxies que bufferean la respuesta hasta que el connection
  handler termina o hasta juntar N KB, rompiendo SSE en la práctica aunque
  el código esté bien. Hay que probar en vivo temprano, no asumir que
  "HTTP plano" alcanza solo porque no hay TLS-termination propia complicada.

---

## 4. Config de umbrales

- Precedente exacto: `GestionRealIngestConfig` (`prisma/schema.prisma:2313-2329`)
  y `NocBroadcastConfig` (`prisma/schema.prisma:2335-2344`) — ambas son
  tablas singleton (`id: String @id @default("singleton")`), editables en
  runtime vía `PUT /config`, con un `*ConfigRepository` port +
  `Prisma*ConfigRepository`/`InMemory*ConfigRepository` + un
  `Get*Config`/`Update*Config` use-case pair. Mismo molde aplica 1:1 para
  `AlertThresholdsConfig` (o el nombre que se elija).
- Hoy los umbrales viven en `/etc/fibra_report.conf` en la VM 130
  (`CRIT_DBM/WARN_DBM/DELTA_ALERT/PON_MIN_ABON/PON_DELTA` — mencionados en
  el prompt del orquestador, no verificables desde este repo).
- **Pregunta abierta clave**: ¿quién es la fuente de verdad del umbral
  cuando hay DOS consumidores (el panel FE que lo edita, y el colector Rust
  que necesita el valor para decidir si algo es CRIT/WARN)?
  - Opción 1: el colector Rust lee el umbral del hub por API (`GET
    /api/alerts/thresholds` o similar) al arrancar / periódicamente, y el
    hub es la única fuente de verdad. Requiere que el colector tenga
    lógica de refresco/caché local (¿qué hace si el hub está caído?).
  - Opción 2: el colector Rust decide localmente con su propio config
    (archivo o env), y el hub solo usa el umbral para SU PROPIA UI (mostrar
    contra qué se comparó) sin ser la fuente operativa — el colector ya
    calculó CRIT/WARN antes de postear, el hub solo lo persiste y muestra.
    Más simple, pero el umbral queda duplicado en dos lugares (hub config
    editable + colector config real) — si se edita en el panel, no hace nada
    hasta que alguien también actualice el colector.
  - Para Grafana el problema es análogo: los 36 thresholds están en las
    reglas de Grafana (fuera de este repo); si el panel del hub permite
    "editar el umbral", ¿eso debería tocar la regla de Grafana vía su API, o
    es solo un umbral de VISUALIZACIÓN/filtrado del lado del hub,
    desconectado del umbral real que dispara la alerta en origen? Esto
    necesita una decisión explícita del usuario antes del proposal — sin
    ella cualquier diseño de "umbrales editables" es ambiguo.

---

## 5. Panel FE

- `MonitoringPage.tsx` (`ipnext-frontend/src/pages/monitoring/MonitoringPage.tsx`)
  es HOY un mapa de puntos lat/lng fijos al área de Buenos Aires
  (`toPixel`, líneas 31-42, con `latMin/latMax/lngMin/lngMax` hardcodeados)
  más una tabla de dispositivos y un panel lateral de alertas activas —
  device-céntrico de punta a punta. Las alertas de BGP/DDoS/rectificador NO
  tienen coordenadas ni son "dispositivos" en este modelo — este componente
  no es reusable tal cual para el hub, sirve como REFERENCIA de estilo
  (`Spinner`, `Can`, CSS Modules, `formatRelative`) pero no como base a
  extender.
- `NotificationsPage.tsx` (no leída en detalle, pero por el
  `NotificationRepository`/hooks es una lista simple de bandeja) tampoco
  tiene filtros de severidad/fuente/estado ni ACK — es la campana genérica,
  no el panel operacional.
- Hooks actuales (`ipnext-frontend/src/hooks/useMonitoring.ts`,
  `useNotifications.ts`): **NO pollean** — `staleTime: 30_000` sin
  `refetchInterval`. Confirmar esto es importante porque contradice una
  posible lectura de "ya hay polling maduro sobre estos dos" — lo maduro es
  el PATRÓN (`useWhatsapp.ts`), no su aplicación a monitoring/notifications.
- Permiso granular ya usado en FE: `<Can permission="monitoring.acknowledge_alert">`
  (`MonitoringPage.tsx:211`) — y el módulo/acción YA existen en el catálogo
  RBAC (`ipnext-backend/src/domain/entities/rbac.ts:41` acción
  `acknowledge_alert`, `:115` módulo `monitoring`). **Pero la ruta BE nunca
  aplica `requirePerm`** (ver sección 7) — el botón del FE se esconde bien,
  pero un usuario sin el permiso que llame `PUT /api/monitoring/alerts/:id/acknowledge`
  directo hoy lo consigue igual. Gap preexistente, no introducido por este
  change, pero el hub NO debería heredarlo — la nueva ruta de ACK debe
  llevar `requirePerm` desde el día 1.
- Recomendación de construcción: página nueva (`AlertsPage` o extender
  `MonitoringPage` con una sección nueva, a decidir en design) con filtros
  por fuente/severidad/estado (reusa el patrón `DataTable` genérico si
  existe uno — no confirmé un componente `DataTable` compartido en este
  research, el prompt lo asume; recomiendo verificarlo explícitamente en
  `sdd-design` antes de asumirlo) + `ConfirmModal` para ACK (mismo patrón
  que otros módulos con confirmación destructiva/irreversible).

---

## 6. Colector Rust (scope, repo aparte)

- No verificable desde este repo (vive en la VM 130 / scripts Python que no
  están en `ipnext-backend`/`ipnext-frontend`). Todo lo siguiente es lo que
  el prompt del orquestador ya estableció, sin nueva verificación de código:
  reemplaza `onu_signal_poll` (polling cada 30min → InfluxDB
  `onu_signal`), `fibra_report` (4x/día → Telegram con análisis por PON),
  el seed OCR/tesseract, y los vigías `noc_mtta`/`noc_unacked` (SLA de
  tickets).
- Contrato de salida: POST al hub (`/api/alerts/ingest/fiber-collector`,
  propuesto arriba), auth por shared-secret (mismo `apiKeyMiddleware`
  pattern, key propia).
- Deploy: binario único + systemd en la VM 130 (`10.75.0.40`), patrón
  push=deploy (igual al orchestrator RADIUS, según memoria del proyecto).
- Crates candidatas razonables dado el contrato (push HTTP + polling
  interno + parsing OCR): `reqwest` (cliente HTTP), `tokio` (runtime async),
  un cliente InfluxDB (`influxdb` o `influxdb2` crate, a evaluar contra la
  versión real del InfluxDB de la VM 130 — no verificada desde acá),
  bindings de `tesseract`/`leptonica` para el OCR (`leptess` es la opción
  más usada en el ecosistema Rust, pero requiere las libs nativas
  instaladas en el binario del sistema — punto de fricción de build/deploy).
- **Mayor riesgo/esfuerzo: el OCR.** Migrar un pipeline Python con
  tesseract/leptonica a Rust vía bindings FFI es sustancialmente más
  trabajo que el resto del colector (que es básicamente polling + parsing +
  HTTP POST) — aislar el OCR como su propia fase/milestone en el
  `sdd-tasks` en vez de tratarlo como "una tarea más" del colector.
- **BLOQUEANTE confirmado (no verificable desde este repo, tomado tal cual
  del contexto del usuario)**: la key SSH `ipnext_flows` de la VM 130 está
  perdida — sin ella no se puede ni desplegar ni probar el colector en vivo.
  Este bloqueante debe quedar como pre-requisito EXPLÍCITO en el proposal,
  no como una tarea más del backlog — bloquea todo el eje "fibra" del hub
  aunque el eje "Grafana" pueda avanzar en paralelo sin este problema.

---

## 7. Permisos, DTOs, migraciones

### Auth actual de las rutas existentes (verificado)

`app.ts:2174`:
```ts
app.use('/api/monitoring', createMonitoringRouter(getMonitoringStats, listMonitoringDevices, listMonitoringAlerts, acknowledgeAlert));
```
`app.ts:2176`:
```ts
app.use('/api/notifications', createNotificationsRouter(listNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification));
```
Ninguna de las dos líneas pasa `authAdapter` ni `requirePerm` — comparar con
`app.ts:2179` (`/api/news`), que SÍ lleva ambos y tiene un comentario
explícito: *"internal-news — /api/news carries auth + requirePerm on EVERY
route (design §6.1), a deliberate contrast with the unguarded
/api/notifications mount above."* — es decir, alguien YA notó y documentó
este gap para notifications, pero no lo corrigió (ni lo replicó a
monitoring, que tampoco lo tiene). `createMonitoringRouter` /
`createNotificationsRouter` (`monitoring.routes.ts:7-13`,
`notifications.routes.ts:7-13`) ni siquiera RECIBEN `authAdapter`/`requirePerm`
como parámetros — el gap es de firma, no solo de wiring.

### Permisos ya disponibles vs. nuevos necesarios

- `monitoring.read` / `monitoring.manage` / `monitoring.acknowledge_alert` ya
  existen en `KNOWN_ACTIONS`/`RBAC_MODULES` (`rbac.ts:19-98`, `:108-130`) y
  probablemente alcanzan para leer/ACK del hub SIN acción nueva.
- **Posible acción nueva a definir en proposal**: algo tipo
  `monitoring.manage_thresholds` (o un módulo `alerts` propio si se decide
  separar de `monitoring` — coherente con la Opción B de la sección 1, que
  ya propone una entidad `Alert` separada de `MonitoringAlert`) para
  gatear la edición de umbrales, distinto de leer/ACK.
- La ingesta (`POST /api/alerts/ingest/*`) es machine-to-machine —
  **no lleva RBAC de usuario**, va detrás de `apiKeyMiddleware` (o su
  variante por fuente), igual que `/api/external/v1`.

### DTOs

- Ningún use-case debe devolver la entidad Prisma cruda — molde ya
  establecido: `PrismaMonitoringRepository`/`PrismaNotificationRepository`
  ya mapean row→entidad de dominio antes de que el router haga `res.json()`.
  El hub debe seguir el mismo patrón: `Alert` (dominio) → `AlertDto`
  (aplicación) si hace falta ocultar campos internos (p. ej. el
  `fingerprint` crudo de Grafana quizás no necesite ir al FE tal cual).

### Migraciones

- Aditivas siempre: nueva tabla `Alert` (Opción B) + nueva tabla singleton
  `AlertThresholdsConfig` (sección 4) — ninguna toca columnas existentes de
  `MonitoringAlert`/`MonitoringDevice`/`Notification`. `npm run
  prisma:migrate`, nunca SQL a mano (regla del proyecto).

---

## Áreas afectadas (archivos concretos)

- `src/domain/entities/monitoring.ts`, `notification.ts` — leídos, NO se
  tocan (Opción B los deja intactos).
- `src/domain/ports/MonitoringRepository.ts`,
  `NotificationRepository.ts` — sin cambios.
- `src/infrastructure/adapters/prisma/PrismaMonitoringRepository.ts` —
  confirma el bug `resolvedAt` siempre null / `deviceName` siempre `''`
  (no se corrige acá, documentado para que el proposal decida si vale la
  pena arreglarlo al pasar o dejarlo como deuda conocida de un módulo que
  de todas formas queda dormido).
- `src/infrastructure/http/app.ts:511-524` (imports), `:1503-1535`
  (instanciación), `:2174-2178` (mount SIN auth) — punto exacto de wiring
  a extender con el nuevo router `/api/alerts`.
- `src/infrastructure/http/middleware/apiKeyMiddleware.ts` — molde a
  clonar/parametrizar para el auth de ingesta.
- `src/infrastructure/http/middleware/chatwootSignatureMiddleware.ts` +
  `rawBodyJsonParser` — referencia de cómo se cablea una ruta con
  necesidades de raw body ANTES del `express.json()` global, por si
  Grafana eventualmente firma (HOOK-1/2 no aplica hoy, pero el molde
  serviría si se agrega HMAC más adelante).
- `src/domain/ports/WebhookDeliveryRepository.ts` — evaluar si se reusa
  para trazabilidad de deliveries crudas (abierto, sección 2).
- `src/application/use-cases/nocBroadcast/*`,
  `src/infrastructure/adapters/evolution/EvolutionApiHttpGateway.ts` —
  candidato a reusar para reemplazar el `grafana-wa-relay` roto (hipótesis
  a confirmar con el usuario).
- `ipnext-frontend/src/pages/monitoring/MonitoringPage.tsx`,
  `ipnext-frontend/src/hooks/useMonitoring.ts`,
  `ipnext-frontend/src/pages/notifications/NotificationsPage.tsx`,
  `ipnext-frontend/src/hooks/useNotifications.ts` — referencia de estilo,
  no base de extensión directa (sección 5).
- `ipnext-frontend/src/hooks/useWhatsapp.ts:78-85`,
  `ipnext-frontend/src/hooks/useDocumentVisible.ts` — molde exacto del
  fallback de polling gateado por visibilidad.
- `prisma/schema.prisma:2313-2344` (`GestionRealIngestConfig`,
  `NocBroadcastConfig`) — molde de tabla singleton para umbrales.
- `src/domain/entities/rbac.ts:19-98,108-130` — catálogo de acciones/módulos
  RBAC, ya tiene `monitoring.read/manage/acknowledge_alert`.

---

## Preguntas abiertas (necesitan decisión del usuario antes del proposal)

1. **Fuente de verdad del umbral** (sección 4): ¿el hub manda sobre Grafana/
   colector Rust (push de config hacia afuera), o el hub solo VISUALIZA el
   umbral que cada fuente ya trae consigo (sin poder editarlo de forma
   operativa real)? Esto cambia completamente el alcance de "panel con
   umbrales editables".
2. **¿El hub reemplaza el envío a Telegram/WhatsApp, o corre EN PARALELO**
   mientras se valida? Doble emisión Grafana→hub y Grafana→Telegram/WhatsApp
   simultánea durante la transición es probablemente deseable (no cortar el
   canal actual de golpe), pero hay que decidir por cuánto tiempo y quién
   apaga el contact-point viejo.
3. **¿Se reusa `NocBroadcastGateway`/`EvolutionApiHttpGateway` para el envío
   WhatsApp del hub** (reemplazando el `grafana-wa-relay` roto), o se
   levanta un canal WhatsApp nuevo? Depende de confirmar si es la misma
   instancia Evolution — no verificable desde este repo.
4. **Retención de datos**: ¿cuánto tiempo vive una alerta `resolved` en la
   tabla `Alert` antes de purgarse? ¿Y la retención de InfluxDB para
   `onu_signal` — el colector Rust sigue escribiendo ahí en paralelo al
   hub, o el hub se vuelve la única base histórica?
5. **Alcance del "reconocer" (ACK) para alertas que vienen de Grafana**:
   ¿el ACK en el hub debería silenciar también la alerta en Grafana (vía su
   API) para no seguir recibiendo Telegram/WhatsApp duplicado mientras está
   reconocida acá, o quedan desacoplados (ACK solo local al hub)?
6. **Nombre del módulo/tabla nuevo**: ¿`Alert` a secas (podría confundirse
   con `MonitoringAlert` en el schema) o un nombre más específico tipo
   `NocAlert`/`OpsAlert` para dejar clara la separación? Sugerido para
   decidir en proposal, no bloqueante.

## Riesgos

- **SSE tras el proxy de EasyPanel**: no confirmado que no bufferee/corte
  streams largos — probar en vivo temprano (spike de 30 min) antes de
  comprometerse al diseño completo de reconexión.
- **Escalado horizontal silencioso**: el event-bus in-memory propuesto solo
  funciona correctamente en single-instance; si el deploy alguna vez escala
  a N réplicas, clientes conectados a instancias distintas de la que
  ingiere pierden eventos SIN error visible (degrada a "no llegó nada",
  silencioso). Confirmar replica count actual.
- **OCR en Rust**: mayor incertidumbre de esfuerzo de todo el change — el
  resto del colector es HTTP+polling+parsing directo, el OCR es FFI nativo.
- **Doble emisión Grafana→hub y Grafana→Telegram/WhatsApp**: alert fatigue
  si ambos canales quedan activos indefinidamente sin que nadie decida
  cuándo apagar el viejo.
- **Key SSH `ipnext_flows` perdida**: bloquea todo el eje fibra/Rust hasta
  reponerla — el eje Grafana puede avanzar independiente.
- **Gap de auth heredado**: si el hub cuelga sus rutas de usuario
  (`/api/alerts`, lectura/ACK) del mismo patrón sin auth que hoy tienen
  `/api/monitoring`/`/api/notifications`, hereda el gap de seguridad
  documentado en sección 7 — debe corregirse explícitamente en las rutas
  NUEVAS, no solo asumir el patrón existente porque "es lo que ya hay".
- **Confusión de nombres en el schema**: `Notification` +
  `MonitoringAlert` + `Alert` (nuevo) coexistiendo requiere documentación
  clara de por qué, o un futuro dev los leerá como duplicación accidental.

## Ready for Proposal

**Sí, con reservas.** El terreno del código está bien mapeado (scaffold
vacío confirmado, patrones de webhook/auth/config singleton identificados,
mismatch de `MonitoringAlert` cuantificado campo a campo). Pero las 6
preguntas abiertas de arriba —especialmente #1 (dueño del umbral), #2
(convivencia con Telegram/WhatsApp actual) y #3 (reuso de
NocBroadcastGateway)— cambian el alcance real del proposal según cómo se
respondan. Recomiendo que el orquestador se las presente al usuario ANTES
de lanzar `sdd-propose`, no dentro de él.
