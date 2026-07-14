# Design — messaging-bulk (F2: envío masivo por template WhatsApp)

**Change**: messaging-bulk · **Phase**: design · **Project**: ipnext-backend
**Reads**: `proposal.md`, `explore.md`, engram `sdd/messaging-bulk/{proposal,spike-sendpath,state}`
**Status**: diseño técnico completo. Send-path LOCKED = **Twilio Content directo** (flip del Camino A del proposal, confirmado por el spike live).

---

## 0. Decisiones LOCKED (contra las que se diseña)

| # | Decisión | Fuente |
|---|---|---|
| D1 | **Alcance v1 = segmentar por ESTADO** (`ClientStatus` multi-status + rango `balanceDue`). Nodo → v2. | proposal §2/§3 |
| D2 | **Send-path = TWILIO CONTENT DIRECTO.** Adapter `TwilioContentGateway` implementa el port nuevo `TemplateMessagingPort`. Chatwoot NO se toca (sigue de inbox F1). Mismo Messaging Service `MG46755c…` → las respuestas caen al inbox solas. | engram #1819/#1822 (spike live) |
| D3 | **Opt-out** `Client.whatsappOptOutAt DateTime?` (null = contactable). Enforcement SIEMPRE. | proposal §5 |
| D4 | **RBAC** `messaging.bulk` + `messaging.templates` (migración idempotente, molde `20260904000100_messaging_permissions`). | proposal §RBAC |
| D5 | **Batch molde `ServiceCutRunner`**: lock distribuido (una campaña a la vez GLOBAL), resumible, rate-limit proactivo ~80/s + backoff 429 reactivo, status por-destinatario. | proposal §4.3, decisión #4 |

**Por qué el flip A→B no cuesta rediseño**: el port `TemplateMessagingPort` era desde el proposal el único punto que decide A vs B. El spike descartó A (los templates del usuario viven en un **WABA distinto** al de esta cuenta Twilio; Twilio Content solo veía 5 samples default). B (Twilio directo) queda absorbido por el adapter. Los use cases dependen SOLO del port — no se enteran del proveedor.

---

## 1. Modelos de datos + migraciones

### 1.1 `Campaign` (header + contadores) — molde `ServiceCutBatch` (`schema.prisma:1912`)

```prisma
model Campaign {
  id            String            @id @default(uuid())
  name          String            // nombre humano ("Recordatorio deuda julio")
  templateRef   String            // ContentSid Twilio (HX…) — enviable
  templateName  String?           // friendly_name legible del template
  segment       Json              // filtro serializado (reproducible/auditable):
                                  // { statuses: string[], balanceMin?: number, balanceMax?: number }
  variableSpec  Json              @default("{}") // cómo se llenan las variables del template
                                  // por-destinatario: { "1": {source:'name'}, "2": {source:'balanceDue'},
                                  // "3": {source:'literal', value:'…'} } — ver §3.CreateCampaign
  status        CampaignStatus    @default(pending)
  total         Int               @default(0)   // destinatarios resueltos al crear
  sentCount     Int               @default(0)
  failedCount   Int               @default(0)
  skippedCount  Int               @default(0)
  optedOutCount Int               @default(0)
  createdById   String            // FK RbacUser — quién la disparó
  createdBy     RbacUser          @relation("CampaignCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)
  error         String?           // error fatal del batch (si status=failed)
  createdAt     DateTime          @default(now())
  startedAt     DateTime?
  finishedAt    DateTime?
  updatedAt     DateTime          @updatedAt
  recipients    CampaignRecipient[]

  @@index([status])
  @@index([createdAt(sort: Desc)])   // historial ListCampaigns ordenado por fecha
}
```

### 1.2 `CampaignRecipient` (status por-destinatario, PERSISTIDO por fila)

```prisma
model CampaignRecipient {
  id                     String                   @id @default(uuid())
  campaignId             String
  campaign               Campaign                 @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  clientId               String
  client                 Client                   @relation("ClientCampaignRecipients", fields: [clientId], references: [id], onDelete: Cascade)
  phoneNormalized        String                   // clave de de-dup (normalizePhone) — auditable
  phoneE164              String                   // el destino REAL enviado (whatsapp E164) — auditable
  status                 CampaignRecipientStatus  @default(queued)
  providerId             String?                  // SM… de Twilio (id del mensaje) cuando sent
  chatwootConversationId Int?                     // link al mirror F1 si el cliente responde (F3/opcional)
  error                  String?                  // motivo del fallo por-fila (best-effort, no aborta el lote)
  sentAt                 DateTime?
  deliveredAt            DateTime?                // recién se llena en F3 (status callback Twilio)
  createdAt              DateTime                 @default(now())
  updatedAt              DateTime                 @updatedAt

  @@unique([campaignId, clientId])   // idempotencia de creación de recipients + resumible
  @@index([campaignId, status])       // progreso poleable + resume (WHERE status IN queued/failed)
}

enum CampaignStatus {
  pending
  running
  paused
  done
  failed
}

enum CampaignRecipientStatus {
  queued
  sent
  delivered
  opted_out   // Prisma no admite guiones — display "opted-out" en el DTO
  skipped
  failed
}
```

**Nota de precedente**: uso Prisma `enum` (no `String` con comentario como `ServiceCutBatch`) siguiendo el precedente `ClientStatus` — DB-enforced, más seguro para un campo con 6 estados. Tradeoff: un valor nuevo exige migración de enum (aceptable, el vocabulario está cerrado).

### 1.3 `Client.whatsappOptOutAt` (aditiva, D3)

```prisma
model Client {
  // …campos existentes…
  whatsappOptOutAt   DateTime?   // null = contactable. IS NOT NULL = excluido SIEMPRE del bulk.
  campaignRecipients CampaignRecipient[] @relation("ClientCampaignRecipients")
}
```
Elijo `DateTime?` sobre `Boolean` (proposal §5): a costo ~0 da el flag Y el "cuándo" (auditable compliance). Aditivo puro, sin backfill (todas las filas → `null` = contactable, correcto por default).

### 1.4 Migración aditiva de modelos (SQL sketch)

Generar con `npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma.bak --to-schema-datamodel prisma/schema.prisma --script` tras editar el schema. **Nunca editar SQL a mano** (regla CLAUDE.md). Sketch esperado (`20260908000000_messaging_bulk_campaigns`):

```sql
-- 1. Enums
CREATE TYPE "CampaignStatus" AS ENUM ('pending','running','paused','done','failed');
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('queued','sent','delivered','opted_out','skipped','failed');

-- 2. Client.whatsappOptOutAt (aditiva, nullable → sin backfill)
ALTER TABLE "Client" ADD COLUMN "whatsappOptOutAt" TIMESTAMP(3);

-- 3. Campaign
CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "templateRef" TEXT NOT NULL,
  "templateName" TEXT, "segment" JSONB NOT NULL, "variableSpec" JSONB NOT NULL DEFAULT '{}',
  "status" "CampaignStatus" NOT NULL DEFAULT 'pending',
  "total" INTEGER NOT NULL DEFAULT 0, "sentCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0, "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "optedOutCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL, "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");
CREATE INDEX "Campaign_createdAt_idx" ON "Campaign"("createdAt" DESC);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "RbacUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. CampaignRecipient
CREATE TABLE "CampaignRecipient" (
  "id" TEXT NOT NULL, "campaignId" TEXT NOT NULL, "clientId" TEXT NOT NULL,
  "phoneNormalized" TEXT NOT NULL, "phoneE164" TEXT NOT NULL,
  "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'queued',
  "providerId" TEXT, "chatwootConversationId" INTEGER, "error" TEXT,
  "sentAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_clientId_key" ON "CampaignRecipient"("campaignId","clientId");
CREATE INDEX "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId","status");
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

### 1.5 Migración RBAC (D4) — molde exacto `20260904000100_messaging_permissions`

`20260908000100_messaging_bulk_permissions/migration.sql`: el módulo `messaging` YA existe (idempotente `ON CONFLICT DO NOTHING`), sólo siembra los permisos `bulk` + `templates` bajo él + grants a `super_admin`/`administrador`.

```sql
-- módulo ya existe (F1) — re-INSERT idempotente por si corre en DB fresca
INSERT INTO "RbacModule" ("id","code","label")
VALUES (gen_random_uuid(),'messaging','Mensajería') ON CONFLICT ("code") DO NOTHING;

-- permiso messaging.bulk
INSERT INTO "RbacPermission" ("id","moduleId","action")
SELECT gen_random_uuid(), m."id", 'bulk' FROM "RbacModule" m WHERE m."code"='messaging'
ON CONFLICT ("moduleId","action") DO NOTHING;
-- permiso messaging.templates
INSERT INTO "RbacPermission" ("id","moduleId","action")
SELECT gen_random_uuid(), m."id", 'templates' FROM "RbacModule" m WHERE m."code"='messaging'
ON CONFLICT ("moduleId","action") DO NOTHING;

-- grants bulk + templates a super_admin y administrador (4 INSERT, molde §4-7 de F1)
-- … idénticos al molde, cambiando p."action" IN ('bulk','templates') y r."code" …
```

**Requisito de código (no sólo SQL)**: `PermissionAction` deriva de `KNOWN_ACTIONS` (`domain/entities/rbac.ts:89`). Hay que **agregar `'bulk'` y `'templates'`** a ese array (`messaging` YA está en `RBAC_MODULES:140`) o `requirePerm('messaging','bulk')` no compila.

```ts
// rbac.ts KNOWN_ACTIONS — agregar tras 'send':
  // messaging-bulk (F2) — disparar/ver campañas masivas + listar/usar templates
  'bulk',
  'templates',
```

**Ambas migraciones van al deploy** (no hay DB local — `prisma migrate deploy` en `deploy.yml:18-24`).

---

## 2. Port `TemplateMessagingPort` + adapter `TwilioContentGateway`

### 2.1 Port (`domain/ports/TemplateMessagingPort.ts`) — NUEVO, no extiende `ChatwootGateway`

Razón ISP (proposal §4.2): `ChatwootGateway.sendMessage` modela ops a nivel conversación existente (F1, estable). Templates + primer-contacto-outbound es responsabilidad distinta (crear el hilo desde cero, fuera de ventana 24h). Port separado = swap de proveedor sin tocar el núcleo.

```ts
// DTOs de dominio — los use cases NUNCA ven JSON crudo de Twilio
export interface TemplateDto {
  contentSid: string;                                  // HX… (templateRef enviable)
  friendlyName: string;
  language: string;                                    // ej 'es'
  variables: Record<string, string>;                  // sample/nombres de variables del template
  approvalStatus: 'approved' | 'pending' | 'rejected' | 'unsubmitted';
  category?: string;                                   // MARKETING | UTILITY | AUTHENTICATION
}

export interface SendTemplateResult {
  providerId: string;   // SM… (Message SID)
  status: string;       // queued | sent | accepted … (raw de Twilio, mapeado por el use case)
}

export interface TemplateMessagingPort {
  /** Lista templates del proveedor. El use case ListTemplates filtra approved. */
  listTemplates(): Promise<TemplateDto[]>;
  /**
   * Envía UN template. `to` = E164 con '+' (ej '+5493364xxxxxx'); el adapter le
   * antepone 'whatsapp:'. `variables` = mapa índice/nombre→valor ya resuelto por
   * el use case. Errores: transient (429/5xx/red) → TemplateProviderUnavailableError
   * (retryable); 4xx per-mensaje (número inválido, template no aprobado) →
   * TemplateSendRejectedError (terminal para ESE destinatario, no aborta el lote).
   */
  sendTemplate(to: string, contentSid: string, variables: Record<string, string>): Promise<SendTemplateResult>;
}
```

Errores tipados nuevos en `domain/errors/messaging.ts` (junto a `ChatwootUnavailableError`):
- `TemplateProviderUnavailableError extends DomainError` → statusMap 503 (transient/outage).
- `TemplateSendRejectedError extends DomainError` → statusMap 422 (rechazo per-mensaje).

### 2.2 Adapter `TwilioContentGateway` (`infrastructure/adapters/twilio/TwilioContentGateway.ts`)

Patrón axios idéntico a `HttpChatwootGateway`/`GestionRealClient` (`axios.create` en el ctor, basic auth, timeout finito). **Endpoints VERIFICADOS EN VIVO (diseñar contra esto, no inventar)**:

| Método | HTTP | Detalle |
|---|---|---|
| `listTemplates()` | `GET https://content.twilio.com/v1/ContentAndApprovals?PageSize=200` | basic auth `ACCOUNT_SID:AUTH_TOKEN`. Respuesta `contents[]`: cada uno `sid`(HX…), `friendly_name`, `language`, `variables`, `types`, `approval_requests.{status,category}`. **Paginar** con `meta.next_page_url` hasta `null`. Mapear `approval_requests.status` → `approvalStatus`. |
| `sendTemplate(to,contentSid,vars)` | `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json` | body form-urlencoded: `MessagingServiceSid=MG…`, `To=whatsapp:+<E164>`, `ContentSid=HX…`, `ContentVariables=<JSON string {"1":"valor",…}>`. Respuesta: `sid`(SM…) + `status`(queued/sent…). |

```ts
export interface TwilioContentGatewayOptions {
  accountSid: string;               // TWILIO_ACCOUNT_SID
  authToken: string;                // TWILIO_AUTH_TOKEN
  messagingServiceSid: string;      // TWILIO_MESSAGING_SERVICE_SID (MG…)
  http?: AxiosInstance;             // inyectable para tests
  timeoutMs?: number;               // default 15_000
}
```

**Mapeo de errores** (clave — clon del razonamiento de `GestionRealClient.isRetryableAxiosError`/`retryAfterMs`):
- axios sin `response` (red/timeout `ECONNRESET`/`ECONNABORTED`) → `TemplateProviderUnavailableError` (retryable).
- `response.status ∈ {429,500,502,503,504}` → `TemplateProviderUnavailableError` (retryable). Para 429 exponer `retryAfterMs` (Retry-After) para que el runner respete el backoff.
- `response.status` 4xx (400/401/403/404/…) que NO sea 429 → `TemplateSendRejectedError` (terminal per-mensaje). 401/403 en `listTemplates` = credencial mala → `TemplateProviderUnavailableError` (config, no per-mensaje).

**Fake para tests** (`InMemoryTemplateMessagingGateway` / `FakeTemplateMessagingPort` en `infrastructure/adapters/in-memory/`): array de `TemplateDto` inyectable + `sendTemplate` que registra las llamadas y devuelve `{providerId:'SMfake…', status:'queued'}`; modo "falla el N-ésimo con 429" para probar backoff, y modo "rechaza el número X" para probar per-recipient failed. **NO se mockea axios** — se inyecta el fake port (regla TDD del repo).

### 2.3 `toWhatsAppE164` — mapper de teléfono para el ENVÍO (distinto de la de-dup)

**Gotcha crítico de diseño**: `normalizePhone` (`matchActiveClient.ts:38`) es LOSSY — dropea el código de país `54`, el `9` móvil y el `15`. Sirve como **clave de de-dup** (comparar sufijos), NO para construir el destino Twilio. El envío WhatsApp AR exige E164 **completo con `+549`** (el `9` de móvil). Hace falta una función APARTE:

```ts
// application/use-cases/messaging/toWhatsAppE164.ts (pura, testeable)
// Reconstruye E164 AR-móvil desde el Client.phone crudo:
//  strip no-dígitos → asegura prefijo país 54 → asegura 9 móvil tras 54 → '+'
//  '3364123456' → '+5493364123456'; '+54 9 3364 12-3456' → idempotente
export function toWhatsAppE164(raw: string): string | null { … }
```
- `phoneNormalized` (dedup) = `normalizePhone(raw)` VERBATIM.
- `phoneE164` (destino real) = `toWhatsAppE164(raw)`.
- Si `toWhatsAppE164` devuelve null (teléfono basura) → recipient `skipped` (no enviable).

**Marcar como gate de verificación EN VIVO** (§8): el shape exacto de E164 AR para WhatsApp (`+549` vs `+54`) se confirma con el primer test-send real contra un número propio.

---

## 3. Use cases (contratos in/out, verbo+sustantivo, 1 por archivo)

Todos en `application/use-cases/messaging/`. DTOs curados — jamás entidad Prisma cruda.

### 3.1 `ListTemplates`
```
in:  () 
out: TemplateSummaryDto[]  // { contentSid, friendlyName, language, variables, category }
```
Delega en `TemplateMessagingPort.listTemplates()`, **filtra `approvalStatus==='approved'`** (sólo enviables), mapea a DTO curado (sin campos internos de Twilio). Gate RBAC `messaging.templates`.

### 3.2 `PreviewCampaignSegment` (a.k.a. `CountRecipients`)
```
in:  { statuses: string[], balanceMin?: number, balanceMax?: number }
out: { total: number, sample: { clientId, name, phoneE164 }[],   // sample acotado (ej 20)
       excludedOptOut: number, excludedNoPhone: number, dedupCollapsed: number }
```
Pasos (sin persistir):
1. `customerRepo.listSegmentRecipients(segment)` (§4) → candidatos narrow (`{clientId,name,phone,balanceDue,whatsappOptOutAt}`), YA filtrados por status IN + balance range + `whatsappOptOutAt IS NULL` a nivel query.
2. **Enforcement opt-out defensivo** en memoria (defensa en profundidad, aunque el query ya excluye): descartar `whatsappOptOutAt != null` → `excludedOptOut++`.
3. `toWhatsAppE164(phone)` null → `excludedNoPhone++` (basura, no enviable).
4. **De-dup por `normalizePhone`** (VERBATIM): dos clientes que normalizan igual → 1 destinatario (gana el primero por orden estable) → `dedupCollapsed++`.
5. Devolver conteo + sample. Gate RBAC `messaging.bulk`.

### 3.3 `CreateCampaign`
```
in:  { name, templateRef (HX…), templateName?, segment, variableSpec, createdById }
out: { campaignId, total, status:'pending' }
```
1. Re-resolver el segmento (reusa la lógica de `PreviewCampaignSegment` — extraer a un helper puro `resolveRecipients(candidates)` compartido).
2. `campaignRepo.create({...header, total})` → Campaign `pending`.
3. `campaignRepo.bulkCreateRecipients(campaignId, resolved[])` → N filas `queued` (idempotente por `@@unique[campaignId,clientId]`).
4. Serializa `segment` + `variableSpec` (auditable/reproducible). Gate `messaging.bulk`.

`variableSpec` shape: `Record<string, { source: 'name' | 'balanceDue' | 'literal'; value?: string }>` — mapea cada variable del template (`"1"`, `"2"`, o nombre) a un campo del `Client` o un literal. Resuelto **por-destinatario** en `SendCampaign`. v1 whitelist de sources: `name`, `balanceDue` (formateado ARS), `literal`. (Open question: ¿más campos? §9).

### 3.4 `SendCampaign` (worker async, molde `ServiceCutRunner` + `RunBulkEnforcement`)

Estructura en DOS piezas (igual que ServiceCut: runner shell + executor):
- **`CampaignRunner`** (`infrastructure/scheduling/CampaignRunner.ts`, molde `ServiceCutRunner`): `start(campaignId)` toma `DistributedLock.tryAcquire(CAMPAIGN_LOCK_KEY)` (una campaña a la vez GLOBAL); si no → `{accepted:false}`; si sí → marca `running`+`startedAt`, dispara `run()` fire-and-forget, devuelve `{accepted:true, campaignId}` para pollear. Libera el lock en `finally`.
- **`SendCampaign`** use case (executor, molde `RunBulkEnforcement.execute`): el loop real.

```
SendCampaign.execute(in: { campaignId }) → out: Campaign (snapshot terminal)
```
Loop:
1. `campaignRepo.listRecipients(campaignId, { statusIn: ['queued','failed'] })` → **resumible**: salta los `sent`/`delivered`/`opted_out`/`skipped` (idempotencia por status por-fila, igual que `EnforcePppoeService` idempotente).
2. Por cada recipient (SERIAL, un carril — Twilio limita GLOBAL a ~80/s, no per-destino):
   a. `await rateLimiter.acquire()` (§5, proactivo ~80/s).
   b. Resolver variables desde `variableSpec` + el `Client` (fetch narrow o traer en el candidato).
   c. `templatePort.sendTemplate(recipient.phoneE164, campaign.templateRef, vars)` con **retry+backoff 429** (§5): en `TemplateProviderUnavailableError` retryable → backoff `base·3^i + jitter` respetando Retry-After, hasta `maxRetries`; agotado → recipient `failed`. En `TemplateSendRejectedError` (4xx) → recipient `failed` inmediato (sin retry), lote sigue (best-effort, molde RunBulkEnforcement).
   d. `campaignRepo.updateRecipient(id, { status:'sent', providerId, sentAt })` o `{status:'failed', error}`.
   e. **Progreso coalesced** en `Campaign` (contadores) con el writer SERIAL best-effort de `RunBulkEnforcement:82-106` (un write en vuelo, coalescing, un hipo de DB no aborta).
3. Cierre: `campaignRepo.update(campaignId, { status:'done', sentCount, failedCount, …, finishedAt })`.

**Contadores**: `sentCount`/`failedCount`/`skippedCount`/`optedOutCount` derivados del estado local (snapshot completo, last-write-wins — sin race). Un `opted_out` detectado en vuelo (raro: el cliente pidió baja entre CreateCampaign y el envío) se re-chequea antes de enviar → `skipped`/`opted_out`.

### 3.5 `GetCampaign`
```
in:  { campaignId, includeRecipients?: boolean, page?, limit?, status? }
out: { campaign: CampaignDto, recipients?: PaginatedResult<CampaignRecipientDto> }
```
Header + contadores (poleable durante el envío vía `@@index[campaignId,status]`). Recipients paginados opcionales. Gate `messaging.bulk`.

### 3.6 `ListCampaigns`
```
in:  { page?, limit? }
out: PaginatedResult<CampaignSummaryDto>  // header + contadores, orden createdAt DESC
```
Historial para la tabla del FE. Gate `messaging.bulk`.

### 3.7 Ports nuevos
- **`CampaignRepository`** (`domain/ports/CampaignRepository.ts`) — molde `ServiceCutBatchRepository` + métodos de recipients:
  `create(header)`, `findById(id)`, `update(id, patch)` (snapshot last-write-wins),
  `list(query)`, `bulkCreateRecipients(campaignId, rows[])`,
  `updateRecipient(id, patch)`, `listRecipients(campaignId, filter?)`.
  Adapters: `PrismaCampaignRepository` + `InMemoryCampaignRepository` (tests).
- Reuso `DistributedLock` (`domain/ports/DistributedLock.ts`) + `PgAdvisoryLock` (ya wired en app.ts:2280) para el lock de campaña.

DTOs: `CampaignDto`, `CampaignSummaryDto`, `CampaignRecipientDto`, `TemplateSummaryDto` en `application/dto/` (o co-located). Recipient status `opted_out` → `'opted-out'` en el DTO (display).

---

## 4. Segmentación — extensión de `ListClientsQuery` + repo (aditiva)

**Dos superficies, ambas aditivas** (sin romper el contrato F1):

### 4.1 `ListClientsQuery` (para la lista/FE existente + segment-size display)
```ts
export interface ListClientsQuery extends PaginatedQuery {
  search?: string;
  status?: string;         // EXISTENTE — se preserva (single-status, back-compat)
  statuses?: string[];     // NUEVO — multi-status (OR). Si viene, tiene precedencia sobre status
  balanceMin?: number;     // NUEVO — umbral inferior de balanceDue
  balanceMax?: number;     // NUEVO — umbral superior
}
```
`PrismaCustomerRepository.list` (`:184`) — extensión del `where` (aditiva):
```ts
if (query.statuses?.length) where['status'] = { in: query.statuses };
else if (query.status)      where['status'] = query.status;   // path F1 intacto
if (query.balanceMin != null || query.balanceMax != null) {
  where['balanceDue'] = {
    ...(query.balanceMin != null ? { gte: query.balanceMin } : {}),
    ...(query.balanceMax != null ? { lte: query.balanceMax } : {}),
  };
}
```
Riesgo bajo: `status` solo se toca si llegan los campos nuevos; los callers F1 (un solo `status`) quedan idénticos.

### 4.2 `listSegmentRecipients(segment)` — método NUEVO narrow (para resolver la campaña)
Molde EXACTO de `listActiveContacts()` (`:300`) — UNA query, columnas narrow, sin paginar, sin N+1, sin `$queryRaw`:
```ts
// CustomerRepository
listSegmentRecipients(segment: {
  statuses: string[]; balanceMin?: number; balanceMax?: number;
}): Promise<CampaignRecipientCandidate[]>;

export interface CampaignRecipientCandidate {
  clientId: string; name: string; phone: string | null;
  balanceDue: number | null; whatsappOptOutAt: string | null;
}
```
Prisma: `findMany({ where: { status:{in}, balanceDue:{gte,lte}, whatsappOptOutAt: null }, select: {id,name,phone,balanceDue,whatsappOptOutAt} })`. El opt-out se filtra a nivel query (rápido) Y en el use case (defensa en profundidad). Devuelve TODO el set (el bulk necesita el universo completo, no una página) — mismo tradeoff recall-over-pagination que recapture.

**Por qué método separado y no reusar `list()`**: `list()` pagina y mapea el `Customer` completo (caro, y trunca por página). El bulk necesita el universo narrow. Separarlos evita cargar el segment builder de responsabilidades de paginación/mapeo.

---

## 5. Rate limiter proactivo ~80/s + backoff 429 reactivo

**Dos capas complementarias** (proposal riesgo #2: el proactivo previene, el reactivo es la red de seguridad):

### 5.1 Proactivo — token bucket inyectable (`application/util/TokenBucketRateLimiter.ts`)
No hay precedente en el repo (confirmado en explore §5). Nuevo, pequeño, puro, testeable:
```ts
export interface RateLimiter { acquire(): Promise<void>; }

export class TokenBucketRateLimiter implements RateLimiter {
  // capacity tokens, refill ratePerSec/s. acquire() resuelve cuando hay token;
  // si no, espera el tiempo hasta el próximo refill. now()/sleep inyectables → tests deterministas.
  constructor(opts: { ratePerSec: number; capacity?: number; now?: () => number; sleep?: (ms:number)=>Promise<void> }) {…}
}
```
- Default `ratePerSec` desde config (`MESSAGING_BULK_RATE_PER_SEC`, default 80, **calibrable sin redeploy** — el límite real del plan Twilio se confirma en vivo, riesgo #2).
- `capacity` = `ratePerSec` (permite burst de 1s, luego throttle sostenido).
- **Inyectable**: el `CampaignRunner`/`SendCampaign` recibe un `RateLimiter`. Tests inyectan `ImmediateRateLimiter` (no-op, `acquire()` resuelve ya) → deterministas y rápidos. El bucket real se testea aparte con `now()`/`sleep` pinchados.
- `sleep` usa `setTimeout(...).unref()` (patrón `GestionRealClient:74-81`) — no traba SIGTERM/deploy.

### 5.2 Reactivo — backoff 429-aware (clon de `GestionRealClient`)
**Clonar la función** (no el archivo — proposal §4.4): `backoffMs(attempt, err)` = `base·3^i + jitter`, respeta `Retry-After` del 429, cap `maxBackoffMs` (contra Retry-After hostil), `RETRYABLE_STATUS={429,500,502,503,504}`. Vive dentro del loop de `SendCampaign` envolviendo `sendTemplate`: un `TemplateProviderUnavailableError` con `retryAfterMs` → espera y reintenta hasta `maxRetries`; agotado → recipient `failed`. Params inyectables (`retryBaseMs`, `maxRetries`, `maxBackoffMs`, `sleep`, `random`) → tests pinchan jitter/sleep, igual que GR.

**Interacción**: el proactivo mantiene el ritmo bajo el techo; si Twilio igual devuelve 429 (burst mal calculado / límite real < 80), el reactivo absorbe. Un 429 sostenido sugiere que `ratePerSec` está mal calibrado → ajustable por env sin redeploy.

---

## 6. Flujo de respuestas (reply flow)

**Confirmado (spike + arquitectura Twilio)**: el bulk usa el **MISMO Messaging Service `MG46755c…`** que el inbox F1. Cuando el cliente responde el template:
`WhatsApp → Twilio (mismo número) → callback Chatwoot (ya configurado, F1) → ReceiveChatwootWebhook → mirror Conversation/ChatMessage`.
**No se toca NADA del lado de entrada** — la respuesta cae en el inbox F1 "gratis" (proposal §1). `GetClientContextByPhone` (F1, usa `normalizePhone`/`suffixMatch`) ya matchea la respuesta contra el `Client`.

**Design detail — ¿espejar el outbound del bulk al inbox de Chatwoot?**
- **Costo del gap**: el template lo mandamos DIRECTO por Twilio (bypassa Chatwoot). Chatwoot NO se entera del saliente → en el thread del inbox el agente ve la RESPUESTA del cliente pero NO el template original que disparó la conversación (falta contexto de hilo).
- **Recomendación v1 = registro SOLO en `Campaign`/`CampaignRecipient`.** El `providerId` (SM…) + el link `chatwootConversationId` (cuando el cliente responde) permiten al FE mostrar "este cliente estaba en la campaña X" desde el panel de contexto (reusa el patrón F1.5 de contexto de inbox). Simple, sin escribir en Chatwoot.
- **Espejo opcional → F3**: para ver el template en el thread habría que crear la conversación/mensaje en Chatwoot vía su API (hoy `ChatwootGateway` NO tiene `createConversation`, sólo `searchContact` nunca invocado — explore §1). Es trabajo extra (reconciliación) y no bloquea el valor de v1. Se difiere.

**Link recipient↔conversación**: cuando llega la respuesta, un hook (o `GetClientContextByPhone`) puede setear `CampaignRecipient.chatwootConversationId` matcheando `phoneNormalized`. v1: opcional/best-effort (el dato principal ya está en Campaign). No bloquea.

---

## 7. Routes + RBAC wiring (composition root, pin anti-W6)

**Router nuevo** `createMessagingBulkRouter(...)` (`infrastructure/http/routes/messagingBulk.routes.ts`) — molde `messaging.routes.ts` (factory + `perms` interface, auth per-route). O extender el `messaging.routes.ts` existente con endpoints de campaña; **recomiendo router separado** `/api/messaging/campaigns` (cohesión — el router F1 ya es grande).

```
GET    /api/messaging/templates                 → ListTemplates          [perms.templates]
POST   /api/messaging/campaigns/preview         → PreviewCampaignSegment [perms.bulk]
POST   /api/messaging/campaigns                  → CreateCampaign         [perms.bulk]
POST   /api/messaging/campaigns/:id/send         → CampaignRunner.start   [perms.bulk]  (202 + campaignId)
GET    /api/messaging/campaigns/:id              → GetCampaign            [perms.bulk]
GET    /api/messaging/campaigns                  → ListCampaigns          [perms.bulk]
```
`perms` interface (molde `MessagingRoutePerms:134`):
```ts
export interface MessagingBulkRoutePerms { bulk: RequestHandler; templates: RequestHandler; }
```
Cada handler `try/catch → next(err)` (lección 504) → `errorHandler` global mapea `TemplateProviderUnavailableError`(503)/`TemplateSendRejectedError`(422) vía statusMap.

**Wiring en `app.ts`** (composition root — se verifica A MANO + composition-root test, pin anti-W6):
```ts
// dentro del bloque messaging (app.ts:~2488), tras construir chatwootGateway:
const templatePort = new TwilioContentGateway({
  accountSid: config.twilio.accountSid,
  authToken: config.twilio.authToken,
  messagingServiceSid: config.twilio.messagingServiceSid,
});
const campaignRepo = new PrismaCampaignRepository();
const rateLimiter  = new TokenBucketRateLimiter({ ratePerSec: config.messagingBulk.ratePerSec });
const sendCampaign = new SendCampaign(campaignRepo, customerRepo, templatePort, rateLimiter, { /* backoff opts */ });
const campaignRunner = new CampaignRunner(sendCampaign, campaignRepo, new PgAdvisoryLock());
app.use('/api/messaging', createMessagingBulkRouter(
  new ListTemplates(templatePort),
  new PreviewCampaignSegment(customerRepo),
  new CreateCampaign(campaignRepo, customerRepo),
  campaignRunner,
  new GetCampaign(campaignRepo),
  new ListCampaigns(campaignRepo),
  { bulk: requirePerm('messaging','bulk'), templates: requirePerm('messaging','templates') },
));
```
`requirePerm` (`app.ts:836`) YA existe. `customerRepo` YA está wired. Reusa `PgAdvisoryLock` (`app.ts:2280`).

---

## 8. Verificación pendiente EN VIVO (gate del apply)

**Bloqueante antes de dar el apply por cerrado** (lección `ORCHESTRATOR_BASE_URL`: env/config faltante = 502 en prod aunque los tests mockeados pasen):
1. **`sendTemplate` exacto**: el shape de `ContentVariables` (¿índices `"1"/"2"` o nombres?) depende del template concreto. Se confirma con **UN test-send real** contra un número propio, con un template YA aprobado. Hasta entonces el mapeo es best-effort.
2. **`toWhatsAppE164`**: el prefijo AR-móvil correcto (`+549…`) para que WhatsApp entregue — se valida en el mismo test-send.
3. **Límite real de Twilio** (~80/s del plan contratado) — calibrar `MESSAGING_BULK_RATE_PER_SEC` con el primer bulk real chico.
4. **Callback de respuesta**: confirmar que una respuesta al template cae en el inbox F1 (mismo Messaging Service) — verificable en vivo con el test-send + responder desde el celular.

---

## 9. Env / secrets nuevos (TWILIO_*)

**Config fail-fast NO** (patrón `chatwoot`/`iclass`/`uisp` — opt-in, NO en `REQUIRED_VARS`): si faltan, `TwilioContentGateway` se construye igual pero cualquier llamada falla con `TemplateProviderUnavailableError` (503). El boot NUNCA falla por esto. `config.ts`:
```ts
twilio: {
  accountSid:          process.env.TWILIO_ACCOUNT_SID ?? '',
  authToken:           process.env.TWILIO_AUTH_TOKEN ?? '',
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? '',
},
messagingBulk: {
  ratePerSec: parsePositiveInt(process.env.MESSAGING_BULK_RATE_PER_SEC, { default: 80, max: 1000 }),
},
```
**gh secrets nuevos + líneas `-e TWILIO_*` en `deploy.yml`** (el bloque "Deploy container", junto a `CHATWOOT_*` en `:108-112`):
```yaml
-e TWILIO_ACCOUNT_SID="${{ secrets.TWILIO_ACCOUNT_SID }}" \
-e TWILIO_AUTH_TOKEN="${{ secrets.TWILIO_AUTH_TOKEN }}" \
-e TWILIO_MESSAGING_SERVICE_SID="${{ secrets.TWILIO_MESSAGING_SERVICE_SID }}" \
-e MESSAGING_BULK_RATE_PER_SEC="${{ secrets.MESSAGING_BULK_RATE_PER_SEC }}" \
```
Valores (del canal Chatwoot `channel_twilio_sms`, verificados): `ACCOUNT_SID=ACbfe3…`, `MESSAGING_SERVICE_SID=MG46755c79c005f44e1f7957eebe122b15`, `AUTH_TOKEN=<token del canal>`. **El BE necesita SUS PROPIOS secrets** (no reusa los de Chatwoot en runtime) — checklist del apply: crear los 3+1 gh secrets ANTES del deploy.

---

## 10. Template provisioning (ops — NO es del BE runtime)

Track de OPS en paralelo (no frena el BE). Los templates de negocio (deuda/corte/promo/bienvenida, ES) hay que **crearlos en Twilio Content + submit aprobación WhatsApp** (~24-48h Meta). Por API (acceso verificado):
- **Crear**: `POST https://content.twilio.com/v1/Content` (body con `friendly_name`, `language`, `types` — ej `twilio/text` o `twilio/quick-reply`, variables).
- **Submit aprobación**: `POST https://content.twilio.com/v1/Content/{sid}/ApprovalRequests/whatsapp` (name, category MARKETING/UTILITY).
- Sólo `approval_requests.status==='approved'` quedan enviables → los lista `ListTemplates`.

El BE runtime NO crea templates (Scope OUT, proposal §3): sólo LISTA (`ListTemplates`) y USA (`sendTemplate`). El provisioning lo hace el asistente/ops con OK del wording del usuario.

---

## 11. Open questions para tasks

1. **Variables de template**: whitelist de `source` en `variableSpec` para v1 (`name`, `balanceDue`, ¿`login`? ¿`paymentUrl` desde GR?). Formato de `balanceDue` (ARS con separador). Índices `"1"` vs nombres → depende del template (gate live §8).
2. **Tope de tamaño de segmento** (costo/seguridad, riesgo #1): ¿máximo de destinatarios por campaña? ¿confirmación extra sobre N?
3. **Política de reintentos por-destinatario**: un `failed` por-fila — ¿re-run manual (re-enviar `POST /send`, que resume queued+failed) o queda muerto? Recomiendo: `SendCampaign` resume `queued`+`failed` → re-disparar reintenta los fallidos. Confirmar si eso es lo deseado o si `failed` no debe reintentarse.
4. **Concurrencia** (riesgo #5): v1 = lock GLOBAL (una campaña a la vez, molde ServiceCutRunner). ¿El negocio necesita 2+ campañas simultáneas? → v2 (locks por-campaña/cola).
5. **Detección de baja (opt-out inbound)**: keyword "BAJA"/"STOP" en `ReceiveChatwootWebhook` setea `whatsappOptOutAt`. ¿Alcance exacto (keyword vs botón en template)? ¿Se implementa en ESटE change o se difiere? (afecta el enforcement real).
6. **RBAC granularidad**: ¿`messaging.bulk` + `messaging.templates` separados (diseñado así) o colapsar en `bulk` si templates se gestionan 100% fuera del BE (proposal §RBAC)?
7. **Espejo outbound → Chatwoot**: confirmado diferido a F3 (§6). ¿OK?
8. **`variableSpec` en preview**: ¿el preview valida que las variables del template se pueden resolver para todos los destinatarios (ej balanceDue null)? Recomiendo warning, no bloqueo.

---

## 12. Reuso explícito (qué se clona, de dónde)

| Se clona | De | Para |
|---|---|---|
| `ServiceCutBatch`/`ServiceCutBatchRepository`/`ServiceCutRunner` | entidad+port+runner con lock | `Campaign`/`CampaignRecipient`/`CampaignRepository`/`CampaignRunner` |
| Writer de progreso coalesced+serial best-effort | `RunBulkEnforcement:82-135` | loop de `SendCampaign` |
| `backoffMs`/`isRetryableAxiosError`/`retryAfterMs` | `GestionRealClient:118-229` | retry 429 en `SendCampaign`/adapter |
| `normalizePhone`/`suffixMatch` VERBATIM | `matchActiveClient:38-71` | de-dup de destinatarios |
| patrón axios (ctor `axios.create`, timeout finito) | `HttpChatwootGateway`/`GestionRealClient` | `TwilioContentGateway` |
| `listActiveContacts()` narrow-query | `PrismaCustomerRepository:300` | `listSegmentRecipients()` |
| migración RBAC idempotente | `20260904000100_messaging_permissions` | `messaging.bulk`/`templates` |
| factory router + `perms` per-route | `messaging.routes.ts:134,243` | `messagingBulk.routes.ts` |
| mirror `Conversation`/`ChatMessage` + `ReceiveChatwootWebhook` | F1 (sin cambios) | respuestas al bulk caen "gratis" |

---

## Artefactos
- `openspec/changes/messaging-bulk/design.md` (este archivo)
- Engram: `topic_key: "sdd/messaging-bulk/design"`, `project: "ipnext-backend"`, `type: "architecture"`
