# Design — suricata-tickets-mirror (espejo de tickets de Suricata Cx + veredicto del bot)

> Base: `proposal.md` (alcance, riesgos y out-of-scope ya cerrados). Este design NO re-litiga el
> proposal: decide DENTRO de él. Estilo D1..Dn citable, molde
> `archive/2026-09-02-external-bulk-messaging/design.md`.
> **Modo automático**: las 8 preguntas abiertas del proposal se cierran acá con decisión + razón.
> Lo único marcado para OK humano es **D5 (Playwright en la imagen de prod)**, por ser infra
> irreversible en el pipeline de deploy.

---

## D0 — Mapa del flujo

```
SuricataSyncScheduler (setInterval + unref)          molde EXACTO ChatMediaDownloadScheduler
  ├─ inFlight (sync, intra-proceso)
  ├─ flag 'suricata-sync-enabled'          (dark by default) → skip
  ├─ PgAdvisoryLock 'suricata-sync'        (cross-réplica)   → skip
  └─ SyncSuricataTickets (use case)
       por PÁGINA de la lista:  session.withSession(prio=LOW, fn)  ← suelta el mutex entre páginas
         scraper.listTickets(page) → upsert por externalId
         por ticket nuevo/actualizado: scraper.getTicket(id) → mensajes + adjuntos
           adjunto nuevo (por sha256) → context.request.get(url) → FileStorage.save('suricata/…')
       areas: scraper.listAreas() → upsert + areas ausentes → active=false (NUNCA delete)

POST /api/external/v1/suricata/tickets/:externalId/verdict   key dedicada + flag
  SubmitSuricataVerdict → 1 fila nueva en SuricataTicketVerdict (append-only, D9)

GET  /api/external/v1/suricata/tickets/:externalId/attachments/:id/content   MISMA key (D7)

GET  /api/suricata/tickets · /:id · /areas · /kpis        sesión + suricata.read
POST /api/suricata/tickets/:id/reply    sesión + suricata.reply + confirm token (D10)
  ReplyToSuricataTicket → session.withSession(prio=HIGH, fn) → replyPort.send(...)
                        → SuricataReplyAudit (intento + resultado, SIEMPRE)
PATCH /api/suricata/tickets/:id/assignee   sesión + suricata.manage   (Prominense-only, NO va a Suricata)
```

---

## D1 — Modelo de datos: 7 tablas nuevas, todo aditivo

```prisma
model SuricataArea {
  id         String   @id @default(uuid())
  externalId String   @unique          // id de área en Suricata
  name       String
  active     Boolean  @default(true)   // D6.c: desaparecer del catálogo ⇒ active=false, NUNCA delete
  syncedAt   DateTime
  tickets    SuricataTicket[]
}

model SuricataTicket {
  id             String    @id @default(uuid())
  externalId     String    @unique     // CLAVE DE IDEMPOTENCIA (D6.b)
  subject        String
  status         String                // string CRUDO de Suricata, sin normalizar (D1.a)
  priority       String?
  areaId         String?
  area           SuricataArea? @relation(fields: [areaId], references: [id], onDelete: SetNull)
  customerName   String?
  customerEmail  String?
  customerPhone  String?
  externalClientRef String?            // lo que Suricata muestre como id de cliente (D13.b)
  clientId       String?               // match LOCAL contra Client (nullable, best-effort)
  openedAt       DateTime?
  lastMessageAt  DateTime?
  assigneeId     String?               // RbacUser — SOLO Prominense (proposal: no se escribe a Suricata)
  assignee       RbacUser? @relation(fields: [assigneeId], references: [id], onDelete: SetNull)
  contentHash    String                // sha256 del render del ticket (D6.b) — corta upserts inútiles
  firstSyncedAt  DateTime  @default(now())
  syncedAt       DateTime
  messages       SuricataMessage[]
  attachments    SuricataAttachment[]
  verdicts       SuricataTicketVerdict[]
  replies        SuricataReplyAudit[]

  @@index([status, lastMessageAt])
  @@index([areaId])
  @@index([assigneeId])
  @@index([clientId])
}

model SuricataMessage {
  id          String   @id @default(uuid())
  ticketId    String
  ticket      SuricataTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  externalId  String   @unique          // idempotencia por mensaje
  author      String
  authorKind  String                    // 'customer' | 'agent' | 'system' | 'unknown'
  body        String
  sentAt      DateTime
  attachments SuricataAttachment[]
  @@index([ticketId, sentAt])
}

model SuricataAttachment {
  id          String   @id @default(uuid())
  ticketId    String
  ticket      SuricataTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  messageId   String?
  message     SuricataMessage? @relation(fields: [messageId], references: [id], onDelete: SetNull)
  externalRef String                     // url/id en Suricata
  fileName    String
  mimeType    String   @default("application/octet-stream")
  sizeBytes   Int?
  sha256      String?                    // null hasta bajarlo; dedup de contenido (D7.b)
  storageKey  String?                    // 'suricata/<sha256>' — null mientras status != 'stored'
  status      String   @default("pending") // pending | stored | failed
  attempts    Int      @default(0)         // tope 5, molde ChatMessageAttachment (MEDIA-3)
  lastError   String?
  @@unique([ticketId, externalRef])
  @@index([status, attempts])
}

model SuricataTicketVerdict {
  id                String   @id @default(uuid())
  ticketId          String
  ticket            SuricataTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  resuelto          Boolean
  analisis          String
  motivo            String?              // requerido si resuelto=false (regla en el use case)
  respuestaSugerida String?              // idem
  ticketContentHash String               // el contentHash del ticket AL MOMENTO del veredicto (D9)
  submittedBy       String               // login del actor máquina (api-suricata)
  createdAt         DateTime @default(now())
  @@index([ticketId, createdAt])
}

model SuricataReplyAudit {
  id          String   @id @default(uuid())
  ticketId    String
  ticket      SuricataTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  actorId     String                     // RbacUser que confirmó
  body        String                     // el texto EXACTO que se intentó enviar
  outcome     String                     // 'sent' | 'failed'
  error       String?
  attemptedAt DateTime @default(now())
  sentAt      DateTime?
  @@index([ticketId, attemptedAt])
}

model SuricataSyncRun {
  id            String   @id @default(uuid())
  startedAt     DateTime @default(now())
  finishedAt    DateTime?
  outcome       String   @default("running")  // running | ok | degraded | failed
  ticketsSeen   Int      @default(0)
  ticketsUpserted Int    @default(0)
  messagesUpserted Int   @default(0)
  attachmentsStored Int  @default(0)
  error         String?
  selectorMisses Json?                       // D6.d — qué selector no matcheó
  @@index([startedAt])
}
```

**D1.a — `status`/`priority` se guardan CRUDOS (string), no como enum.** Suricata es un sistema
ajeno sin contrato: un estado nuevo con un enum Prisma reventaría el sync entero en la escritura.
Con string, un valor desconocido entra y se ve en el panel. La normalización a los buckets del
filtro vive en el DTO (mapa explícito + fallback `'otro'`), no en la DB.

**D1.b — Migración**: UNA sola, `prisma/migrations/<ts>_suricata_tickets_mirror/migration.sql`,
generada SIN base de datos local (regla `WORKFLOW-MULTI-REPO.md` §Migraciones):

```
npx prisma migrate diff --from-schema-datamodel <schema en HEAD> \
                        --to-schema-datamodel prisma/schema.prisma --script
```

Al SQL se le APENDA a mano (el `diff` no emite DML): el seed RBAC de D2 y los 2 feature flags
(`suricata-sync-enabled`, `suricata-reply-enabled`, ambos `false`). **Sin `BEGIN`/`COMMIT`** —
Prisma envuelve cada migración en su propia transacción (regla explícita en
`20261028000000_iclass_gps_ingest_flag/migration.sql`). Los flags DEBEN nacer de la migración:
`SetFeatureFlag` hace `update`, no `upsert` → sin fila, la card del FE 404ea para siempre.

---

## D2 — `RbacModuleCode`: diff mínimo = 1 literal + 1 comentario + seed SQL

`RbacModuleCode` es `(typeof RBAC_MODULES)[number]` (`src/domain/entities/rbac.ts:121-211`). El
precedente exacto es `'store'` (`rbac.ts:202-208` + `prisma/migrations/20261106000000_store/migration.sql:89-129`).

```ts
// src/domain/entities/rbac.ts — última entrada del array, ANTES del `] as const`
  // suricata-tickets-mirror — espejo de los tickets de Suricata Cx + veredicto del bot.
  // Módulo PROPIO y no una sub-acción de `tickets` a propósito: `tickets` es el dominio
  // INTERNO de Prominense; esto es el espejo de un sistema ajeno, con una acción
  // (`reply`) que escribe hacia afuera, a un cliente real. Misma separación que
  // `assistant` vs `messaging`.
  'suricata',
```

**Corrección post-tasks (2026-09-11)**: esta sección decía originalmente "+ `send`, reusando el
precedente de `push`" — contradecía tanto el comentario del propio literal de arriba (que ya decía
`reply`) como el spec aprobado (`suricata-ticket-reply` REPLY-1 / `rbac-permission-catalog-extension`
RBAC-EXT-2), que exigen una acción **dedicada** `reply` con su propio escenario testeable. `sdd-tasks`
ya había resuelto las tareas A.2/A.4 siguiendo el spec; se corrige acá para que ambos artefactos
queden consistentes antes de `sdd-apply`.

Acciones: `read` y `manage` son base (no se agregan action codes) **+ `reply`**, acción NUEVA y
dedicada (NO se reusa `send`): gatea una escritura real e irreversible hacia un cliente externo vía
Suricata — un riesgo distinto al de mensajería interna, por eso el spec pide separación explícita.
Seed en la migración de D1.b, con la ESTRUCTURA del bloque `store`: `RbacModule` + 3
`RbacPermission` + grants. `ON CONFLICT DO NOTHING` en todo, como el molde.

El **alcance** de los grants NO se calca de `store` (corrección post-review, decisión de producto
confirmada por el usuario): `store.read` abre a los 6 roles porque lee un catálogo, mientras que un
ticket de Suricata trae nombre, teléfono y audios de **clientes reales**. Alcance correcto:

| Permiso | Roles |
|---|---|
| `suricata.read` | `super_admin`, `administrador`, `noc` |
| `suricata.manage` | `super_admin`, `administrador`, `noc` |
| `suricata.reply` | `super_admin`, `administrador` |

`noc` es el rol de atención de este sistema: de los 6 `SYSTEM_ROLES` no existe ningún
`soporte`/`agente`/`atencion_cliente`, y `noc` es el operador de mesa, explícitamente NO técnico de
campo (`TECHNICAL_ROLE_CODES` solo lista `tecnico`). Quedan fuera a propósito `tecnico` y `ventas`
(no atienden tickets) y `administracion` (Contabilidad).
El comentario del array es obligatorio: cada module code del repo tiene su justificación al lado.

---

## D3 — Ports nuevos (dominio ciego a Playwright, Prisma y MinIO)

| Port (`src/domain/ports/`) | Firma esencial | Adapter prod | Adapter test |
|---|---|---|---|
| `SuricataScraperPort` | `listAreas()` · `listTicketPage(n)` · `getTicket(externalId)` · `fetchAttachment(ref): {buffer, mimeType, fileName}` | `PlaywrightSuricataScraper` | `FakeSuricataScraper` (fixtures HTML-derivadas, D12) |
| `SuricataReplyPort` | `sendReply(externalId, body): Promise<void>` | `PlaywrightSuricataReply` | `FakeSuricataReply` |
| `SuricataTicketRepository` | `upsertByExternalId` · `findByExternalId` · `list(filters, page)` · `kpis()` · `setAssignee` | `PrismaSuricataTicketRepository` | `InMemorySuricataTicketRepository` |
| `SuricataMessageRepository` | `upsertManyByExternalId(ticketId, rows)` | Prisma | InMemory |
| `SuricataAttachmentRepository` | `upsertByExternalRef` · `listRetriable({maxAttempts})` · `markStored` · `markFailed` | Prisma | InMemory |
| `SuricataAreaRepository` | `upsertMany` · `deactivateMissing(seenIds)` · `list()` | Prisma | InMemory |
| `SuricataVerdictRepository` | `create` · `listByTicket` · `latestByTicket` | Prisma | InMemory |
| `SuricataReplyAuditRepository` | `record(attempt)` · `markOutcome` | Prisma | InMemory |
| `SuricataSyncRunRepository` | `start` · `finish` | Prisma | InMemory |
| `FileStorage` | **REUSO** (`domain/ports/FileStorage.ts`) | `MinioFileStorage` | `InMemoryFileStorage` |
| `DistributedLock` | **REUSO** (`domain/ports/DistributedLock.ts`) | `PgAdvisoryLock` | fake |
| `FeatureFlagRepository` | **REUSO** | Prisma | InMemory |

**D3.a — `AttachmentStoragePort` NO se crea.** `FileStorage` ya es exactamente eso
(`save`/`get`/`delete` por key, patrón BE-proxy, usado por task-photos y por chat-media). Un port
nuevo con la misma forma sería un sinónimo — y obligaría a un segundo adapter MinIO. Reuso directo,
aislado por prefijo de key (`suricata/`), igual que `messaging/` (`bootstrapChatMediaDownload.ts:38-41`).

**D3.b — Scraper y Reply son DOS ports, no uno.** Comparten la sesión (D4) pero no el riesgo:
`SuricataScraperPort` es read-only y lo consume un job; `SuricataReplyPort` escribe hacia un cliente
real y lo consume un request con RBAC y doble confirmación. Un port único haría imposible inyectar
el scraper sin arrastrar la capacidad de responder — el mismo criterio que dejó `deleteTemplate`
fuera del router externo en external-bulk-messaging (D4.f de aquel design).

**D3.c — Los use cases NO conocen el lock.** `SuricataSession` (infra) expone
`withSession<T>(opts, fn)`; el adapter Playwright ya entra serializado. Los ports que ve el dominio
no tienen ni `lock` ni `priority` en su firma: la serialización es un detalle del adapter, no del
contrato de negocio.

---

## D4 — Sesión Playwright compartida: mutex con prioridad + advisory lock (cierra Q1)

```ts
// infrastructure/adapters/suricata/SuricataSession.ts
type Priority = 'high' | 'low';        // high = reply (humano esperando) · low = sync
withSession<T>(opts: { priority: Priority; timeoutMs: number }, fn: (ctx: BrowserContext) => Promise<T>): Promise<T>
```

**Elección — DOS candados, como `CampaignRunner`:**

1. **Mutex in-process con cola de 2 niveles** (`high` se encola delante de `low`). Check+push
   SÍNCRONO antes del primer `await`, molde `CampaignRunner.heldInProcess`
   (`CampaignRunner.ts:61-66`). Es el candado que REALMENTE serializa: un solo container.
2. **`PgAdvisoryLock` key `'suricata-session'`** por encima, molde
   `ChatMediaDownloadScheduler.ts:80-84`.

**Por qué los dos y no uno solo.** El advisory lock de sesión es **re-entrante**: `PgAdvisoryLock`
usa UNA sesión pg de por vida, así que `pg_try_advisory_lock` devuelve `true` otra vez para el mismo
proceso (`PgAdvisoryLock.ts:35`, incidente FIX-3 de doble envío ya documentado). Solo con el
advisory lock, sync y reply del MISMO container pasarían ambos → doble login, que es exactamente lo
que el proposal pide evitar. Y solo con el mutex, un container de migración o una segunda réplica
futura loguearía en paralelo. **Sobre el lock huérfano tras un restart mid-request: no existe.** Los
advisory locks de *sesión* se liberan solos cuando la conexión pg muere, y el mutex in-process muere
con el proceso. Ese es el argumento decisivo contra la alternativa **rechazada** — una tabla
`SuricataSessionLock` con `heldUntil`: requeriría heartbeat, TTL, reaper y un caso "lock vencido pero
el dueño sigue vivo" que ninguno de los otros dos tiene.

**Qué pasa si llega un "Responder" mientras el sync corre (la pregunta del proposal):
el reply ESPERA en cola, pero la espera está acotada por diseño.** El sync **no toma la sesión para
toda la corrida**: la toma y la suelta **por unidad de trabajo** (una página de la lista, un ticket
de detalle, un adjunto). Entonces un reply `high` se ejecuta a lo sumo después de la unidad en
curso — segundos, no la corrida entera. Alternativas rechazadas: (a) *pausar/abortar el sync* —
dejaría el scraper a medio DOM y obligaría a lógica de reanudación frágil para ahorrar segundos;
(b) *rechazar con 409 directo* — el reply es una acción humana deliberada detrás de doble
confirmación; hacerla fallar porque un job de fondo está corriendo es hostil y empuja al operador a
reintentar a ciegas.

`timeoutMs`: reply **20 000** (config `SURICATA_REPLY_QUEUE_TIMEOUT_MS`), sync `5 000` (si no la
consigue, el tick se saltea — es idempotente y vuelve). Timeout vencido → `SuricataSessionBusyError`
→ **503 `SURICATA_SESSION_BUSY`** + header `Retry-After: 30`. Nunca 500: el pedido es válido, el
recurso está ocupado.

**Re-login y cookie expirada (cierra Q1).** `withSession` llama primero a `ensureAuthenticated()`
**dentro** del mutex: navega a una ruta autenticada barata y clasifica por marcador de DOM
(formulario de login / redirect a `/login`) → si no está autenticado, hace login **una vez** y
reintenta la operación **una vez**. Segundo fallo → `SuricataAuthError`: el sync marca la corrida
`failed` con `error` y el reply devuelve **502 `SURICATA_UNAVAILABLE`** sin escribir nada en
Suricata. El `BrowserContext` se reusa entre operaciones (la cookie vive ahí); se descarta y se
recrea solo en el re-login, para no arrastrar un contexto envenenado. **Cero reintentos ciegos en
loop**: dos intentos y se rinde ruidosamente — una cuenta ajena bloqueada por martilleo de logins es
un daño peor que un sync saltado.

---

## D5 — ⚠️ RIESGO ALTO — Playwright en el runtime de producción (cierra Q de infra)

**El hecho verificado**: `Dockerfile` usa `node:20-alpine` en builder **y** en runtime, y
`.github/workflows/deploy.yml` levanta UN container (`ipnext-new-backend`) en la red `ipnext-net`.
**Playwright no publica binarios de Chromium para Alpine/musl** — instalar `playwright` en esta
imagen tal cual NO funciona, no es cuestión de tamaño.

**Recomendación: C — browser en un SIDECAR, `playwright-core` en el backend.**

| Opción | Impacto | Veredicto |
|---|---|---|
| A. Runtime `mcr.microsoft.com/playwright:vX-noble` | imagen BE de ~150 MB → ~2 GB; build y deploy minutos más lentos; se abandona Alpine para TODO el backend | Rechazada: un panel paga con el tiempo de deploy de todo el sistema |
| B. Runtime `node:20-bookworm-slim` + `playwright install --with-deps chromium` | +~700 MB, cambio de base image de prod, `apt` en el build | Rechazada por lo mismo, en menor grado |
| **C. Sidecar `mcr.microsoft.com/playwright:vX-noble` corriendo `npx playwright run-server`; el BE usa `playwright-core` + `chromium.connect(ws)`** | **imagen BE SIN CAMBIOS** (sigue Alpine; `playwright-core` no baja browsers al `npm ci`); crash del browser no tumba el BE; memoria acotada por `--memory` del sidecar | **Elegida** |

Concreto:

- `package.json`: `"playwright-core": "1.XX.Y"` — **versión EXACTA, sin `^`**. El protocolo
  cliente↔`run-server` no es estable entre minors: el tag del sidecar
  (`mcr.microsoft.com/playwright:v1.XX.Y-noble`) y esta versión **deben coincidir literalmente**.
  Un test de composición asserta esa igualdad leyendo `package.json` y `deploy.yml`.
- `deploy.yml`, step nuevo **antes** de "Deploy container":

  ```
  docker rm -f ipnext-playwright 2>/dev/null || true
  docker run -d --name ipnext-playwright --network ipnext-net --network-alias playwright \
    --restart unless-stopped --memory 1g --shm-size 1g --init \
    mcr.microsoft.com/playwright:v1.XX.Y-noble \
    npx -y playwright@1.XX.Y run-server --port 3000 --host 0.0.0.0
  ```

  `--shm-size 1g` **no es opcional**: el default de Docker (64 MB) hace que Chromium muera con
  pestañas grandes. `--init` evita zombies de los procesos del browser. El puerto **no se publica**
  al host: solo se alcanza por `ipnext-net`, así que el `run-server` (que no tiene auth) no queda
  expuesto. `--no-sandbox` **no hace falta** en la imagen oficial (trae el usuario y las capacidades
  correctas); si se forzara el fallback B sí haría falta, y ahí conviene `--cap-add=SYS_ADMIN` antes
  que apagar el sandbox.
- BE: `-e SURICATA_BROWSER_WS="ws://playwright:3000/"`. **Vacío ⇒ feature apagada**, sin tirar al
  boot (mismo opt-in lazy que `MinioFileStorage`, `MinioFileStorage.ts:72-85`).
- Adjuntos: se bajan con `context.request.get(url)` (APIRequestContext, hereda la cookie de la
  sesión) — funciona contra un browser REMOTO y devuelve el body por el wire, a diferencia de la API
  de `download` que asume filesystem local.

> **PARA EL ORQUESTADOR / OK HUMANO**: este punto agrega un container nuevo y permanente al deploy
> de producción y un step nuevo en `deploy.yml`. `sdd-apply` **no debe tocar `deploy.yml`** hasta
> confirmación explícita. El código del BE (adapter + config opt-in) se puede implementar y mergear
> antes: con `SURICATA_BROWSER_WS` vacío queda inerte.

---

## D6 — Sync: paginación, backfill, idempotencia, áreas y DOM roto (cierra Q2, Q3, Q4)

**D6.a — Backfill acotado y explícito.** `SURICATA_BACKFILL_DAYS` (default **90**) más
`SURICATA_MAX_PAGES_PER_RUN` (default **20**). El barrido recorre la lista ordenada por actividad
descendente y **corta** cuando una página entera cae fuera de la ventana o se agota el tope de
páginas. Rechazado "importar todo el histórico": un scrape sin techo contra un sistema ajeno es un
incidente esperando; y el dataset que la feature necesita es el reciente. El histórico profundo se
consigue subiendo la env y dejando correr, sin código nuevo.

**D6.b — Idempotencia por `externalId` + `contentHash`.** `externalId` es `@unique` en ticket y
mensaje: todo es `upsert`, nunca `create`. Además el ticket lleva `contentHash` = sha256 del render
canónico (subject|status|priority|area|lastMessageAt|nº de mensajes); si el hash no cambió, **no se
abre el detalle** — es lo que hace que la corrida N+1 cueste una fracción de la primera. Reintentos:
la corrida entera no reintenta; cada ticket que falla se aísla (`try/catch` por fila, molde
`ChatMediaDownloadScheduler.ts:92-100`) y la próxima pasada lo reintenta. Los adjuntos sí tienen
`attempts` con tope **5** (molde MEDIA-3): pasado el tope, `status='failed'` y se abandonan — sin
loop infinito.

**D6.c — Áreas: refresh completo con baja lógica.** `upsertMany(seen)` + `deactivateMissing(seen)`
→ `active=false`. **Jamás `delete`**: la FK `SuricataTicket.areaId` es `onDelete: SetNull`, y borrar
un área dejaría tickets históricos sin área, corrompiendo la KPI por área retroactivamente. Un área
inactiva no aparece en el filtro pero sí se muestra en el detalle de los tickets viejos. Rechazado
el sync incremental: el catálogo son decenas de filas, un full refresh cuesta una página.

**D6.d — DOM roto: falla RUIDOSA, nunca silenciosa.** Todos los selectores viven en UN archivo,
`infrastructure/adapters/suricata/selectors.ts`, como constantes nombradas. El scraper aplica dos
invariantes duras por corrida:
1. la página 1 de la lista debe producir **≥ 1 ticket**; 0 tickets con HTTP 200 = selector roto, no
   "no hay tickets";
2. todo campo obligatorio ausente (subject, fecha) suma una entrada a `selectorMisses`.

`selectorMisses` no vacío ⇒ `outcome='degraded'`; invariante 1 rota ⇒ `outcome='failed'` y **la
corrida no escribe nada** (no se persisten upserts parciales de una lectura que ya sabemos mala).
Ambos casos emiten el log `[suricata-sync] ERROR/DEGRADED` y quedan en `SuricataSyncRun`, que el
panel expone en la tira de KPIs ("último sync: hace X · estado"). Alertado por Telegram **no** se
agrega acá: el repo ya tiene alerting propio y sumarle un canal nuevo es otra feature —
declarado como deuda en D15.

---

## D7 — Adjuntos: MinIO con prefijo `suricata/`, dedup por sha256 (cierra Q5)

**D7.a — Storage**: `MinioFileStorage` ya existente, **mismo bucket**, prefijo de key
`suricata/<sha256>` — exactamente el aislamiento lógico que usa `messaging/`
(`bootstrapChatMediaDownload.ts:38-41`). Cero adapter nuevo, cero bucket nuevo, cero env nueva.

**D7.b — Dedup por contenido**: la key ES el sha256 del buffer, así que el mismo archivo adjunto en
N tickets ocupa una sola vez; `save` es idempotente. **Retención**: ninguna automática. Borrar el
adjunto de un ticket de soporte sin una política de negocio escrita sería destruir evidencia; lo que
sí se acota es la ENTRADA — `SURICATA_MAX_ATTACHMENT_BYTES` (default **10 MB**): por encima, la fila
queda `status='failed'`, `lastError='too_large'`, con metadata visible y sin bytes. Rechazado un TTL:
una purga automática sobre datos de clientes es una decisión de negocio, no de diseño técnico.

**D7.c — Descarga externa: la MISMA key del veredicto, no una separada.** Es el mismo consumidor
(el bot) en el mismo flujo (leer el ticket para dictaminarlo). Una segunda key duplicaría la
rotación y el secreto sin reducir el alcance de nada — el que puede dictaminar ya puede leer.
Ruta `GET /api/external/v1/suricata/tickets/:externalId/attachments/:attachmentId/content`, dentro
del **mismo router y mismo mount** que el veredicto, con el mismo flag. El BE hace de proxy
(`FileStorage.get` → `res.type(mimeType).send(buffer)`), el bucket sigue privado, **no se emiten URLs
firmadas**. El `attachmentId` se valida contra el `externalId` del path: un id de otro ticket → 404,
nunca 200. El panel interno consume la ruta espejo bajo sesión + `suricata.read`.

---

## D8 — Wiring HTTP: `composeSuricataModule` — 3 líneas en `app.ts` (cierra Q del God Object)

`app.ts` tiene 3326 líneas y varias sesiones trabajándolo en paralelo. El patrón del repo para esto
ya existe y es explícito: `composeAlertsModule` / `composeAssistantModule`
(`app.ts:3275-3284`) — *"Heavy wiring vive en composeAlertsModule (evita inflar este God Object)"*.

```ts
// app.ts:807 (zona de imports, junto a composeAssistantModule)
import { composeSuricataModule } from './composeSuricataModule';

// app.ts, INMEDIATAMENTE DESPUÉS del mount de '/api/assistant' (L3284) — bloque CONTIGUO
// ─── suricata-tickets-mirror — panel interno (espejo read-only + reply guardado) ───
app.use('/api/suricata', composeSuricataModule({ authAdapter, sessionRepo, requirePerm }));
// [suricata-internal-mount-end]

// app.ts, junto al bloque external-bulk (~L3704), ANTES del mount global de L3982
// ⚠️ ORDEN LOAD-BEARING: si va DESPUÉS, la key GLOBAL intercepta /suricata/* y la dedicada
// nunca se evalúa (mismo incidente que external-bulk, comentario de L3679).
app.use('/api/external/v1/suricata',
  createApiKeyMiddleware(config.suricata.externalApiKey),
  machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN),
  composeSuricataExternalModule({ ... }));
// [suricata-external-mount-end]
```

Total en `app.ts`: **1 import + 2 mounts + comentarios ≈ 12 líneas**, en dos bloques contiguos, cada
uno cerrado por un marcador. Todo lo demás (repos, use cases, router, storage) vive en
`composeSuricataModule.ts` / `composeSuricataExternalModule.ts`, archivos NUEVOS que ninguna otra
sesión toca ⇒ colisión de merge reducida a dos líneas de mount. Los marcadores acotan la ventana del
test de composición que lee el FUENTE de `app.ts` y asserta el orden relativo respecto de
`'/api/external/v1'` (molde `external-bulk-messaging-composition.test.ts`).
**Recomendación de entrega**: mergear el slice del wiring PRIMERO y vacío (routers que devuelven
501), para tomar las líneas de `app.ts` antes que otra sesión.

---

## D9 — Veredicto: append-only, invalidado por contenido (cierra Q6)

**Elección: historial, no fila única.** Cada `POST …/verdict` crea una fila nueva; `latestByTicket`
manda en el panel y en las KPIs. El dataset que esta feature existe para producir es justamente
"cómo cambió el criterio del bot" — un `upsert` que pisa borraría la medición.

**Qué invalida un veredicto**: se congela `ticketContentHash` al emitirlo. Si el `contentHash`
actual del ticket difiere, el veredicto se marca **`stale`** (campo DERIVADO, no columna) en el DTO
y en el panel ("hay mensajes nuevos desde este análisis"). **No se borra ni se oculta**: la
observación fue válida para ese estado. Las KPIs de "% resuelto por el bot" cuentan solo veredictos
no-stale; el panel muestra el conteo de stale aparte — un número que mezcla ambos no significa nada.

**Validación** (regla de negocio, en el use case, NO en la route):
`resuelto === false` sin `motivo` **o** sin `respuestaSugerida` → `InvalidSuricataVerdictError` →
**422 `VALIDATION_ERROR`** con la lista de campos faltantes. Body parseado con `parseOr400`
(zod `safeParse`, **nunca `.parse()`**: un `ZodError` sin mapear en el `errorHandler` es un 500 —
lección ya pagada en este repo).

---

## D10 — Responder: doble confirmación real + auditoría del intento (cierra Q8)

La "doble confirmación" NO puede ser solo un modal del FE — un modal no es un control del servidor.
Contrato: `POST /api/suricata/tickets/:id/reply` con body `{ body: string, confirm: string }`, donde
`confirm` es el **sha256 de `body`** calculado por el cliente. El BE recalcula y compara; distinto →
**400 `REPLY_CONFIRMATION_MISMATCH`**, sin enviar nada. Así el segundo paso del FE confirma
**exactamente el texto que se va a enviar**, y un click accidental sobre un payload viejo o mutado
no puede disparar un envío. Gate RBAC `suricata.reply` + flag `suricata-reply-enabled`.

**Auditoría del INTENTO, no del éxito**: la fila `SuricataReplyAudit` se escribe **antes** de tomar
la sesión, con `outcome='failed'` provisorio; al volver se hace `markOutcome('sent', sentAt)` o se
deja `failed` con el `error`. Si se escribiera después, un crash a mitad del envío dejaría un mensaje
en el cliente **sin ningún rastro local** — el peor estado posible para una acción irreversible.
El error de envío sube como **502 `SURICATA_UNAVAILABLE`** con el `replyAuditId` en el body, para que
el operador pueda mirar el intento y decidir; **el BE no reintenta solo** (un reintento automático es
un doble mensaje a un cliente real).

---

## D11 — Config / env / deploy

```ts
// infrastructure/config.ts — junto a `externalMessaging`, MISMO patrón opt-in (NO en REQUIRED_VARS)
suricata: {
  baseUrl:        process.env.SURICATA_BASE_URL ?? '',
  user:           process.env.SURICATA_USER ?? '',
  password:       process.env.SURICATA_PASSWORD ?? '',
  browserWs:      process.env.SURICATA_BROWSER_WS ?? '',        // vacío ⇒ feature inerte (D5)
  externalApiKey: process.env.SURICATA_EXTERNAL_API_KEY ?? '',  // vacía ⇒ 401 fail-closed
  syncIntervalMs: Number(process.env.SURICATA_SYNC_INTERVAL_MS ?? 900_000),   // 15 min, mínimo 60s
  backfillDays:   Number(process.env.SURICATA_BACKFILL_DAYS ?? 90),
  maxPagesPerRun: Number(process.env.SURICATA_MAX_PAGES_PER_RUN ?? 20),
  replyQueueTimeoutMs: Number(process.env.SURICATA_REPLY_QUEUE_TIMEOUT_MS ?? 20_000),
  maxAttachmentBytes:  Number(process.env.SURICATA_MAX_ATTACHMENT_BYTES ?? 10 * 1024 * 1024),
},
```

Ninguna en `REQUIRED_VARS` (misma DEVIATION documentada para `alerts.grafanaIngestKey`): sumar
fail-fast mataría todo deploy actual. `env.example` + `gh secret set` + las líneas `-e` en
`deploy.yml` junto a L120. `bootstrapSuricataSync` devuelve `null` si falta `SURICATA_BASE_URL` o
`SURICATA_BROWSER_WS` (molde `bootstrapChatMediaDownload.ts:30-33`) y se invoca desde `main.ts`
junto al resto de los bootstraps. Usuario máquina `api-suricata` vía `bootstrapMachineUser`
(el generalizado por external-bulk-messaging) — **no** por seed SQL: el `passwordHash` es un bcrypt
y un hash literal en git es un secreto versionado.

---

## D12 — Testing (TDD estricto: red → green → refactor)

| Capa | Qué | Cómo |
|---|---|---|
| Unit puro | `SuricataSessionMutex` | `high` adelanta a `low` encolado; FIFO dentro del mismo nivel; timeout ⇒ `SuricataSessionBusyError`; el mutex se libera aunque `fn` tire |
| Unit puro | `contentHash` | mismo ticket ⇒ mismo hash; un mensaje nuevo ⇒ hash distinto; orden de mensajes irrelevante |
| Unit puro | parser de HTML del scraper | fixtures HTML **capturadas del Suricata real** (una lista, un detalle con adjunto, una lista VACÍA, una lista con el DOM cambiado) — regla del repo: fixture producible, no plausible |
| Use case | `SyncSuricataTickets` | `FakeSuricataScraper` + repos InMemory + `InMemoryFileStorage`: 2 corridas ⇒ mismos conteos (idempotencia); un ticket que tira no corta el barrido; lista vacía ⇒ `failed` y CERO escrituras (D6.d) |
| Use case | áreas | área que desaparece ⇒ `active=false` y el ticket viejo conserva su `areaId` |
| Use case | `SubmitSuricataVerdict` | `resuelto=false` sin `motivo` ⇒ error tipado; 2 submits ⇒ 2 filas; `latestByTicket` devuelve el último |
| Use case | `ReplyToSuricataTicket` | `confirm` mal ⇒ NO se invoca `SuricataReplyPort` (spy); port que tira ⇒ audit `failed` + error propagado; éxito ⇒ audit `sent` con `sentAt` |
| Route | externa | key global ⇒ 401 · key dedicada ⇒ pasa · flag OFF ⇒ 403 · body basura ⇒ 400 (no 500) · adjunto de OTRO ticket ⇒ 404 |
| Route | interna | supertest + repos in-memory: cada filtro (status/priority/area/bot state) y las KPIs contra datos sembrados, con la **aritmética calculada a mano** en el test |
| Adapter | `PrismaSuricataTicketRepository` | paridad campo-a-campo con el InMemory (mismo caso, mismo número) |
| Composición | `app.ts` | índice del mount externo `<` índice de `'/api/external/v1'`, leyendo el FUENTE |
| Composición | versión Playwright | `playwright-core` de `package.json` === tag del sidecar en `deploy.yml`, exacto y sin `^` (D5) |

**Prohibido mockear Prisma**: todo use case se testea contra el port in-memory (regla del repo).
**Prohibido testear contra el Suricata real** en la suite: los ports tienen fake; el único contacto
con el sistema vivo es el smoke manual de D14.

---

## Threat Matrix

| Boundary | Aplicabilidad | Respuesta |
|---|---|---|
| Documentation-like paths | **N/A** — el change no clasifica ni ejecuta archivos por nombre/extensión |
| Git repository selection | **N/A** — no hay automatización de VCS |
| Commit state | **N/A** — idem |
| Push state | **N/A** — idem |
| PR commands | **N/A** — idem |

Las filas del molde son de automatización VCS/shell y no aplican. El único límite de proceso real
que abre este change es el **browser remoto (D5)**, cubierto explícitamente: el `run-server` no
publica puerto al host (solo `ipnext-net`), el BE **no ejecuta shell ni compone comandos con input
del usuario**, y la única entrada de usuario que llega al browser es el texto de la respuesta, que
se escribe con la API de Playwright (`fill`/`type`), **nunca vía `page.evaluate` con
interpolación** — regla de diseño, con test de que el texto sale literal.

---

## D13 — Wire contract y FE (repo `ipnext-frontend`, cambio coordinado)

```ts
// EXTERNA — header X-API-Key (key dedicada) — POST …/suricata/tickets/:externalId/verdict
Req  { resuelto: boolean; analisis: string; motivo?: string; respuestaSugerida?: string }
201  { verdictId: string; ticketExternalId: string; createdAt: string }
422  { error; code:'VALIDATION_ERROR'; missingFields: string[] }   // resuelto=false incompleto
404  { code:'TICKET_NOT_FOUND' } · 403 FEATURE_DISABLED · 401 UNAUTHORIZED
// GET …/suricata/tickets  ·  GET …/suricata/tickets/:externalId   (lectura para el bot)
// GET …/suricata/tickets/:externalId/attachments/:id/content → bytes + Content-Type (D7.c)

// INTERNA (sesión) — GET /api/suricata/tickets?status&priority&areaId&botState&assigneeId&page
botState: 'sin_analizar' | 'resuelto_bot' | 'requiere_humano' | 'stale'
// GET /api/suricata/kpis → { total, sincronizados, sinAnalizar, resueltoBotPct, staleCount,
//                            lastSync: { at, outcome } }
// POST /api/suricata/tickets/:id/reply  { body, confirm }  → 202 { replyAuditId } | 400 | 502 | 503
// PATCH /api/suricata/tickets/:id/assignee { assigneeId: string | null }
```

**D13.a — FE**: `ipnext-frontend/src/pages/suricata/` (CSS Modules, molde de la página de tickets
internos). Lista + filtros + detalle con 3 tabs + tira de KPIs, según el mockup aprobado. Tipos
espejo campo-a-campo del DTO; la validación en cliente es UX, la autoridad es el BE. El botón
Responder pide confirmación mostrando el texto final y manda su sha256 (D10); sin `suricata.reply` el
botón se ve **deshabilitado, no oculto** (convención del repo).

**D13.b — Tab "Client Data" (cierra Q7)**: muestra **lo que Suricata ya dio** (nombre, email,
teléfono, ref externa) y, **si `clientId` matcheó**, un bloque de Prominense: contrato/servicio,
estado y un link al cliente. Sin match: cartel "sin cliente vinculado en Prominense" + los datos
crudos. **No** se agrega búsqueda ni vinculación manual en este change — el tab es de lectura, y
vincular a mano es una feature con su propia auditoría. El match se intenta por email y por teléfono
normalizado, en ese orden, **solo con coincidencia exacta y única**: 0 o 2+ candidatos ⇒ `null`.
Un match por nombre está explícitamente descartado (mide mal y este caso no tiene ground truth).

---

## D14 — Rollout y rollback

1. **Slice 0 — wiring vacío**: mounts en `app.ts` + módulos compose devolviendo 501. Toma las líneas
   del God Object antes que otra sesión (D8).
2. **Deploy DARK**: migración aplicada, ambos flags `false`, `SURICATA_*` sin setear ⇒ triple
   apagado (flag OFF, key vacía ⇒ 401, `browserWs` vacío ⇒ scheduler `null`).
3. Sidecar Playwright + secrets + redeploy (**previo OK humano de D5**).
4. Flip de `suricata-sync-enabled` desde la UI de flags. Verificar `SuricataSyncRun`: `outcome='ok'`,
   conteos razonables, adjuntos que abren desde el panel.
5. Con eso verde, flip de `suricata-reply-enabled` y **smoke con UN ticket real elegido a dedo**:
   confirmar que la respuesta aparece en la conversación de Suricata y que el audit dice `sent`.

**Rollback** por orden de rapidez: flags OFF (instantáneo) → `docker rm -f ipnext-playwright` (el BE
sigue vivo, el sync degrada) → revert de los 2 mounts de `app.ts`. Las 7 tablas son aditivas: quedan
inertes, sin migración inversa. **Lo único irreversible son las respuestas ya enviadas** — por eso
el reply es el último flag en prenderse.

---

## D15 — Riesgos y deuda declarada

| Riesgo | Estado |
|---|---|
| **Playwright en el runtime de prod** | **ALTO — requiere OK humano (D5)**. Mitigado por sidecar: imagen del BE sin cambios, crash aislado, memoria acotada. `deploy.yml` NO se toca hasta la confirmación |
| Suricata cambia el DOM | Selectores en UN archivo + 2 invariantes duras + `SuricataSyncRun.outcome` visible en las KPIs (D6.d). Falla ruidosa y sin escrituras parciales |
| Login concurrente / cuenta bloqueada | Mutex + advisory lock (D4) + máximo 2 intentos de auth por operación. Sin reintento en loop |
| Respuesta enviada por error a un cliente real | RBAC `suricata.reply` + flag + confirmación por hash del texto (D10) + audit del INTENTO. **Irreversible por definición**: ningún control lo deshace |
| `app.ts` God Object | Le sumamos ~12 líneas en 2 bloques con marcador; el peso vive en `composeSuricataModule`. **Mitigado, no resuelto** (deuda pre-existente) |
| Crecimiento de adjuntos / PII | Dedup por sha256 + tope de 10 MB por archivo + bucket privado con proxy autenticado. **Sin retención automática — deuda declarada**: borrar evidencia de soporte necesita política de negocio |
| Alerta proactiva del sync roto | **No se agrega canal nuevo** en este change: queda en `SuricataSyncRun` + panel + log. Deuda declarada |
| Match `clientId` best-effort | Exacto y único por email/teléfono; nunca por nombre. Un ticket sin match es normal, no un bug |
| Mismatch de versión `playwright-core` ↔ sidecar | Pineado por test de composición (D12). Sin `^` en `package.json` |

## Open Questions

Ninguna técnica: las 8 del proposal quedaron cerradas (Q1→D4, Q2→D6.c, Q3→D6.a/b, Q4→D6.d,
Q5→D7, Q6→D9, Q7→D13.b, Q8→D10).
**Una decisión de infra espera OK humano**: D5 — agregar el container sidecar de Playwright y su
step en `.github/workflows/deploy.yml`. Todo el resto puede implementarse y mergear en dark antes de
esa confirmación.
