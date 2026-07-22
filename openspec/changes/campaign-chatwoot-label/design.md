# Design — campaign-chatwoot-label (label opcional de Chatwoot al crear una campaña bulk)

> Base: `proposal.md` (decisiones A–F ya tomadas) + exploración `sdd/campaign-chatwoot-label/explore`
> (API de labels de Chatwoot verificada en vivo, v4.13, account_id=2). Este design NO re-litiga A–F:
> diseña DENTRO de ellas. Todas las citas `archivo:línea` son del worktree BE en su estado actual.
> El seam es el port `ChatwootGateway` (`domain/ports/ChatwootGateway.ts`) — el MISMO que fundó
> `messaging-inbox` y extendió `chatwoot-hub-sendpath`. El estilo (D1..Dn citables) sigue el design
> archivado `2026-07-22-chatwoot-hub-sendpath/design.md`.

## D0 — Mapa del enganche (dónde cae el labeling)

El labeling es un **side-effect aditivo best-effort** que cuelga del path ON de `SendCampaign`
(ya en PROD por `chatwoot-hub-sendpath`). NO altera ninguna garantía existente (`sent`/`failed`,
dedup, contadores, proyección al inbox siguen idénticos).

```
── SendCampaign.processRecipient (bulk, por destinatario) — SendCampaign.ts:183 ──────────
 candidate + re-check opt-out + resolveCampaignVariables            (INTACTO)
 rateLimiter.acquire()                                              (INTACTO)
   OFF ─ sendWithRetry(templatePort.sendTemplate(...))            → chatwootIds = undefined
   ON  ─ chatwootGateway.createConversationWithTemplate(...)      → chatwootIds = {cid, mid|null}
 persistRecipientSent(sent)                    (:281, INTACTO — FIX-5 sigue vigente)
 projectToInbox(...)                            (:286, best-effort/aislado, INTACTO)
 ▸ applyChatwootLabel(campaign, recipient, chatwootIds)   ◂── NUEVO (:287, post-sent)
     if campaign.chatwootLabel == null → skip
     if chatwootIds?.chatwootConversationId == null → skip  (flag OFF / Twilio-directo)
     try  chatwootGateway.addConversationLabels(cid, [campaign.chatwootLabel])   (GET-unión-POST en el adapter)
     catch → console.error(campaignId, cid, label) y SIGUE   (JAMÁS re-marca failed)

── Catálogo (rutas proxy, consumo del composer FE) — messagingBulk.routes.ts ──────────────
 GET  /api/messaging/bulk/chatwoot-labels  → ListChatwootLabels  → gateway.listAccountLabels()   gate messaging.templates
 POST /api/messaging/bulk/chatwoot-labels  → CreateChatwootLabel → gateway.createAccountLabel()   gate messaging.manage
```

---

## D1 — Extensión del port `ChatwootGateway`: 3 métodos + `ChatwootLabelDto`, firmas y payloads exactos

Se EXTIENDE el port existente (`ChatwootGateway.ts:88-191`) — no un port nuevo (proposal §5). Los 3
métodos llevan el criterio de error único del resto del port: **cualquier** fallo de axios
(red/timeout/4xx/5xx) → `ChatwootUnavailableError` (`@domain/errors/messaging`, molde `this.call`
`HttpChatwootGateway.ts:124`). `HttpChatwootGateway` implementa los 3; `FakeChatwootGateway`
(`__tests__/helpers/FakeChatwootGateway.ts:27`) los espeja.

### D1.a — DTO nuevo (co-located en el port, molde `ChatwootConversationDto` `:8`)

```ts
export interface ChatwootLabelDto {
  title: string;   // clave del tag en Chatwoot (los labels de conversación son title-keyed, verificado explore §1)
  color: string;   // hex (ej. '#34E200') — swatch del Select FE
}
```

**Se descarta el `id`** que la proposal §5 esbozó (`{id,title,color}`): los tags de conversación se
aplican y resuelven **por título**, no por id (explore §1 — `POST /conversations/:id/labels` recibe
`{labels:[<title strings>]}`), y el FE persiste el `title` en `campaign.chatwootLabel`. El `id` sería
un campo muerto. YAGNI — matchea `{title,color}[]` del contrato pedido.

### D1.b — Firmas exactas (nombres SIN prefijo `chatwoot` redundante — decisión de naming)

```ts
listAccountLabels(): Promise<ChatwootLabelDto[]>;
createAccountLabel(params: { title: string; color: string }): Promise<ChatwootLabelDto>;
addConversationLabels(chatwootConversationId: number, labels: string[]): Promise<void>;
```

**Decisión de naming (respeta la regla anti-colisión del explore §3 SIN romper la convención del port):**
el port **es** `ChatwootGateway`, así que `chatwootGateway.addConversationLabels(...)` ya es
inequívocamente Chatwoot por el receptor — igual que los métodos hermanos `sendMessage`,
`sendTemplateMessage`, `createConversationWithTemplate`, `setStatus` (NINGUNO lleva prefijo `chatwoot`).
Prefijarlos (`addChatwootConversationLabels`) leería redundante ("chatwoot chatwoot") y **rompería** esa
convención de 8 métodos existentes. La regla anti-colisión aplica a las superficies que viajan FUERA del
port y podrían chocar con el feature LOCAL `ConversationLabel`/`ConversationLabelAssignment` (Ola 5) — y
ESAS **sí** llevan el prefijo: `ChatwootLabelDto`, use cases `ListChatwootLabels`/`CreateChatwootLabel`,
ruta `/chatwoot-labels`, campo `Campaign.chatwootLabel`, componente `ChatwootLabelSelector`. (Alternativa
considerada: prefijar también los métodos del port, como sugería el hint de orquestación — **rechazada**
por inconsistencia con el port y redundancia; el prefijo se paga donde hay colisión REAL, no dentro del
receptor que ya lo desambigua.)

### D1.c — `labels: string[]` = el DELTA a agregar, NO el set completo

`addConversationLabels` recibe los labels a **agregar** (en el uso real: `[campaign.chatwootLabel]`, uno
solo). La **unión** con los labels ya presentes vive DENTRO del adapter (D2), no en el use case: el use
case NO sabe que Chatwoot reemplaza. Firma plural por generalidad/futuro, uso singular hoy.

---

## D2 — `HttpChatwootGateway`: GET-unión-POST idempotente DENTRO del adapter (mecánica invisible al use case)

**Decisión (obligatoria por la API, proposal §C): la unión vive en el adapter, no en el use case.**
Racional DIP + testeabilidad: que Chatwoot **reemplace** el set completo (`Labelable#update_labels →
update!(label_list:)`, explore §1) es conocimiento de infraestructura (mecánica HTTP). El port expresa la
INTENCIÓN ("agregá este label"); el adapter sabe el CÓMO ("GET actuales → unión → POST completo, porque
el POST pisa"). Meter la unión en el use case filtraría la semántica replace-not-add de Chatwoot al
núcleo. Esto también parte limpio el test (D7): la preservación de pre-existentes se prueba a nivel
**adapter** (fake axios), y el seam de `SendCampaign` solo verifica que se pidió agregar el label.

```ts
async listAccountLabels(): Promise<ChatwootLabelDto[]> {
  const { data } = await this.call(() => this.http.get(this.accountPath('/labels')));
  return extractRows(data).map(toLabelDto);   // {payload:[{id,title,color,...}]} → {title,color}[]
}

async createAccountLabel(params: { title: string; color: string }): Promise<ChatwootLabelDto> {
  const { data } = await this.call(() =>
    this.http.post(this.accountPath('/labels'), { title: params.title, color: params.color }));
  return toLabelDto(data.payload ?? data);   // ficha COMPLETA del catálogo (requiere admin; token `ronald` alcanza)
}

async addConversationLabels(chatwootConversationId: number, labels: string[]): Promise<void> {
  await this.call(async () => {
    // 1) GET títulos actuales — {payload:[<title strings>]} (explore §1)
    const cur = await this.http.get(this.accountPath(`/conversations/${chatwootConversationId}/labels`));
    const existing = extractRows(cur.data).filter((t): t is string => typeof t === 'string');
    // 2) unión de conjuntos (idempotente, order-stable, dedup)
    const union = Array.from(new Set([...existing, ...labels]));
    // 3) POST set COMPLETO — reemplaza, pero como es la unión NUNCA pisa labels manuales/de otra campaña
    await this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/labels`), { labels: union });
  });
}
```

- Reusa `accountPath` (`:120`), `this.call` (`:124`), `extractRows` (`:359`) — cero infra nueva de error.
- **Endpoints** (explore §1, verificados): catálogo `GET/POST /api/v1/accounts/{id}/labels`; tags de
  conversación `GET/POST /conversations/{cid}/labels` con `{labels:[...]}`.
- **Idempotente**: `union(existing, [x])` con `x ∈ existing` = no-op → reintentos/re-runs seguros.
- **`toLabelDto`** (helper nuevo, molde `toConversationDto` `:393`): `{title: r.title, color: r.color}`.
- **Colisión de título en create** (Chatwoot `title` unique por cuenta, explore §1): un duplicado
  responde 4xx → por la convención de resultado único del port cae en `ChatwootUnavailableError` (→503).
  Limitación conocida (no un 409 semántico); aceptable v1 — el Select ya muestra los existentes, el
  operador rara vez re-crea. Riesgo residual documentado (D8).

---

## D3 — Cableo del campo `Campaign.chatwootLabel` (pass-through puro, cero validación — Decisión D)

Campo aditivo por toda la cadena existente, **molde exacto de `templateName`** (nullable, opt-in):

| Capa | Archivo:línea | Cambio |
|---|---|---|
| Prisma | `schema.prisma:3270` (Campaign) | `chatwootLabel String?` (junto a `templateName`) |
| Migración | `prisma/migrations/` (timestamp posterior a hermanas en vuelo) | `ALTER TABLE "Campaign" ADD COLUMN "chatwootLabel" TEXT;` — aditiva, nullable, **sin backfill** |
| Entity | `campaign.ts:70` (Campaign) | `chatwootLabel: string \| null` |
| Repo data | `CampaignRepository.ts:14` (`CampaignCreateData`) | `chatwootLabel?: string \| null` |
| DTO input | `messaging-bulk.dto.ts:193` (`CreateCampaignInput`) | `chatwootLabel?: string` |
| Use case | `CreateCampaign.ts:112` (`campaignRepo.create({...})`) | `chatwootLabel: input.chatwootLabel ?? null` — pasa DIRECTO, **CERO validación** (Decisión D: el pick ya salió del catálogo real; re-validar acoplaría el create a la disponibilidad de Chatwoot) |
| Ruta | `messagingBulk.routes.ts:342` (POST /campaigns) | `chatwootLabel: typeof body?.['chatwootLabel'] === 'string' ? body['chatwootLabel'] : undefined` (molde `templateName` `:342`) |

**NO se expone `chatwootLabel` en `CampaignDto`/`toCampaignDto`** (`:299`) en v1 (Scope OUT §5 — auditoría
"qué label se aplicó" es follow-up trivial, no bloquea). `PrismaCampaignRepository` mapea el nuevo campo
en su `toDomain`/`create` (espejado por `InMemoryCampaignRepository`).

---

## D4 — Enganche en `SendCampaign`: `applyChatwootLabel` post-`sent`, best-effort aislado, contador = LOG-ONLY

**Punto EXACTO**: `processRecipient` (`SendCampaign.ts:183`), invocado en `:287` **DESPUÉS** de
`persistRecipientSent` (`:281`) y de `projectToInbox` (`:286`). NO necesita constructor nuevo: `SendCampaign`
YA tiene `this.chatwootGateway` inyectado (7º arg, `:75`).

```ts
// SendCampaign.ts:287 — tras projectToInbox(...)
await this.applyChatwootLabel(campaign, recipient, chatwootIds);

private async applyChatwootLabel(
  campaign: Campaign,
  recipient: CampaignRecipient,
  chatwootIds?: { chatwootConversationId: number; chatwootMessageId: number | null },
): Promise<void> {
  // gate 1 — sin label elegido = comportamiento actual exacto (Decisión E, blast radius nulo)
  if (campaign.chatwootLabel == null) return;
  // gate 2 — sin conversación Chatwoot (flag OFF / Twilio-directo): guardado-sin-efecto (Decisión E, CHW-8)
  if (!chatwootIds || !this.chatwootGateway) return;
  try {
    await this.chatwootGateway.addConversationLabels(
      chatwootIds.chatwootConversationId,
      [campaign.chatwootLabel],
    );
  } catch (err) {
    // best-effort/aislado — MISMO contrato que projectToInbox (:332): loguea y SIGUE, JAMÁS re-marca failed
    // (el envío ya está 'sent'; re-marcarlo 'failed' lo volvería re-enviable → re-envío al mismo destinatario)
    console.error(
      `[SendCampaign] etiquetado Chatwoot falló para recipient ${recipient.id} ` +
      `(campaign ${campaign.id}, conversación ${chatwootIds.chatwootConversationId}, label "${campaign.chatwootLabel}") ` +
      `— best-effort/aislado, el envío ya está 'sent':`,
      err instanceof Error ? err.message : err,
    );
  }
}
```

- **Decisión F (NUEVO y EXISTENTE con la misma mecánica) — satisfecha de gratis**: `chatwootIds.chatwootConversationId`
  viene de `createConversationWithTemplate`, que es un **find-or-create** por `source_id` (`HttpChatwootGateway.ts:267`).
  Si el destinatario ya tenía hilo, ese POST devuelve el `cid` del hilo EXISTENTE; si no, del recién creado.
  El labeling usa ese id sea cual sea su origen — cero código de bifurcación.
- **Contador `labeledCount`/`labelFailedCount` → LOG-ONLY, NO se persiste en `Campaign`.** Decidido tras
  mirar qué persiste `Campaign`: `finalize` (`:390`) **recomputa** cada contador desde `campaignRepo.listRecipients(...).total`
  por status terminal (nunca acumula en memoria, a propósito, para resume-correctness SEND-7). No hay
  columna de status de label desde donde `.total` contaría; un `labeledCount` exigiría un campo nuevo en
  `CampaignRecipient` + acumulación en memoria que `finalize` deliberadamente EVITA. Desproporcionado para
  un side-effect best-effort. Precedente directo: `projectToInbox` **loguea y no cuenta**. Observabilidad =
  `console.error` estructurado (campaignId + cid + label). Persistir un contador es follow-up (D8), igual
  que exponer `chatwootLabel` en el DTO.
- **Flag OFF a mitad de campaña** (Decisión E/CHW-8): recipient procesado por Twilio-directo → `chatwootIds`
  undefined → gate 2 saltea, sin error. El `chatwootLabel` queda **guardado sin efecto**.
- **Retry/resume** (SEND-6): un recipient ya `sent` NUNCA se re-procesa → su label no se re-aplica. Un
  `queued`/`failed` reintentado sí pasa por `applyChatwootLabel`; gracias al GET-unión-POST idempotente
  (D2), re-aplicar el mismo label es no-op semántico.

---

## D5 — Rutas de catálogo bajo `/api/messaging/bulk` + 2 use cases + permisos dos-tier (Decisión A)

**Decisión de ubicación: bajo el bulk router** (`createMessagingBulkRouter`, `messagingBulk.routes.ts:174`),
NO un router nuevo ni el de config. El picker alimenta la MISMA card "Mensaje" del composer que el sibling
`GET /bulk/templates` (`:193`, gate `messaging.templates`) — consistencia temática y de wiring. Rutas
estáticas → sin conflicto con `/campaigns/:id`.

### D5.a — Use cases nuevos (`application/use-cases/messaging/`, dependen SOLO del port — molde `ListTemplates.ts`)

```ts
// ListChatwootLabels.ts
export class ListChatwootLabels {
  constructor(private readonly chatwootGateway: ChatwootGateway) {}
  execute(): Promise<ChatwootLabelDto[]> { return this.chatwootGateway.listAccountLabels(); }
}

// CreateChatwootLabel.ts
export interface CreateChatwootLabelInput { title: string; color: string }
export class CreateChatwootLabel {
  constructor(private readonly chatwootGateway: ChatwootGateway) {}
  async execute(input: CreateChatwootLabelInput): Promise<ChatwootLabelDto> {
    const title = input.title?.trim();
    if (!title) throw new InvalidChatwootLabelError('title requerido');
    // validación de color LIGERA y LOCAL (no re-consulta catálogo): hex #RRGGBB o #RGB
    if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input.color ?? '')) throw new InvalidChatwootLabelError('color debe ser hex');
    return this.chatwootGateway.createAccountLabel({ title, color: input.color });
  }
}
```

`InvalidChatwootLabelError` (nuevo, `domain/errors/messaging-bulk.ts`, code `VALIDATION_ERROR` → **400**
en el statusMap — fix wave F4: este párrafo decía `422`, redacción incorrecta; la convención REAL del
repo para `VALIDATION_ERROR` es 400, molde exacto `InvalidTemplateInputError`/`RoleValidationError`,
verificado en `messagingBulk.routes.test.ts` — "POST /chatwoot-labels con title vacío → **400**
VALIDATION_ERROR"). Validación **local barata** (title no-vacío + color hex) — NO es la
re-validación-contra-catálogo que la Decisión D rechaza (esa es sobre el PICK al crear campaña; esto
es sanear el input de un WRITE al catálogo).

### D5.b — Rutas (molde exacto de `/templates` `:193` y `/campaigns` `:332`)

```ts
router.get('/chatwoot-labels', auth, perms.templates, async (_req, res, next) => {
  try { res.json({ data: await listChatwootLabels.execute() }); } catch (err) { next(err); }   // {data:[{title,color}]}
});
router.post('/chatwoot-labels', auth, perms.manage, async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown> | undefined;
    const dto = await createChatwootLabel.execute({
      title: typeof body?.['title'] === 'string' ? body['title'] : '',
      color: typeof body?.['color'] === 'string' ? body['color'] : '',
    });
    res.status(201).json(dto);
  } catch (err) { next(err); }
});
```

### D5.c — Permisos dos-tier (Decisión A — reusa perms existentes, CERO acción nueva)

- **`GET /chatwoot-labels` → `messaging.templates`** (`perms.templates`, ya en el router): mismo gate que
  el sibling `/templates` que alimenta la misma card. El picker es lectura para componer → tier lectura.
- **`POST /chatwoot-labels` → `messaging.manage`** (`perms.manage`, **APPENDED** a `MessagingBulkRoutePerms`
  `:31`): tier "supervisor" del repo — mintear catálogo Chatwoot (admin-only del lado Chatwoot) mapea 1:1 al
  MISMO permiso que ya gobierna canned-responses (`app.ts:3126`), config (`:3145`) y el CRUD del catálogo
  LOCAL `ConversationLabel` (`:2971`). NO se siembra permiso nuevo (ya otorgado a super_admin + administrador).
- **Interface `MessagingBulkRoutePerms`** gana `manage: RequestHandler` (además de `bulk`/`templates`).

### D5.d — Wiring `app.ts` (bloque bulk, `:3018-3077`) + composition-root pin

Los use cases se construyen desde `chatwootGatewayForBulk` (`app.ts:3018`) — **la MISMA instancia** que
`SendCampaign` recibe como 7º arg (`:3029`). Esto es el pin crítico (lección W6): las rutas del catálogo y
el labeling del send-path DEBEN pegarle a la MISMA cuenta/inbox de Chatwoot.

```ts
// dentro del bloque bulk, reusando chatwootGatewayForBulk (:3018)
app.use('/api/messaging/bulk', createMessagingBulkRouter(
  /* ...6 deps existentes..., auth, */
  { bulk: requirePerm('messaging','bulk'), templates: requirePerm('messaging','templates'),
    manage: requirePerm('messaging','manage') },        // ← perms gana `manage`
  new AuthorizeCampaignSend(campaignRepo), resolveBulkActions,
  new ListChatwootLabels(chatwootGatewayForBulk),        // ← APPENDED (al FINAL, regla anti-colisión de firma)
  new CreateChatwootLabel(chatwootGatewayForBulk),       // ← APPENDED
));
```

Args nuevos al **FINAL** de la firma de `createMessagingBulkRouter` (nunca en medio — lección de
colisiones). `messaging-bulk-composition.test.ts` (assertion estática sobre `app.ts`) gana casos: (a) las
rutas `/chatwoot-labels` montadas; (b) `ListChatwootLabels`/`CreateChatwootLabel` construidos con
`chatwootGatewayForBulk` **exacto** (misma instancia que `SendCampaign`, test (e) `:68`); (c) `perms.manage`
en la ventana de mount.

---

## D6 — Plan FE (se implementa en `ipnext-frontend` después; acá solo el plan — proposal §6)

**Card "Mensaje" del `CampaignComposer`** (`pages/whatsapp/BulkMessagingPage/components/composer/CampaignComposer.tsx`,
card líneas ~463-492, ya gateada `can('messaging.templates')` + `<Can permission="messaging.templates">`),
debajo de `VariablesMapForm`:

1. **`useChatwootLabels()`** — hook React Query (molde `useTemplates`, `hooks/useBulkMessaging.ts`) →
   `GET /api/messaging/bulk/chatwoot-labels`. **Desenvolver `res.data.data`** (el API envuelve en `{data}`;
   memoria `e2e-envelope-mock-mismatch`). Devuelve `{title,color}[]`.
2. **`ChatwootLabelSelector`** — molde `TemplateSelector`, usa el molecule `Select`
   (`@/components/molecules/Select`, PROHIBIDO `<select>` nativo). Value = `title` seleccionado (o vacío =
   sin label). **4 ramas**: `loading` (skeleton/placeholder deshabilitado), `error` (mensaje + retry),
   `empty` (catálogo vacío → texto "no hay labels" + CTA "Crear label…"), `success` (opciones con swatch de
   `color`). Placeholder "Sin etiqueta (opcional)".
3. **Flujo "Crear label…"** — mini-modal (patrón de modales del repo) con inputs **nombre** + **color**
   (color picker/hex input); submit → `POST /bulk/chatwoot-labels {title,color}` → invalida la query del
   hook (refetch) + auto-selecciona el label recién creado. Gateado `<Can permission="messaging.manage">`
   (el botón/CTA solo aparece para supervisores; el picker en sí hereda `messaging.templates` de la card).
4. **Payload** — `CreateCampaignInput` (FE `types/messagingBulk.ts`) gana `chatwootLabel?: string`, **omitido
   cuando vacío**: `...(chatwootLabel ? { chatwootLabel } : {})` (mismo criterio `manualClientIds`/`manualContacts`).
5. **Naming (riesgo colisión con el `ConversationLabelsControl`/`ConversationLabelFilter` LOCAL)** — prefijo
   `chatwoot` en TODA superficie FE nueva: `ChatwootLabelSelector`, `useChatwootLabels`, `chatwootLabel`.
   NUNCA `LabelSelector`/`useLabels` a secas (chocaría conceptualmente con el catálogo local de colores).

---

## D7 — Test plan (Strict TDD: red → green → refactor; matriz completa en spec/tasks)

- **Fakes extendidos** (test-first, sobre el PORT no el adapter):
  - `FakeChatwootGateway` (`:27`) gana: `accountLabelsResult: ChatwootLabelDto[]` + `listAccountLabels()`;
    `createAccountLabelCalls[]` + `createAccountLabelResult` + `failCreateAccountLabel`; `addConversationLabelsCalls:
    Array<{chatwootConversationId, labels: string[]}>` + `failAddConversationLabels` (molde `sendTemplateMessageCalls`
    `:158`). El fake **NO** hace unión (la unión es del adapter) — solo registra el DELTA que se le pidió agregar.
- **Adapter test** (`HttpChatwootGateway.test.ts`, fake `AxiosInstance`) — donde se prueba la mecánica GET-unión-POST:
  - `addConversationLabels(cid, ['julio'])` con GET → `['cobranzas']`: asserta POST body `{labels:['cobranzas','julio']}`
    (unión preserva pre-existentes, order-stable, dedup).
  - GET → `['julio']` + add `['julio']`: POST `{labels:['julio']}` (idempotente, sin duplicar).
  - `listAccountLabels`: `{payload:[{id,title,color}]}` → `[{title,color}]` (mapeo curado, drop `id`).
  - `createAccountLabel({title,color})`: POST `/labels` body `{title,color}` → DTO mapeado.
- **Seam tests** (`SendCampaign.test.ts` — use case REAL + fakes in-memory, lección #28, NUNCA mockear el use case):
  - flag ON + `campaign.chatwootLabel='julio'` → tras `sent`, `addConversationLabels(cid, ['julio'])` llamado
    **una vez** con el `cid` del `createConversationWithTemplate`.
  - `failAddConversationLabels=true` → recipient queda **`sent`** (NO `failed`), error logueado, el batch sigue.
  - `campaign.chatwootLabel=null` → `addConversationLabels` **nunca** llamado.
  - flag OFF (Twilio-directo, `chatwootIds` undefined) aunque haya label → `addConversationLabels` **nunca** llamado
    (guardado-sin-efecto, CHW-8).
  - re-run de un recipient `queued` con label → `addConversationLabels` re-llamado (idempotencia garantizada por el
    adapter D2, documentada); un recipient ya `sent` de corrida previa → NO re-tocado.
- **Composition-root** (`messaging-bulk-composition.test.ts`): rutas `/chatwoot-labels` montadas;
  `ListChatwootLabels`/`CreateChatwootLabel` con `chatwootGatewayForBulk` **exacto** (misma instancia que
  `SendCampaign`); `perms.manage` presente.
- **Rutas** (`messagingBulk.routes.test.ts`, supertest + fake gateway): `GET /chatwoot-labels` → 200
  `{data:[{title,color}]}`, **403 sin `messaging.templates`**; `POST /chatwoot-labels {title,color}` → 201,
  **403 con solo `messaging.templates`** (exige `messaging.manage`), **400** `VALIDATION_ERROR` con title
  vacío / color no-hex (fix wave F4 — corrige `422`, ver D5.a).
- **Pass-through** (`CreateCampaign` + ruta POST /campaigns): `chatwootLabel` persistido en `Campaign` tal cual,
  SIN llamada a Chatwoot en el create (Decisión D).
- **E2E vivo al cierre** (memoria `e2e-envelope-mock-mismatch`): list + create 1 label + 1 bulk chico contra el
  Chatwoot real de `.37`; verificar el tag sobre la conversación y la ficha en Settings > Labels.

---

## D8 — Riesgos residuales + qué NO se hace

**Riesgos residuales (aceptados/documentados):**
1. **Read-modify-write NO atómico** en `addConversationLabels` — race window si un agente edita labels en el
   instante exacto del envío bulk. Mínimo; la unión nunca pisa. Mismo patrón de cualquier RMW sobre REST no
   transaccional (proposal §C/Riesgo 1).
2. **Labeling best-effort silencioso** — si el GET-unión-POST falla en la corrida que marcó `sent`, ese
   recipient queda enviado SIN label y NO hay retry (misma deuda que `projectToInbox`). Mitigación: log
   estructurado (D4). Sin contador persistido en v1.
3. **Create → 503 en título duplicado** — la convención de resultado único del port mapea el 4xx de Chatwoot
   a `ChatwootUnavailableError` (no un 409 semántico). Aceptable v1 (D2).
4. **Catálogo casi vacío hoy (1 label `cobranzas`)** — mitigado por el propio flujo "crear label" (Scope IN).
5. **`createAccountLabel` requiere administrator en Chatwoot** — token `ronald` alcanza; si rotara a menor
   privilegio, el create 403ea (superficie de config, no de este change).

**Qué NO se hace (Scope OUT, para que el spec no lo pida):**
- NO se re-valida el label del pick contra el catálogo en `CreateCampaign` (Decisión D — no acoplar el create
  a Chatwoot).
- NO hay retry/reconciliación del labeling fallido (Decisión C — misma deuda que `projectToInbox`).
- NO se persiste `labeledCount`/`labelFailedCount` en `Campaign` (D4 — log-only; contador es follow-up).
- NO se expone `chatwootLabel` en `CampaignDto`/`GetCampaign` v1 (Scope OUT §5).
- NO se editan/borran labels del catálogo Chatwoot desde Prominense (solo list + create; rename/delete en
  Chatwoot Settings).
- NO se toca el feature LOCAL `ConversationLabel` (Ola 5) — universos distintos, prefijo `chatwoot` los separa.
- NO se agrega flag propio (Decisión E — implícitamente gated por `messaging-send-via-chatwoot`; ausencia de
  label = comportamiento actual exacto).

---

## Requirements sugeridos (el spec-phase los fija — proposal §7)

`CLBL-1` catálogo list · `CLBL-2` catálogo create ficha completa · `CLBL-3` `addConversationLabels`
GET-unión-POST idempotente · `CLBL-4` enganche best-effort post-`sent` en `SendCampaign` · `CLBL-5`
aplicación a hilo NUEVO y EXISTENTE (find-or-create id) · `CLBL-6` campo aditivo `Campaign.chatwootLabel` +
cableo DTO/ruta pass-through · `CLBL-7` permisos dos-tier (templates/manage) · `CLBL-8` semántica flag-OFF /
sin-conversación = guardado-sin-efecto. **Recomendación**: capability NUEVA `campaign-chatwoot-label`, NO
MODIFIED sobre `chatwoot-hub-sendpath` (el enganche es aditivo post-`persistRecipientSent`, como
`projectToInbox` se enganchó sin modificar SEND-2).

## Artefactos

- `openspec/changes/campaign-chatwoot-label/design.md` (este archivo)
- Engram: `topic_key: "sdd/campaign-chatwoot-label/design"`, `project: "ipnext-backend"`, `type: architecture`
- Insumos: `sdd/campaign-chatwoot-label/proposal`, `sdd/campaign-chatwoot-label/explore`
