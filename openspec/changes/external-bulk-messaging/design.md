# Design — external-bulk-messaging (envío masivo WhatsApp desde la API Externa, 2 pasos)

> Base: `proposal.md` (scope + contrato ya cerrados) + `exploration.md` (código verificado
> `archivo:línea`). Este design NO re-litiga el proposal: diseña DENTRO de él. Estilo D1..Dn
> citable, molde `archive/2026-07-22-campaign-chatwoot-label/design.md`. Todas las citas son del
> worktree BE `external-bulk-messaging-be` en su estado actual.
> **Seam central**: `CreateCampaign` + `CampaignRunner` se reusan SIN tocar su spec. Todo lo nuevo
> (preview, caps, idempotencia, key dedicada, kill-switch) vive AFUERA, en use cases nuevos.

## D0 — Mapa del flujo (dónde cae cada pieza)

```
POST /api/external/v1/messaging/bulk/validate    ── createApiKeyMiddleware(config.externalMessaging.apiKey)
  ValidateExternalBulk
    1 flag `messaging-external-bulk-enabled` (fail-safe OFF)          → 403 FEATURE_DISABLED
    2 zod safeParse → normalizeManualContacts({name: phone, phone})   → 400 VALIDATION_ERROR
    3 config singleton (fail-safe 500/2000) + cap por request         → 422 CAP_EXCEEDED
    4 templatePort.listTemplates() → friendlyName → approved + vars   → 422 TEMPLATE_* / MISSING_*
    5 matchManualContacts(contacts, segmentSource)  ← REUSO: dedup + opt-out por sufijo + E164
    6 chatwootGateway.listAccountLabels() si hay label                → 422 LABEL_NOT_FOUND / 503
    7 countSentByCreatorSince(apiMessagingUserId, dayStartArt)        → 422 CAP_EXCEEDED (diario)
    8 POR RECIPIENT: merge {...global, ...recipient.variables} (VAL-10)
        falta una key declarada → ese recipient a invalid{reason:'variables_faltantes',
                                   missingVariables[]}  (NUNCA rechaza el lote)
        renderTemplateBody(template.body, merged)   → renderedMessage POR RECIPIENT
      si NO quedó ningún valid                                        → 422 EMPTY_RECIPIENTS
    9 previewRepo.create({payloadHash, recipients (con variables mergeadas), expiresAt: +15min})
  → 200 { previewId, expiresAt, renderedMessage (muestra del 1er valid), counts,
          valid[{phone,name,variables,renderedMessage}], invalid[], caps }

GET  /api/external/v1/messaging/bulk/templates            ListTemplates            (D7.d, TPL-1)
GET  /api/external/v1/messaging/bulk/templates/:sid       GetTemplate              (TPL-2)
POST /api/external/v1/messaging/bulk/templates            CreateTemplate           (TPL-3, unsubmitted)
POST /api/external/v1/messaging/bulk/templates/:sid/submit SubmitTemplateForApproval (TPL-4, explícito)
DELETE …/templates/:sid                                   — NO EXISTE (404, TPL-5)
  todas: misma key dedicada + mismo flag (TPL-0); los 2 POST auditados (AUDIT-2)

POST /api/external/v1/messaging/bulk/send   header `Idempotency-Key`  ── misma key dedicada
  SendExternalBulk
    0 campaignRepo.findByExternalIdempotencyKey(key)  ── GUARD-0 (molde SendTemplateMessage.ts:116)
        HIT → valida que preview.campaignId === campaign.id, si no → 409 IDEMPOTENCY_KEY_CONFLICT
              → runner.start(campaign.id) → 202 {campaignId, resumed:true} | 409 BUSY
    1 flag → 403 · preview lookup → 404 / 410 expirado / 409 consumido-por-otro
    2 re-hash del payload del preview → mismatch → 409 PREVIEW_PAYLOAD_MISMATCH
    3 RE-VALIDACIÓN completa (pasos 4-7 de validate, contra el estado de AHORA)
    4 CreateCampaign({manualContacts, chatwootLabel, createdById: api-messaging,
                      externalIdempotencyKey})                      ← +1 campo en el port
    5 previewRepo.markConsumed(previewId, campaignId)  ── updateMany WHERE consumedAt IS NULL
    6 runner.start(campaignId) → accepted ? 202 : 409 CAMPAIGN_RUNNER_BUSY {campaignId, retryAfterSeconds}
```

---

## D1 — Data model: 2 tablas nuevas + 1 columna, todo aditivo

```prisma
// Preview EFÍMERO de un lote externo. NO es una Campaign: no infla el historial admin
// ni el cupo diario (que se cuenta sobre recipients realmente `sent`, D6).
model ExternalBulkPreview {
  id            String    @id @default(uuid())
  payloadHash   String                       // sha256 canónico (D5) — anti-replay con payload distinto
  templateRef   String                       // contentSid resuelto (HX…) — el preview congela el REF, no el nombre
  templateName  String                       // friendlyName pedido por el caller (auditoría del input)
  variables     Json      @default("{}")     // literales GLOBALES {"1":"...","2":"..."} tal cual los mandó el
                                             // caller (los por-recipient viven mergeados en `recipients`)
  chatwootLabel String?
  recipients    Json                         // [{phoneE164, phoneNormalized, name, variables}] YA normalizados,
                                             // dedupeados y con las variables MERGEADAS (global+recipient, D4.e)
  invalid       Json      @default("[]")     // [{input, reason, missingVariables?}] — razón por número, auditable
  validCount    Int
  invalidCount  Int
  expiresAt     DateTime                     // createdAt + 15 min
  consumedAt    DateTime?                    // seteado ATÓMICAMENTE al crear la Campaign (D8)
  campaignId    String?   @unique            // lazo 1:1 al resultado; sin FK (el preview es efímero, D1.b)
  createdAt     DateTime  @default(now())

  @@index([expiresAt])                       // TTL lazy + purga acotada (D9)
}

// Topes editables sin redeploy. Molde EXACTO WhatsappTaskStageTransitionConfig (schema:634)
// / FinanceReceiptSyncConfig (schema:2672): id fijo "singleton", una fila, upsert.
model ExternalBulkMessagingConfig {
  id            String   @id @default("singleton")
  maxPerRequest Int      @default(500)
  maxPerDay     Int      @default(2000)
  updatedAt     DateTime @updatedAt
}

// Campaign (MOD) — molde ChatMessage.idempotencyKey (schema:3987).
model Campaign { /* … */  externalIdempotencyKey String? @unique }

// CampaignRecipient (MOD) — literales POR-RECIPIENT (D4.e). Nullable, sin default:
// `null` en TODA fila pre-existente y en los dominios segment/manual/csv/task.
model CampaignRecipient { /* … */  variables Json? }
```

**D1.a — `Campaign.externalIdempotencyKey` nullable + `@unique`**: Postgres trata cada NULL como
distinto, así que las miles de campañas de UI existentes conviven sin backfill. El `@unique` no es
adorno: es el **backstop de carrera** (P2002) para dos `send` concurrentes con la misma key que
AMBOS pasaron el guard-0 — mismo mecanismo probado en `SendTemplateMessage.ts:69-73`.

**D1.b — `campaignId` SIN FK** (`String? @unique`, no `@relation`). Alternativa considerada: FK con
`onDelete: SetNull`. Rechazada: la FK obligaría a `Campaign` a llevar la back-relation, sumando ruido
al modelo más caliente del dominio por un lazo que solo se lee en el retry path. Un `campaignId`
huérfano (campaña borrada) degrada a "preview consumido" — el estado correcto igual.

**D1.d — `CampaignRecipient.variables Json?` va en la MISMA migración** que las 2 tablas nuevas
(no una segunda). Es `Json?` y no `String?`: el valor es un mapa `{key: value}`, y guardarlo como
texto obligaría a un `JSON.parse` en el adapter (con su rama de "texto corrupto") por cero ganancia.
Sin default `{}`: `null` y `{}` deben poder distinguirse — `null` = "este dominio no usa variables
por-recipient" (todo lo pre-existente), `{}` = "el caller externo mandó un mapa vacío". El adapter
Prisma castea a `Record<string,string> | null` en la lectura y NUNCA devuelve el `JsonValue` crudo.

**D1.c — Migración**: UNA sola, `prisma/migrations/<ts>_external_bulk_messaging/migration.sql`,
generada con

```
npx prisma migrate diff --from-schema-datamodel <schema en HEAD> \
                        --to-schema-datamodel prisma/schema.prisma --script
```

(sin DB, patrón `gr-invoices-sync` / `customer-portal-api`). Al SQL generado se le APENDA a mano el
seed del flag — `prisma migrate diff` no emite DML:

```sql
INSERT INTO "FeatureFlag" ("key","enabled","updatedAt")
VALUES ('messaging-external-bulk-enabled', false, NOW()) ON CONFLICT DO NOTHING;
```

**Sin `BEGIN`/`COMMIT`** (Prisma envuelve cada migración en su propia transacción — regla explícita
en `20261028000000_iclass_gps_ingest_flag/migration.sql`). El flag DEBE nacer de la migración porque
`SetFeatureFlag` hace `update`, NO `upsert` → sin fila, la card del FE devuelve 404 para siempre
(incidente ya documentado en esa misma migración).

---

## D2 — `api-messaging`: bootstrap en `main.ts`, NO seed por migración

**Elección**: extender `bootstrapSystemUsers.ts` con un segundo `bootstrapApiUser`-like
(`API_MESSAGING_USER_LOGIN = 'api-messaging'`), invocado desde el mismo `await bootstrapSystemUsers(...)`
de `main.ts:48`. `bootstrapApiUser` ya es parametrizable en la práctica: se generaliza a
`bootstrapMachineUser(userRepo, {login, name, email, passwordHash})` y `bootstrapApiUser` queda como
wrapper (backcompat de sus tests verdes).

**Alternativa rechazada — seed por migración SQL**: `RbacUser.passwordHash` es un bcrypt. Una
migración solo puede meter un hash LITERAL en git (secreto versionado, y si es un hash "conocido" es
una cuenta logueable) o un placeholder inválido. El bootstrap inyecta
`bcrypt.hashSync(randomUUID(), 10)` — hash inusable, distinto por deploy, cero secretos en el repo.
Además el bootstrap es idempotente por `findByLogin` y ya corre incondicionalmente.
**Asimetría deliberada con el flag (D1.c)**: el flag va por migración porque su ruta de escritura es
`update`-only; el usuario va por bootstrap porque su ruta de creación existe y es segura. No es
inconsistencia — es cada seed por el camino que su código de escritura permite.

**Por qué un `RbacUser` dedicado y no `Campaign.source`**: `createdById` YA es un discriminador
persistido, indexable y con FK `Restrict`. Un `source: String` nuevo colecciona valores basura a los
2 años (deuda ya declarada en `openspec/config.yaml`). Costo: cero migración sobre `Campaign` para
el filtro del cupo.

---

## D3 — Ports nuevos (2) y qué se REUSA sin tocar

| Port | Estado | Uso |
|------|--------|-----|
| `ExternalBulkPreviewRepository` (NEW, `domain/ports/`) | `create` · `findById` · `markConsumed(id, campaignId): Promise<boolean>` · `deleteExpiredBefore(date, limit): Promise<number>` | preview |
| `ExternalBulkMessagingConfigRepository` (NEW) | `get(): Promise<{maxPerRequest,maxPerDay,updatedAt}>` (defaults si no hay fila) · `set(patch)` | topes |
| `CampaignRepository` (MOD, +2 métodos) | `findByExternalIdempotencyKey(key)` · `countAuthorizedRecipientsByCreatorSince(createdById, since: Date)` — **fix wave F1 (F2)**, antes `countSentByCreatorSince` | guard-0 + cupo |
| `TemplateMessagingPort` | REUSO `listTemplates()` | aprobación + variables + body |
| `ChatwootGateway` | REUSO `listAccountLabels()` vía `ListChatwootLabels` | catálogo vivo del label |
| `FeatureFlagRepository` | REUSO `get(key)` | kill-switch |
| `CampaignSegmentSource` | REUSO vía `matchManualContacts` | opt-out por sufijo + dedup + E164 |

**D3.a — `countSentByCreatorSince` va en `CampaignRepository`, no en un port nuevo.** Es una lectura
sobre `CampaignRecipient` filtrada por el `Campaign` padre — el repo que YA es dueño de ambas
tablas. Un port nuevo `DailyQuotaLookup` sería un port de 1 método sobre datos ajenos (peor DIP, no
mejor). Firma y semántica EXACTA en ambos adapters:

```ts
// AMENDED — fix wave F1 (finding F2). Cuenta lo AUTORIZADO, no lo ya enviado.
countAuthorizedRecipientsByCreatorSince(createdById: string, since: Date): Promise<number>
// prisma.campaignRecipient.count({ where: {
//   createdAt: { gte: since },                       // INCLUSIVO en `since`
//   status: { notIn: ['skipped', 'opted_out'] },     // a esos nunca se les autorizó nada
//   campaign: { createdById } } })
// InMemory: MISMO filtro campo-a-campo sobre this.recipients + el createdById del padre.
```

**D3.b — `markConsumed` devuelve `boolean`, no `void`** — es el ganador de la carrera (D8). Un
`void` haría el contrato inobservable y el use case tendría que re-leer.

---

## D4 — Use cases (application/, cero import de `@infrastructure/*`)

| Use case | Archivo | Deps (ports) |
|----------|---------|--------------|
| `ValidateExternalBulk` | `application/use-cases/messaging/ValidateExternalBulk.ts` | previewRepo, configRepo, campaignRepo, templatePort, segmentSource, chatwootGateway, featureFlags, rbacUserRepo |
| `SendExternalBulk` | `.../SendExternalBulk.ts` | los mismos + `createCampaign` + `runner` (port estructural `CampaignStarter`) |
| `GetExternalBulkCampaign` | `.../GetExternalBulkCampaign.ts` | campaignRepo, rbacUserRepo |
| `GetExternalBulkConfig` / `SetExternalBulkConfig` | `.../GetExternalBulkConfig.ts`, `SetExternalBulkConfig.ts` | configRepo |

**D4.a — El runner entra por interfaz ESTRUCTURAL, no por el tipo concreto.**
`CampaignRunner` vive en `infrastructure/scheduling/` — un use case NO puede importarlo (DIP).
Se declara en `domain/ports/CampaignStarter.ts`: `{ start(campaignId: string): Promise<{accepted: boolean}> }`
— `CampaignRunner` lo satisface estructuralmente sin cambios (mismo truco que `CampaignSender`
en `CampaignRunner.ts:7`).

**D4.b — `name = <número crudo>` es la convención de recipients sin nombre.** `matchManualContacts.ts:54`
excluye `name===''` con `reason:'sin_nombre'`. La route/DTO mapea `phones: string[]` →
`manualContacts: [{name: phone, phone}]` usando el **input crudo** como name (no el E164 normalizado:
si el número es inválido nunca hay E164, y el `invalid[].input` debe devolver lo que el caller mandó).
Los recipients crudos persisten con `contactName = <el número>` — legible en el historial admin.

**D4.c — Variables: SOLO literales, GLOBALES + POR-RECIPIENT.** El caller externo no conoce
`Client`s; `resolveCampaignVariables` resolvería `source:'name'` contra un candidate sintético
`status:'no_cliente'` (→ vacío). Entonces el `variables` GLOBAL del wire se mapea a
`variablesMap = { k: {source:'literal', value: v} }`. Un `source` no-literal es imposible de
expresar por la API — decisión de contrato, documentada en la spec.

**El `variableSpec` de la Campaign se construye sobre TODAS las keys que el template declara**, no
solo sobre las que trae el global: `CreateCampaign.ts:78-84` (CAMP-3) tira
`MissingTemplateVariablesError` si falta UNA key declarada en `variablesMap`. Como una key puede
venir SOLO por-recipient, `SendExternalBulk` arma
`variablesMap = Object.fromEntries(declaredKeys.map(k => [k, {source:'literal', value: global[k] ?? ''}]))`.
El `''` NO llega nunca al mensaje real: el merge por-recipient (D4.e) lo pisa antes del render, y un
recipient que NO lo pisara ya habría caído en `invalid:'variables_faltantes'` en el `validate`
(VAL-10) y no estaría en el preview. El `variableSpec` queda entonces como **baseline auditable**,
no como la verdad del envío.

**D4.e — El camino de `variables` por-recipient, punta a punta (todo ADITIVO y opcional).**

| # | Archivo:símbolo | Cambio |
|---|---|---|
| 1 | `matchManualContacts.ts:6` `ManualContactInput` | `+ variables?: Record<string,string>` |
| 2 | `resolveCombinedRecipients.ts:635` `normalizeManualContacts` | preserva `variables` tal cual (solo trimea `name`/`phone`); ausente ⇒ ausente |
| 3 | `matchManualContacts.ts:48-77` | las resoluciones `linked` y `raw` cargan `variables: contact.variables` (la rama `excluded` NO — un excluido no se envía) |
| 4 | `resolveCombinedRecipients.ts:67` `CombinedResolvedRecipient` | `+ variables?: Record<string,string>`, poblado solo en la rama `csv` (`csvPreDedup`, L289-320); `admit()` lo arrastra por spread, cero cambio |
| 5 | `CampaignRepository.ts:54` `CampaignRecipientCreateRow` | `+ variables?: Record<string,string> \| null` |
| 6 | `CreateCampaign.ts:152-165` `bulkCreateRecipients` map | `+ variables: r.variables ?? null` |
| 7 | `campaign.ts:126` entidad `CampaignRecipient` | `+ variables: Record<string,string> \| null` (adapters Prisma + InMemory) |
| 8 | **`SendCampaign.ts:231`** | **el punto de override** (abajo) |

```ts
// SendCampaign.ts:231 — ANTES:
const variables = resolveCampaignVariables(campaign.variableSpec, candidate);
// DESPUÉS:
const variables = { ...resolveCampaignVariables(campaign.variableSpec, candidate),
                    ...(recipient.variables ?? {}) };
```

**Una sola línea cubre los TRES consumos**, porque los tres leen el MISMO `variables`:
`sendTemplate` (L244, Twilio), `renderTemplateBody` del path Chatwoot (L250) y `projectToInbox`
(L294 → `renderTemplateBody` en L351, el body que ve el inbox). No se toca `resolveCampaignVariables`
(L540) ni `renderTemplateBody` (L532) — quedan puras y con sus tests intactos.

**Por qué el override va DESPUÉS y no antes**: `resolveCampaignVariables` resuelve `source:'name'`/
`'balanceDue'` contra el `Client` VIVO; el override por-recipient es un dato que el caller externo
declaró explícitamente para ESE número. Entre "lo que el sistema infiere" y "lo que el caller
afirmó", gana lo afirmado — si no, la API tendría un contrato que a veces se ignora en silencio.

**Backward compatibility (no negociable)**: `variables` es opcional en cada uno de los 8 puntos y
`null`/`undefined` colapsa a `{}` en el spread ⇒ toda campaña de la UI admin envía EXACTAMENTE lo
mismo que hoy. La no-regresión se pinea con un test propio (SEND-10, scenario "campaña de la UI
admin"), no se asume.

**D4.f — Templates externos: CERO use case nuevo.** `ListTemplates`, `GetTemplate`, `CreateTemplate`
y `SubmitTemplateForApproval` ya existen y ya devuelven DTO curado (`TemplateSummaryDto` /
`TemplateDetailDto`, `toTemplateDetailDto`). El router externo los INYECTA (las mismas instancias
que el router admin, resueltas en el composition root) y solo cambia el gate de auth: key dedicada +
kill-switch en lugar de sesión + `messaging.templates`/`messaging.bulk`. `DeleteTemplate` NO se
inyecta al router externo — no basta con no registrar la ruta, la dependencia tampoco entra
(el borrado es scope-out, proposal).

**D4.d — `templateName` resuelve contra `friendlyName`.** El caller externo no maneja `HX…`.
`listTemplates()` → match exacto por `friendlyName`; 0 matches, 2+ matches (ambiguo) o
`approvalStatus !== 'approved'` → **422 `TEMPLATE_NOT_APPROVED`** (criterio CAMP-2: inexistente y
no-aprobado se tratan IGUAL, `CreateCampaign.ts:72`). El `contentSid` resuelto se congela en
`preview.templateRef`; el `send` re-resuelve y exige que siga aprobado — si el friendlyName ahora
apunta a otro `contentSid`, es un template distinto → `TEMPLATE_NOT_APPROVED`.

---

## D5 — Hash canónico del payload (anti-replay con datos distintos)

```ts
// application/use-cases/messaging/externalBulkPayloadHash.ts — pura, total, sin deps de infra.
const sortedPairs = (v: Record<string, string> | undefined): [string, string][] =>
  Object.keys(v ?? {}).sort().map(k => [k, String((v ?? {})[k])]);

export function externalBulkPayloadHash(p: {
  templateName: string; variables: Record<string, string>;
  chatwootLabel: string | null;
  recipients: { phone: string; name?: string; variables?: Record<string, string> }[];
}): string {
  const canonical = JSON.stringify({
    templateName: p.templateName.trim(),
    // claves ORDENADAS: JSON.stringify no garantiza orden estable entre objetos.
    variables: sortedPairs(p.variables),
    chatwootLabel: p.chatwootLabel ?? null,
    // Un recipient ya NO es un string: es [telefono, variables]. El teléfono va
    // NORMALIZADO (normalizePhone) — el mismo lote en otro formato es el MISMO lote;
    // los inválidos (normalize→null) entran como el crudo trimeado, para que cambiar
    // un número roto igual mueva el hash. Las variables van con KEYS ORDENADAS.
    // Se ordena por el par serializado COMPLETO: dos entradas del mismo teléfono con
    // variables distintas no pueden colapsar. `name` NO entra (es cosmético: no cambia
    // ni el destino ni el texto enviado — cambiarlo no debe invalidar un preview).
    recipients: p.recipients
      .map(r => [normalizePhone(r.phone) ?? r.phone.trim(), sortedPairs(r.variables)] as const)
      .map(pair => JSON.stringify(pair))
      .sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
```

El `send` re-calcula el hash **desde el preview persistido** (`templateName`, `variables`,
`chatwootLabel`, y los `recipients` — teléfono + variables mergeadas — más los `invalid[].input`)
y lo compara con `preview.payloadHash`. Que las variables por-recipient entren al hash es lo que
impide el ataque más barato de esta feature: validar un lote inocuo, ver el preview aprobado, y
mutar los datos personales antes del `send`. Alternativa considerada: que `send` reciba el payload completo otra vez y se
compare contra el guardado. **Rechazada**: duplica el wire y convierte al `send` en un segundo
`validate` sin ganar nada — el `previewId` es un uuid, no hay superficie de confusión. El campo
`payloadHash` sigue siendo la defensa contra un preview **mutado en la DB** entre pasos, y queda
pinneado por test para el día que el `send` acepte payload.

---

## D6 — Cupo diario: se cuenta lo ENVIADO, con día calendario Argentina

`since =` hoy 00:00 ART = **03:00 UTC del mismo día** (AR es UTC-3 fijo, sin DST — cero `Intl`,
determinístico, mismo criterio que `formatArs` de no depender del ICU del runtime).
`remainingToday = max(0, maxPerDay - countSentByCreatorSince(apiMsgId, since))`.

> **AMENDED — fix wave F1 (finding F2).** La decisión original (contar `status:'sent'`, proposal
> §3) hacía el cupo **INEXIGIBLE**, no solo "eventual". El envío real corre asincrónico detrás del
> `CampaignRunner`: entre el `send` que AUTORIZA N destinatarios y el momento en que salen,
> `countSent…` devuelve ~0. Traza verificada (test `fix wave F1 (F2)` en `SendExternalBulk.test.ts`,
> con su contrafáctico contra el código pre-fix): K1 autoriza N (sent≈0) → K2 pasa (remaining
> intacto) → K3 pasa → 3N autorizados con `maxPerDay = 2N`, y el replay de cada key vuelve a
> arrancar lo mismo. No era un desborde acotado por el cap por request: era un tope que nunca se
> alcanzaba.
>
> **Regla nueva**: el cupo cuenta los **recipients CREADOS** para campañas del creador externo desde
> el inicio del día ART, con `status NOT IN (skipped, opted_out)` — es decir, TODO intento autorizado
> (`queued|sent|delivered|failed`) quema cupo en el instante en que la `Campaign` nace, que es cuando
> el compromiso de gasto ya está tomado. `skipped`/`opted_out` no cuentan: a esos nunca se les
> autorizó un mensaje. `delivered` SÍ cuenta (con el filtro viejo desaparecía del conteo al avanzar
> de estado — un segundo bug de la misma línea).
>
> **Lo que se pierde, dicho de frente**: un lote que rebota por el lock (409 `CAMPAIGN_RUNNER_BUSY`)
> ya quemó su cupo, porque la `Campaign` existe y es reanudable — es exactamente el mismo trabajo
> autorizado. El cupo mide AUTORIZACIÓN, no entrega. Es el trade correcto: un tope que sobre-cuenta
> un caso raro sigue siendo un tope; uno que sub-cuenta el caso normal no lo es.
>
> **Caps y replay**: el replay (GUARD-0) NO re-chequea caps — esos destinatarios ya se contaron al
> crearse la campaña, volver a cobrarlos sería cobrar dos veces. El kill-switch, en cambio, SÍ se
> re-chequea en el replay (fix wave F1, finding F3).

---

## D7 — HTTP: router nuevo montado ANTES del `/api/external/v1` global

`infrastructure/http/routes/external-messaging.routes.ts` →
`createExternalMessagingRouter(deps): Router`, montado en `app.ts` **inmediatamente ANTES** de la
línea 3730 (`app.use('/api/external/v1', createApiKeyMiddleware(), createExternalV1Router(...))`):

```ts
// ⚠️ ORDEN LOAD-BEARING: Express matchea en orden de registro. Si este mount va DESPUÉS
// del de L3730, la key GLOBAL (config.externalApi.apiKey) intercepta /messaging/bulk/*
// y la key dedicada nunca se evalúa → 401 con la key correcta, 200 con la global.
// AMENDED — fix wave F1 (findings F1, F6, F7, F9).
app.use('/api/external/v1/messaging/bulk',
  createApiKeyMiddleware(config.externalMessaging.apiKey),   // fail-closed si está vacía
  machineActorMiddleware(rbacUserRepo, API_MESSAGING_USER_LOGIN),  // F6 — actor real para el audit
  createExternalMessagingRouter({
    writeRateLimiter: createExternalWriteRateLimiter(),      // F7 — SOLO sobre los POST
    validateExternalBulk, sendExternalBulk, getExternalBulkCampaign,
    listTemplates, getTemplate, createTemplate, submitTemplate,
    featureFlags }));   // ← `deleteTemplate` NO se inyecta (D4.f)
// [external-bulk-mount-end]  ← marcador que recorta la ventana del test de composition-root

// F1 — el parser va ARRIBA, junto a los otros overrides path-scoped, ANTES del global:
app.use('/api/external/v1/messaging/bulk', express.json({ limit: '2mb' }));   // línea ~1280
app.use(express.json());
```

Pinneado por `src/__tests__/infrastructure/external-bulk-messaging-composition.test.ts` (molde
`externalV1-ticket-wiring-composition.test.ts`): lee el FUENTE de `app.ts` y asserta que el índice
del mount nuevo `<` el índice de `'/api/external/v1'`, MÁS un test supertest de comportamiento
(key global → 401, key dedicada → pasa el auth).

**Body parser** — **AMENDED, fix wave F1 (finding F1)**: declarar el `express.json({limit:'2mb'})`
DENTRO del mount era **código muerto**. El `app.use(express.json())` global se registra ANTES y
body-parser saltea todo parseo posterior por su guard `req._body`, así que el `limit` nunca se
aplicaba: un lote de 1000 destinatarios (~145 KB) moría con **413 `entity.too.large` antes del auth
y del `errorHandler`** — con `maxPerRequest` en 500 por default, la feature era inusable en su
tamaño nominal y el 422 de negocio inalcanzable. El repo ya documenta esta clase EXACTA en
`app.ts:1269-1279` (tres overrides path-scoped registrados ANTES del global, con el incidente del
CSV escrito al lado). El parser se movió ahí. Pineado por dos tests: el orden en el fuente de
`app.ts` y un test MECÁNICO que arma AMBOS órdenes con Express real y prueba 200 vs 413.

**F7 — el rate limiter ya NO cubre el prefijo entero.** `createExternalWriteRateLimiter()` (30
req/60s por IP) estaba en el mount, así que también limitaba `GET /campaigns/:id` — el endpoint que
el propio contrato SEND-8 le pide al caller M2M que **poleé** tras un 409. El poll se auto-429aba.
Ahora entra como `writeRateLimiter` en las deps del router y se aplica SOLO a los 4 POST.

**F9 — `CreateCampaign` compartido.** El camino externo se construía su propia instancia con 3 de
las 7 dependencias (`new CreateCampaign(campaignRepo, customerAdapter, templatePort)`). Se hoisteó
la instancia del router admin a `const bulkCreateCampaign` y AMBOS la usan: si un cambio futuro
dejara al `send` externo pasar `manualClientIds`/`taskStageIds`, el source faltante tiraba un
`Error` genérico (500) en vez del error tipado. Además `SendExternalBulk` ahora pasa
`allowedBulkActions` EXPLÍCITO (nunca `undefined`, que en `CreateCampaign` significa "sin
enforcement"): el set es el más ancho que preserva el contrato — la API externa manda NÚMEROS que
pueden o no vincular a un `Client` de cualquier estado — pero NO es `'*'`, así que un estado de
cliente nuevo/no mapeado bloquea la campaña (bloqueo defensivo de `forbiddenBulkTargets`) en vez de
enviarse en silencio. El límite real del caller M2M sigue siendo key dedicada + kill-switch + caps.

**D7.a — Mapeo de errores** (`res.status(...).json({error, code})`, molde `externalV1.routes.ts:410`;
zod con `parseOr400` — **`safeParse`, NUNCA `.parse()`**, ver D11):

| Código | HTTP | Origen |
|---|---|---|
| `UNAUTHORIZED` | 401 | `createApiKeyMiddleware` (key vacía/ausente/mala) |
| `FEATURE_DISABLED` | 403 | flag OFF o repo de flags caído (fail-safe OFF) |
| `VALIDATION_ERROR` | 400 | `parseOr400`, `phones` vacío, falta `Idempotency-Key` |
| `CAP_EXCEEDED` | 422 | `> maxPerRequest` o `valid > remainingToday` |
| `TEMPLATE_NOT_APPROVED` / `MISSING_TEMPLATE_VARIABLES` | 422 | `TemplateNotApprovedError` / `MissingTemplateVariablesError` |
| `EMPTY_RECIPIENTS` | 422 | `EmptySegmentError` (todo inválido/opt-out) |
| `CHATWOOT_LABEL_NOT_FOUND` | 422 | label ausente del catálogo vivo (JAMÁS se crea) |
| `CHATWOOT_UNAVAILABLE` | 503 | `ChatwootUnavailableError` al listar labels |
| `PREVIEW_NOT_FOUND` / `PREVIEW_EXPIRED` / `PREVIEW_ALREADY_CONSUMED` | 404 / 410 / 409 | ciclo de vida |
| `PREVIEW_PAYLOAD_MISMATCH` | 409 | hash distinto |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | misma key ↔ otro preview |
| `CAMPAIGN_RUNNER_BUSY` | 409 | `runner.start → {accepted:false}` |
| `REPORTER_UNAVAILABLE` | 503 | `api-messaging` no bootstrapeado |

Errores nuevos tipados en `domain/errors/external-bulk-messaging.ts` (molde
`domain/errors/messaging-bulk.ts`), cada uno con su `code` — la route mapea, no inventa.

`MISSING_TEMPLATE_VARIABLES` **ya no lo lanza `validate`** (VAL-10 lo degradó a un `invalid` por
recipient). Se conserva en la tabla como **backstop del `send`**: viene de `CreateCampaign` (CAMP-3)
si alguna key declarada faltara en el `variableSpec` — que D4.c hace imposible por construcción, y
justamente por eso el mapeo tiene que existir (si el imposible pasa, es un 422 legible, no un 500).

**D7.d — Rutas de templates (mismo router, mismo mount, misma key, mismo flag)**. Cero use case
nuevo (D4.f); el gate de flag corre en el router (`FEATURE_DISABLED` antes de tocar el proveedor),
igual que en `validate`/`send`:

| Ruta | Use case | Éxito | Errores |
|---|---|---|---|
| `GET /templates` | `ListTemplates.execute()` | 200 `{data:[…]}` | 403 flag · 503 proveedor |
| `GET /templates/:sid` | `GetTemplate.execute(sid)` | 200 DTO | 404 `TEMPLATE_NOT_FOUND` · 503 |
| `POST /templates` | `CreateTemplate.execute(input)` | 201 DTO | 400 `VALIDATION_ERROR` · 503 |
| `POST /templates/:sid/submit` | `SubmitTemplateForApproval.execute(sid, {name, category})` | 202 `{contentSid, submitted:true}` | 400 · 404 · 503 |
| `DELETE /templates/:sid` | — | — | **404 `NOT_FOUND`: la ruta no se registra, sellado por el catch-all del router** (TPL-5) |

**AMENDED, fix wave F3 (S3, smoke en vivo)** — el body de `POST /templates/:sid/submit` pasa a
`{category, name?}`: `name` es OPCIONAL. Si el caller no lo manda, el route handler lo resuelve
llamando primero a `GetTemplate.execute(sid)` (ya inyectado, D4.f) y usando su `friendlyName` —
`name` explícito sigue ganando si vino. `sid` inexistente 404-ea igual (vía `GetTemplate`, ANTES de
tocar `submitTemplate`), con o sin `name` en el body.

**AMENDED, fix wave F3 (S2, smoke en vivo)** — el `DELETE /templates/:sid` de arriba (y cualquier
otra ruta no registrada bajo el prefijo, ej. `GET /campaigns/` con id vacío) YA NO cae al 401 del
mount GLOBAL (`/api/external/v1`, key global) por falta de match — Express seguía buscando afuera
del router sin un catch-all propio. `createExternalMessagingRouter` ahora termina con
`router.use((_req,res) => res.status(404).json({error:'Not found', code:'NOT_FOUND'}))` como ÚLTIMO
handler (mismo shape del 404 global, `app.ts`), sellando el prefijo entero.

El mapeo es EXACTAMENTE el que ya usa el router admin, porque son los MISMOS errores tipados y el
MISMO `errorHandler` global: `InvalidTemplateInputError → 'VALIDATION_ERROR' → 400`
(`messaging-bulk.ts:109-113`; **no es 422** — reusa el código genérico, y la spec lo dice explícito
para que nadie "corrija" el número), `TemplateNotFoundError → 'TEMPLATE_NOT_FOUND' → 404`
(`errorHandler.ts:252`), `TemplateProviderUnavailableError`/`TemplateProviderMisconfiguredError →
503` (`errorHandler.ts:220,224`). La route hace `next(err)`; NO traduce a mano.

El parseo del body de `POST /templates` y `/submit` usa `parseOr400` (zod `safeParse`), NO el
casting defensivo campo-a-campo de `templates.routes.ts:60-72` — ese patrón convierte un
`friendlyName: 123` en `''` y devuelve "friendlyName es requerido", mensaje mentiroso para un
consumidor M2M que necesita saber que mandó el TIPO equivocado.

**D7.b — Auditoría** — **AMENDED, fix wave F1 (finding F6)**. `auditMutationsMiddleware` (global,
`app.ts:1285`) ya cubre todo POST bajo `/api` (éxitos Y 4xx — verificado) y no excluye
`/api/external/v1`. Lo que faltaba era el ACTOR: quedaba `actorLogin:'anonymous'`, indistinguible de
cualquier otro M2M, no filtrable ni atribuible — AUDIT-1 pide explícitamente "identificando el
origen (`api-messaging`)", así que la deuda NO estaba cubierta. Y un `console.log` a stdout no es
auditoría: no se consulta desde `GET /api/admin/audit-events`, no sobrevive a un redeploy, y el
rechazo (422 `CAP_EXCEEDED`, el escenario que la propia spec nombra) ni siquiera lo emitía.

**Decisión revisada**: el mount adjunta el actor con `machineActorMiddleware(rbacUserRepo,
API_MESSAGING_USER_LOGIN)`, y el `console.log` de `SendExternalBulk` se ELIMINÓ. La objeción
original ("no inyectar un `req.user` sintético, eso mentiría en TODA la tabla") no aplica acá:
`api-messaging` **no es sintético** — es un `RbacUser` REAL, persistido, con FK, el MISMO id que
queda en `Campaign.createdById` de cada campaña que este router crea (D2). El actor de la mutación
es exactamente ese; lo que mentía era el `anonymous`. El middleware se monta SOLO en este router
(nunca puede pisar a un usuario humano) y es fail-soft: si el usuario de sistema no está
bootstrapeado, no voltea el request — los use cases ya tienen su guard duro
(`ReporterUnavailableError`, 503).

**D7.c — Config admin** (sesión, NO API key): `app.use('/api/messaging/config/external-bulk', ...)`
justo después del mount de `/api/messaging/config/task-stages` (`app.ts:3649`), molde exacto
`createTaskStageConfigRouter` — `GET /` gate `messaging:read`, `PUT /` gate `messaging:manage`.
El **toggle del kill-switch NO vive acá**: reusa `PATCH /api/feature-flags/messaging-external-bulk-enabled`
(gate `admin.flags`), que ya existe. Cero endpoint nuevo para el flag.

---

## D8 — Concurrencia: quién gana cada carrera

| Carrera | Mecanismo | El perdedor recibe |
|---|---|---|
| 2× `send`, misma `Idempotency-Key` | guard-0 + `@unique` + backstop P2002 | la MISMA `campaignId` (no una segunda campaña) |
| 2× `send`, mismo `previewId`, keys distintas | `markConsumed`: `updateMany({where:{id, consumedAt:null}, data:{consumedAt, campaignId}})` → gana `count===1` | 409 `PREVIEW_ALREADY_CONSUMED` |
| `send` mientras el runner corre | `CampaignRunner.start` → `{accepted:false}` (guard in-process + advisory lock, `CampaignRunner.ts:64-79`) | 409 `CAMPAIGN_RUNNER_BUSY` + `campaignId` + `retryAfterSeconds: 60` |

**Orden obligatorio: `markConsumed` DESPUÉS de `CreateCampaign`** — hace falta el `campaignId` para
escribirlo. Si `markConsumed` devuelve `false` (otro ganó), la campaña recién creada queda huérfana
en `pending`: se marca `status:'failed', error:'preview consumido por otro request'` y se responde
409. Alternativa considerada: consumir ANTES de crear. Rechazada: un fallo de `CreateCampaign`
(template desaprobado en el microsegundo intermedio) dejaría el preview quemado sin campaña —
irrecuperable para el caller.

**Contrato 409 exacto**: `{ error, code:'CAMPAIGN_RUNNER_BUSY', campaignId, retryAfterSeconds: 60 }`
+ header `Retry-After: 60`. La campaña **existe y está en `pending`**: reintentar `send` con la MISMA
key entra por el guard-0 y hace `runner.start` de nuevo (**resume**, no re-crea) — `SendCampaign` es
resumible (SEND-6) y `bulkCreateRecipients` es idempotente.

---

## D9 — TTL: lazy on read + purga oportunista acotada, sin scheduler

`findById` devuelve la fila igual; el **use case** decide (`expiresAt < now` → `PREVIEW_EXPIRED` 410)
— la expiración es regla de negocio, no del adapter. Además, cada `validate` dispara best-effort
(try/catch, nunca voltea el request) `deleteExpiredBefore(now - 24h, limit: 500)`, apoyado en
`@@index([expiresAt])`.

**Alternativa rechazada — job en el scheduler**: sumar un runner nuevo (config, lock, tests, wiring
en `main.ts`) para borrar filas de decenas de bytes, cuando el único escritor de la tabla ya pasa por
acá. La purga oportunista es O(1) por request y auto-limitante.

---

## D10 — Config / env / deploy

```ts
// infrastructure/config.ts — junto a `externalApi` (L511), MISMO patrón opt-in.
externalMessaging: { apiKey: process.env.EXTERNAL_MESSAGING_API_KEY ?? '' },
```

Opt-in, **NO** en `REQUIRED_VARS` (misma DEVIATION ya documentada para `alerts.grafanaIngestKey`,
`config.ts:520-530`): agregar fail-fast al boot mataría todo deploy actual que no la tiene.
Fail-**closed** al request: key vacía → `createApiKeyMiddleware` 401 a TODO (`apiKeyMiddleware.ts:46`).

- `env.example`: `EXTERNAL_MESSAGING_API_KEY=` + comentario ("vacío ⇒ 401 fail-closed").
- `gh secret set EXTERNAL_MESSAGING_API_KEY` (valor: 32 bytes random).
- `.github/workflows/deploy.yml`, junto a L119:
  `-e EXTERNAL_MESSAGING_API_KEY="${{ secrets.EXTERNAL_MESSAGING_API_KEY }}" \`

---

## D11 — Testing (TDD estricto: red → green → refactor)

| Capa | Qué | Cómo |
|---|---|---|
| Unit puro | `externalBulkPayloadHash` | orden de recipients/keys irrelevante; un dígito distinto ⇒ hash distinto; **cambiar el `variables` de UN recipient ⇒ hash distinto** (VAL-10); cambiar solo el `name` ⇒ MISMO hash |
| Use case | `ValidateExternalBulk` — variables por-recipient | override gana por key; faltante ⇒ ESE recipient `invalid:'variables_faltantes'` + `missingVariables` y el resto sigue `valid` (200, jamás 422); extra ignorada; `renderedMessage` distinto por recipient; top-level = el del 1er valid |
| Use case | `SendExternalBulk` | el `variables` mergeado del preview llega a `CampaignRecipientCreateRow.variables`; `variableSpec` cubre TODAS las keys declaradas con `''` de baseline (D4.c) sin que CAMP-3 tire |
| **No-regresión** | `SendCampaign` con `recipient.variables = null` | fixture de campaña admin: el mapa enviado es IDÉNTICO al de `resolveCampaignVariables` — **el test que prueba que no rompimos messaging-bulk** (SEND-10) |
| Use case | `SendCampaign` con `recipient.variables` | el override llega a los TRES consumos: `sendTemplate`, el body de Chatwoot y el `renderedBody` proyectado al inbox (assert en los 3, no solo en el primero) |
| Route | templates externos | un test por fila de D7.d: 200 list · 200/404 get · 201/400 create · 202/400/404 submit · **DELETE ⇒ 404 y `deleteTemplate` NO invocado** (spy en el port) · flag OFF ⇒ 403 en las 4 · key global ⇒ 401 |
| Use case | `ValidateExternalBulk` / `SendExternalBulk` | `InMemoryExternalBulkPreviewRepository` + `InMemoryExternalBulkMessagingConfigRepository` (NUEVOS) + `InMemoryCampaignRepository` + `FakeChatwootGateway` + fake `TemplateMessagingPort` + fake `CampaignStarter` |
| Use case | caps / opt-out / expirado / consumido / hash / idempotencia | matriz 1:1 con la tabla de D7.a |
| Adapter | `PrismaCampaignRepository.countSentByCreatorSince` | paridad con el InMemory (mismo caso, mismo número) |
| Route | supertest sobre el router con **use cases REALES** + repos in-memory | body basura ⇒ 400 (no 500); un test por `code` de D7.a |
| Composition-root | orden de mounts en `app.ts` | lectura del FUENTE (índice del mount nuevo < índice de `/api/external/v1`) + supertest key global ⇒ 401 |
| Bootstrap | `api-messaging` idempotente | `InMemoryRbacUserRepository`, 2 corridas ⇒ 1 usuario |

**Lección obligatoria (no negociable)**: los tests POR CAPA no ven el hueco de `.parse()`.
Un `ZodError` no está mapeado en el `errorHandler` → **500** en vez de 400. Por eso el router usa
`parseOr400` (`assistant.routes.ts:176`, con el comentario del incidente que lo cazó) y hay un test
de ruta con el use case real por cada endpoint.

---

## D12 — Wire contract (BE ↔ IA ↔ FE)

```ts
// POST /api/external/v1/messaging/bulk/validate   — header X-API-Key | Authorization: Bearer
Req  { templateName: string;                       // friendlyName; alias `templateRef` (contentSid)
       variables?: Record<string,string>;          // GLOBAL — default para todos
       chatwootLabel?: string;
       recipients: { phone: string;
                     name?: string;                // ausente ⇒ name = el teléfono crudo (D4.b)
                     variables?: Record<string,string> }[] }   // pisa al GLOBAL por KEY (VAL-10)
200  { previewId: string; expiresAt: string /*ISO*/;
       renderedMessage: string;                    // MUESTRA: el del 1er `valid` ('' si no hay)
       counts: { received:number; valid:number; invalid:number; optedOut:number; duplicated:number };
       valid: { phone: string; name: string;
                variables: Record<string,string>;  // el MERGEADO efectivo de ESTE destinatario
                renderedMessage: string }[];       // su mensaje exacto — la salvaguarda del preview
       invalid: { input: string;
                  reason: 'sin_telefono'|'telefono_invalido'|'opt_out'|'duplicado'
                        |'non_mobile'|'variables_faltantes';
                  // AMENDED, fix wave F3 (S1, smoke en vivo) — 'non_mobile' YA NO SE EMITE: un
                  // NSN AR de 10 dígitos limpio ahora clasifica `mobile` (consistente con
                  // `toWhatsAppE164`, el motor que usa `send`). El literal queda en la union
                  // SOLO por estabilidad de wire (un consumer con `switch` exhaustivo no rompe).
                  missingVariables?: string[] }[]; // SOLO en `variables_faltantes`, keys ordenadas
       caps: { maxPerRequest:number; maxPerDay:number; remainingToday:number } }

// POST /api/external/v1/messaging/bulk/send   — + header `Idempotency-Key: <uuid>`
Req  { previewId: string }
202  { campaignId: string; accepted: true; total: number }        // send FRESCO (esta request la creó)
200  { campaignId; accepted: true; total; resumed: boolean;      // REPLAY (GUARD-0 hit, SEND-6)
       status: 'pending'|'running'|'done'|'failed'|'paused' }    // <- fix wave F1 (F3), ADITIVOS
     // `resumed:false` = la campaña YA había TERMINADO (done|failed) y NO se re-arrancó.
409  { error: string; code: 'CAMPAIGN_RUNNER_BUSY'; campaignId: string; retryAfterSeconds: number }

// ── Templates (mismo router / misma key dedicada / mismo kill-switch, D7.d) ──
type TemplateDetailDto = { contentSid: string; friendlyName: string; language: string;
                           variables: string[]; approvalStatus: 'approved'|'pending'|'rejected'|'unsubmitted';
                           category?: string; sendable: boolean; body: string;
                           // fix wave F4 (S4) — ADITIVOS, ambos `string | null` opcionales.
                           // `rejectionReason`: motivo de Meta, solo significativo si
                           // approvalStatus === 'rejected'. `approvalCategory`: la categoría según el
                           // endpoint dedicado de aprobación — SOLO viene poblada en GET .../:sid (ver
                           // abajo); en el listado (GET .../templates) queda undefined/ausente.
                           // fix wave F5 — F4 los agregó a `TemplateDto` (dominio) pero el mapper
                           // (`toTemplateDetailDto`) los descartaba: morían ANTES del wire. Fix acá,
                           // sin cambiar el shape declarado en F4.
                           rejectionReason?: string | null; approvalCategory?: string | null;
                           // fix wave F5 (LOW) — ADITIVO, string suelto (NO union). Status crudo del
                           // proveedor (ej. `paused`, `disabled`) tal cual lo informa Twilio, SIN
                           // normalizar — `approvalStatus` colapsa cualquier valor fuera del union de
                           // arriba a `'unsubmitted'`, así que un template YA aprobado y luego pausado
                           // por el operador (o desactivado por Meta) se ve idéntico a "nunca
                           // sometido" salvo que se mire este campo. `undefined` cuando el proveedor
                           // no informó status. Presente en AMBOS endpoints (listado y ficha).
                           providerStatus?: string };

// GET  .../templates
200  { data: TemplateDetailDto[] }                 // TODOS (no solo los approved); sendable = approved
// GET  .../templates/:sid                          estado VIVO contra el proveedor
// fix wave F4 (S4) — ANTES: `GET /v1/Content/{sid}` de Twilio no trae `approval_requests` ⇒
// approvalStatus quedaba SIEMPRE 'unsubmitted', aunque el listado (`ContentAndApprovals`) mostrara
// 'rejected'/'approved' reales. Fix en `TwilioContentGateway.getTemplate()`: segundo GET a
// `/v1/Content/{sid}/ApprovalRequests` y merge del estado real + `rejection_reason`/`category`. Si
// ese segundo GET falla (404 = nunca sometido, timeout, 5xx) degrada a 'unsubmitted' SIN tirar —
// dato secundario, no debe romper la lectura del template. Mismo DTO que consume el admin
// `GET /api/templates/:sid` (additivo, sin breaking change).
200  TemplateDetailDto        | 404 { code:'TEMPLATE_NOT_FOUND' } | 503
// POST .../templates
Req  { friendlyName: string; language: string; body: string;   // body con placeholders {{1}},{{2}}…
       category?: 'UTILITY'|'MARKETING'|'AUTHENTICATION'; variables?: string[] }
201  TemplateDetailDto (approvalStatus:'unsubmitted')  | 400 { code:'VALIDATION_ERROR' } | 503
// POST .../templates/:sid/submit                    ← paso EXPLÍCITO y separado (cuesta review de Meta)
// AMENDED, fix wave F3 (S3, smoke en vivo) — `name` pasa a OPCIONAL: si no vino, el handler lo
// resuelve del propio template (`friendlyName`, vía `GetTemplate`, ya inyectado) ANTES de tocar
// `submitTemplate`; si vino explícito, gana siempre. `sid` inexistente 404-ea igual, con o sin `name`.
Req  { category: 'UTILITY'|'MARKETING'|'AUTHENTICATION'; name?: string }  // name se normaliza a [a-z0-9_]
202  { contentSid: string; submitted: true }       | 400 | 404 | 503
// DELETE .../templates/:sid → 404 { code:'NOT_FOUND' } — NO se expone (TPL-5); AMENDED, fix wave F3
// (S2) — sellado por el catch-all del router (antes escapaba al mount global ⇒ 401, ver D7.d).

// GET /api/external/v1/messaging/bulk/campaigns/:id   — scoped a createdById === api-messaging
200  { campaignId; status: 'pending'|'running'|'done'|'failed';
       total; sentCount; failedCount; skippedCount; optedOutCount; startedAt; finishedAt }
404  cuando la campaña existe pero NO es del creador externo (no se filtra info de campañas de UI)
// fix wave F1 (finding F15 / R2 #7) — `GET /campaigns/:id` NO está gateado por el
// kill-switch, A PROPÓSITO. El flag apaga lo que GASTA (validate/send) y lo que toca al
// proveedor (templates); apagarlo también acá dejaría a un caller con una campaña EN VUELO
// sin forma de saber cómo terminó — el rollback del D14 (flag OFF, instantáneo) cegaría
// justo a quien más necesita ver el resultado. Es una LECTURA, acotada a campañas propias
// (STATUS-1), sin costo hacia afuera. Tampoco la limita el rate limiter de escritura (F7).

// Config admin (sesión) — GET/PUT /api/messaging/config/external-bulk
GET  200 { maxPerRequest: number; maxPerDay: number; updatedAt: string }   gate messaging:read
PUT  Req { maxPerRequest: number; maxPerDay: number } → 200 mismo shape    gate messaging:manage
     400 si no es entero >= 1, si maxPerRequest > maxPerDay, o (fix wave F1, F4) si
     maxPerRequest > 5000 (MAX_MANUAL_CONTACTS, techo DURO del motor de envío).
     Mensaje literal: maxPerRequest cannot exceed 5000 (hard cap of the bulk send engine)
// Kill-switch: GET/PATCH /api/feature-flags/messaging-external-bulk-enabled  gate admin.flags (YA EXISTE)
```

---

## D13 — FE mínimo (repo `ipnext-frontend`, cambio coordinado — se DESCRIBE, no se implementa acá)

Card nueva `ExternalBulkMessagingCard.tsx` en `components/settings/`, montada en
`pages/whatsapp/WhatsappSettingsPage.tsx` junto a `ChatwootSendPathCard`.

- **Bloque 1 — kill-switch**: molde EXACTO `ChatwootSendPathCard.tsx` (`useFeatureFlags`, toggle +
  confirm), gate `admin.flags`. **Confirm de peligro al PRENDER** ("Esto habilita envíos masivos de
  WhatsApp por API sin sesión. Es plata real."); apagar no confirma (apagar siempre es seguro).
- **Bloque 2 — topes**: 2 inputs numéricos controlados + botón *Guardar*, gate `messaging.manage`
  (sin el permiso: read-only, NO ocultos). Sin molde 1:1 en este FE (primera card de settings con
  inputs numéricos) → compone el fetch/mutate de `useFeatureFlags` con inputs controlados simples.
- **4 estados de fetch**: `loading` (skeleton) · `error` (banner "estado desconocido", toggle
  DESHABILITADO — jamás mostrar OFF cuando no se sabe) · `ready` · `saving` (botón/toggle disabled).
- **Tipos espejo campo-a-campo** del DTO de D12: `{ maxPerRequest: number; maxPerDay: number;
  updatedAt: string }`. La validación en cliente (entero ≥ 1, `maxPerRequest ≤ maxPerDay`) es UX; la
  autoridad es el 400 del BE.

---

## D14 — Rollout y rollback

1. **Deploy DARK**: flag `false` (sembrado por migración) + `EXTERNAL_MESSAGING_API_KEY` **sin
   setear** → doble apagado (403 por flag, 401 por key vacía). El código puede mergear tranquilo.
2. `gh secret set EXTERNAL_MESSAGING_API_KEY` + redeploy → la key existe, el flag sigue OFF (403).
3. **Flip del flag desde la UI** (Config → WhatsApp), sin deploy.
4. **Smoke en vivo con 1 número real (el del usuario)**: `validate` → revisar `renderedMessage` y
   `counts` a ojo → `send` → verificar el WhatsApp recibido, la conversación en Chatwoot y el label.
5. Recién con eso verde: la fase posterior (skill `whatsapp-bulk-ipnext`).

**Rollback** (por orden de rapidez): flag OFF desde la UI (instantáneo) → vaciar el secret +
redeploy (401 fail-closed) → revert del mount en `app.ts` (la ruta deja de existir). Las 2 tablas y
la columna son aditivas/nullable: quedan inertes, sin migración inversa. El `RbacUser api-messaging`
es inofensivo si nadie lo usa (passwordHash inusable).

---

## D15 — Riesgos y deuda DECLARADA

| Riesgo | Estado |
|---|---|
| **Double-send cross-lote** (el mismo número en 2 `send` del día) | **ACEPTADO, no resuelto.** El dedup de `resolveCombinedRecipients` es INTRA-campaña. El cupo diario limita CANTIDAD, no duplicados. Resolverlo exige una ventana "ya contactado hoy" que no existe en ningún lado del código de mensajería |
| **`app.ts` God Object** (deuda HIGH pre-existente) | Este change le suma ~15 líneas y le exige un ORDEN de mounts load-bearing. Mitigado por el test de composition-root (D11), NO resuelto |
| Cupo diario eventual, no transaccional | **REVISADO — fix wave F1 (F2)**: ya no cuenta `sent` (inexigible) sino lo AUTORIZADO al crear la campaña. Sigue habiendo una ventana de carrera entre dos `send` simultáneos, ahora acotada a los milisegundos entre el chequeo y el `create` — ver D6 |
| ~~Auditoría `actorLogin:'anonymous'`~~ | **RESUELTO — fix wave F1 (F6)**: `machineActorMiddleware` adjunta el `RbacUser` REAL `api-messaging`; el `console.log` se eliminó (D7.b) |
| 3 de 4 lotes rebotan por el lock global | Contrato 409 honesto + `retryAfterSeconds`; la skill hace poll+retry. NO se agrega cola |
| Preview stale entre `validate` y `send` | TTL 15 min + re-validación COMPLETA en `send` (D0 paso 3) |
| **Datos personales cruzados** (el nombre/monto de uno al número de otro) — el riesgo NUEVO que abren las variables por-recipient | Mitigado, no eliminado: el preview devuelve `variables` + `renderedMessage` POR destinatario (auditable antes de autorizar) y el `payloadHash` los incluye (mutarlos entre pasos ⇒ 409). La CORRESPONDENCIA número↔variables la afirma el caller: el BE no tiene con qué verificarla |
| **Templates creados por una IA** | `POST /templates` es barato (`unsubmitted`, no toca a Meta); el que cuesta un slot de review es el SUBMIT, que es una llamada SEPARADA y explícita (TPL-4). Sin cuota propia por ahora: el kill-switch y la key dedicada son el único freno — deuda declarada |
| Extensión aditiva sobre `SendCampaign` (messaging-bulk) | Una línea (D4.e:8) en el use case más caliente de mensajería. Mitigado por el test de NO-REGRESIÓN con `variables = null` (D11), que es obligatorio, no opcional |

## Open Questions

Ninguna. Todo lo abierto por la exploración quedó cerrado en el proposal (tabla nueva, `RbacUser`
dedicado, 409 honesto) o acá (D1.c seed, D2 bootstrap, D3.a cupo, D5 hash, D9 TTL).
