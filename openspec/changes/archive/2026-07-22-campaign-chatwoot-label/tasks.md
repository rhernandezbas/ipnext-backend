# Tasks — campaign-chatwoot-label

**Change**: campaign-chatwoot-label · **Phase**: tasks · **Repo BE**: este worktree
(`.claude/worktrees/campaign-chatwoot-label-be`, `feat/campaign-chatwoot-label`). **Repo FE**:
`ipnext-frontend` — sección aparte al final, DESPUÉS del BE (D6).
**TDD estricto**: RED → GREEN → refactor. Adapters in-memory para use cases (`InMemory*Repository`,
`FakeChatwootGateway`), JAMÁS mockear Prisma ni el use case (lección #28 — seam completo).
**Dependencias entre batches**: B1 (schema) → B2 (port/adapter) → {B3, B4, B5} paralelizables entre sí
una vez B2 está verde (B4 solo necesita el port extendido, no B3/B5) → B6 (wiring, depende de B2/B3/B5
completos). B4 puede correr en paralelo a B3/B5 pero B6 los necesita a todos.

---

## Batch 1 — Schema aditivo `Campaign.chatwootLabel` (D3, CLBL-6)

- [ ] **1.1** Migración `prisma migrate diff` (sin DB viva, molde `chatwoot_sendpath_delivery_status`):
  timestamp posterior a `20261018000000_chatwoot_sendpath_delivery_status` (verificado — ningún
  worktree hermano en vuelo pasa ese timestamp), sugerido `20261019000000_campaign_chatwoot_label`.
  Contenido: `ALTER TABLE "Campaign" ADD COLUMN "chatwootLabel" TEXT;` — aditiva, nullable, sin
  backfill, sin tocar `CampaignRecipient`.
- [ ] **1.2** `prisma/schema.prisma:3270` (model `Campaign`): agregar `chatwootLabel String?` junto a
  `templateName` (post `prisma generate`) — test: N/A (schema), verificado por 1.3-1.5.
- [ ] **1.3** `domain/entities/campaign.ts:70`: `Campaign` gana `chatwootLabel: string | null`.
- [ ] **1.4** `domain/ports/CampaignRepository.ts:14` (`CampaignCreateData`): gana
  `chatwootLabel?: string | null`.
- [ ] **1.5** RED+GREEN `InMemoryCampaignRepository` + `PrismaCampaignRepository`: mapean
  `chatwootLabel` en `create`/`toDomain` — test: crear campaña con `chatwootLabel:'promo-julio'` →
  se lee de vuelta igual; crear sin el campo → `null` (CLBL-6 pass-through, sin catálogo).
- [ ] **Gate B1**: `npx prisma generate` limpio; suites de `CampaignRepository` (in-memory + Prisma)
  verdes.

## Batch 2 — Extensión del port `ChatwootGateway`: 3 métodos (D1, D2, CLBL-1/2/3)

- [ ] **2.1** `domain/ports/ChatwootGateway.ts:88-191` gana (D1.b, sin prefijo `chatwoot` en los
  nombres — el receptor ya desambigua):
  - `ChatwootLabelDto {title: string; color: string}` co-located (molde `ChatwootConversationDto:8`,
    **sin `id`** — D1.a, YAGNI, los tags de conversación son title-keyed).
  - `listAccountLabels(): Promise<ChatwootLabelDto[]>`.
  - `createAccountLabel(params: {title: string; color: string}): Promise<ChatwootLabelDto>`.
  - `addConversationLabels(chatwootConversationId: number, labels: string[]): Promise<void>` — recibe
    el DELTA a agregar, no el set completo (D1.c).
- [ ] **2.2** RED+GREEN `FakeChatwootGateway` (`__tests__/helpers/FakeChatwootGateway.ts:27`, molde
  `sendTemplateMessageCalls:158`): `accountLabelsResult` + `listAccountLabels()`;
  `createAccountLabelCalls[]` + `createAccountLabelResult` + `failCreateAccountLabel`;
  `addConversationLabelsCalls: Array<{chatwootConversationId, labels: string[]}>` +
  `failAddConversationLabels`. El fake **NO** hace unión (eso es del adapter, D2) — solo registra el
  delta pedido.
- [ ] **2.3** RED `__tests__/infrastructure/HttpChatwootGateway.test.ts` — describe `listAccountLabels`:
  GET `accountPath('/labels')`; `{payload:[{id,title,color}]}` → `[{title,color}]` (drop `id`,
  CLBL-1); fallo axios (red/timeout/4xx/5xx) → `ChatwootUnavailableError`.
- [ ] **2.4** RED `HttpChatwootGateway.test.ts` — describe `createAccountLabel`: POST
  `accountPath('/labels')` body `{title,color}` exacto → DTO mapeado desde `data.payload ?? data`
  (CLBL-2); título rechazado por Chatwoot (duplicado, 4xx) → propaga `ChatwootUnavailableError` **sin
  persistir nada** (CLBL-2 scenario "rechazo propaga").
- [ ] **2.5** RED `HttpChatwootGateway.test.ts` — describe `addConversationLabels` (D2, la mecánica
  invisible al use case): GET `accountPath('/conversations/:cid/labels')` → `['cobranzas']`, add
  `['promo-julio']` → POST body `{labels:['cobranzas','promo-julio']}` (une, preserva pre-existentes,
  order-stable, dedup, CLBL-3 "no pisa manuales"); GET → `['julio']` + add `['julio']` → POST
  `{labels:['julio']}` (idempotente, sin duplicar, CLBL-3 "idempotente en reintento"); fallo del GET o
  del POST → `ChatwootUnavailableError`.
- [ ] **2.6** GREEN — `HttpChatwootGateway.ts`: implementación de los 3 métodos reusando
  `accountPath`, `this.call:124`, `extractRows:359`; helper `toLabelDto` nuevo (molde
  `toConversationDto:393`).
- [ ] **Gate B2**: `HttpChatwootGateway.test.ts` + `FakeChatwootGateway` verdes; `tsc --noEmit` limpio
  (el port extendido no rompe otros implementores).

## Batch 3 — Pass-through `chatwootLabel` en `CreateCampaign` + ruta (D3, CLBL-6)

- [ ] **3.1** `application/dto/messaging-bulk.dto.ts:193` (`CreateCampaignInput`) gana
  `chatwootLabel?: string`.
- [ ] **3.2** RED+GREEN `application/messaging/CreateCampaign.test.ts` — extender: input con
  `chatwootLabel:'promo-julio'` → `campaignRepo.create({...})` recibe el valor tal cual, **cero**
  llamada a `chatwootGateway` (Decisión D, no re-valida contra catálogo); input SIN el campo →
  persiste `null`, sin cambios (CLBL-6 scenario "pass-through sin validar, y ausencia intacta").
  GREEN: `CreateCampaign.ts:112` → `chatwootLabel: input.chatwootLabel ?? null`.
- [ ] **3.3** RED+GREEN `__tests__/infrastructure/messagingBulk.routes.test.ts` — extender POST
  `/campaigns` (`messagingBulk.routes.ts:342`, molde `templateName`): body con `chatwootLabel`
  string → parseado y pasado al use case; ausente/no-string → `undefined`, sin romper el resto del
  parseo.
- [ ] **Gate B3**: `CreateCampaign.test.ts` + `messagingBulk.routes.test.ts` verdes.

## Batch 4 — `applyChatwootLabel` en `SendCampaign.processRecipient` (D4, CLBL-4/5/8)

- [ ] **4.1** RED completo — extender `application/messaging/SendCampaign.test.ts` (use case REAL +
  `InMemoryCampaignRepository` + `FakeChatwootGateway`, NUNCA mockear el use case):
  - `campaign.chatwootLabel='promo-julio'` + recipient `sent` con `chatwootConversationId` (hilo
    NUEVO, id de `createConversationWithTemplate`) → tras `persistRecipientSent`+`projectToInbox`, se
    invoca `addConversationLabels(cid, ['promo-julio'])` **una vez** (CLBL-4/5 "hilo nuevo").
  - mismo caso pero recipient con `chatwootConversationId` **preexistente** (hilo YA existía) → misma
    invocación, sin bifurcación de código (CLBL-5 "hilo existente").
  - `failAddConversationLabels=true` en 1 de 3 recipients → los 3 quedan `sent`, el batch llega a
    `done`, el 2do sin label, error logueado (`console.error` spy) — **NUNCA** re-marca `failed`, NUNCA
    toca `sentCount` (CLBL-4 scenario "Chatwoot caído en 1 de N").
  - `campaign.chatwootLabel=null` → `addConversationLabels` **nunca** invocado (gate 1, CLBL-8
    implícito, blast radius nulo).
  - flag `messaging-send-via-chatwoot` OFF (Twilio-directo, `chatwootIds` undefined) aunque
    `chatwootLabel` esté seteado → `addConversationLabels` **nunca** invocado (CLBL-8 "flag OFF
    durante todo el envío", guardado-sin-efecto).
  - resume: recipient ya `sent` de una corrida previa → NO se reprocesa, **cero** nueva llamada a
    `addConversationLabels` (CLBL-8 "resume no re-etiqueta", SEND-6).
  - recipient `queued`/`failed` reintentado SÍ pasa por `applyChatwootLabel` (idempotente por el
    GET-unión-POST del adapter, D2 — sin duplicar).
- [ ] **4.2** GREEN — `SendCampaign.ts:287` (tras `projectToInbox:286`): método privado
  `applyChatwootLabel(campaign, recipient, chatwootIds)` — gate 1 `chatwootLabel==null` → return;
  gate 2 `!chatwootIds || !this.chatwootGateway` → return; try `addConversationLabels(cid,
  [chatwootLabel])`, catch → `console.error` estructurado (campaignId+cid+label) y sigue — MISMO
  contrato que `projectToInbox:332` (D4, best-effort/aislado).
- [ ] **Gate B4**: `SendCampaign.test.ts` completo verde, incl. las suites previas de
  `chatwoot-hub-sendpath` intactas (regresión-check, sin tocar `sent`/`failed`/dedup/contadores).

## Batch 5 — Rutas catálogo `/chatwoot-labels` + 2 use cases + permisos dos-tier (D5, CLBL-1/2/7)

- [ ] **5.1** `domain/errors/messaging-bulk.ts` (molde `InvalidTemplateInputError`): nuevo
  `InvalidChatwootLabelError extends DomainError` — code `VALIDATION_ERROR`/422 en el statusMap del
  errorHandler. Test: vía 5.3 (sin test standalone, mismo criterio que `MESSAGING_WINDOW_EXPIRED`).
- [ ] **5.2** RED+GREEN `application/use-cases/messaging/ListChatwootLabels.ts` (molde
  `ListTemplates.ts`, depende SOLO del port) + `__tests__/application/messaging/
  ListChatwootLabels.test.ts` (molde `ListTemplates.test.ts`): `execute()` delega en
  `chatwootGateway.listAccountLabels()`, retorna tal cual (CLBL-1).
- [ ] **5.3** RED+GREEN `application/use-cases/messaging/CreateChatwootLabel.ts` +
  `__tests__/application/messaging/CreateChatwootLabel.test.ts`: `title` vacío/whitespace → 422
  `InvalidChatwootLabelError`; `color` no-hex (regex `#RGB`/`#RRGGBB`) → 422
  `InvalidChatwootLabelError`; válido → delega en `chatwootGateway.createAccountLabel({title,color})`
  (validación LOCAL barata, NO re-consulta catálogo — D5.a, distinta de la Decisión D que aplica al
  pick en `CreateCampaign`). **Anotar en el test**: Chatwoot v4.13 (`app/models/label.rb`, verificado
  del orquestador 2026-07-22) hace `before_validation` **downcase** automático del `title` + formato
  `UNICODE_CHARACTER_NUMBER_HYPHEN_UNDERSCORE` (letras unicode/números/`-`/`_`, SIN espacios) +
  unicidad por cuenta (`title`+`account_id`). Este use case pasa-through el `title` tal cual (D5.a no
  normaliza — normalización es responsabilidad del FE, tarea FE.3); documentar en el test-comment que
  un `title` con espacios/mayúsculas llega íntegro al adapter y es Chatwoot quien lo downcasea/valida,
  no un 422 local por eso.
- [ ] **5.4** RED+GREEN `messagingBulk.routes.ts:174` (molde `/templates:193` y `/campaigns:332`):
  - `MessagingBulkRoutePerms` (interface) gana `manage: RequestHandler` (junto a `bulk`/`templates`).
  - `GET /chatwoot-labels` gate `perms.templates` → `listChatwootLabels.execute()` → `{data:
    [{title,color}]}`.
  - `POST /chatwoot-labels` gate `perms.manage` → parsea `{title,color}` del body →
    `createChatwootLabel.execute(...)` → 201 con el DTO.
- [ ] **5.5** RED+GREEN `__tests__/infrastructure/messagingBulk.routes.test.ts` (supertest + fake
  gateway): `GET /chatwoot-labels` → 200 `{data:[{title,color}]}`; **403 sin `messaging.templates`**
  (CLBL-7). `POST /chatwoot-labels {title,color}` válido → 201; **403 con solo `messaging.templates`**
  (exige `messaging.manage`, CLBL-7 "ambos reciben 403, sin invocar el port"); **422** con `title`
  vacío / `color` no-hex (CLBL-2 rechazo local antes de tocar el gateway).
- [ ] **Gate B5**: suites de `ListChatwootLabels`, `CreateChatwootLabel`, `messagingBulk.routes.test.ts`
  verdes.

## Batch 6 — Wiring `app.ts` + composition-root pin (D5.d, lección W6)

- [ ] **6.1** RED — extender `__tests__/infrastructure/messaging-bulk-composition.test.ts`: (a) rutas
  `/chatwoot-labels` (GET+POST) montadas bajo `/api/messaging/bulk`; (b) `ListChatwootLabels` y
  `CreateChatwootLabel` construidos con `chatwootGatewayForBulk` **exacto** (misma instancia que
  recibe `SendCampaign` como 7º arg, `app.ts:3029` — el pin crítico, sin él el labeling del send-path
  y el catálogo pegan a cuentas Chatwoot distintas); (c) `perms.manage` presente en la ventana de
  mount del router bulk.
- [ ] **6.2** GREEN — `app.ts` (bloque bulk, `:3018-3077`): `new ListChatwootLabels
  (chatwootGatewayForBulk)` + `new CreateChatwootLabel(chatwootGatewayForBulk)` APPENDED al final de
  la firma de `createMessagingBulkRouter` (nunca en medio); `perms` objeto gana `manage:
  requirePerm('messaging','manage')`.
- [ ] **Gate B6**: `npm test` completo del BE verde. NO `npm run build` (regla del repo).

## Batch F (reservado) — Fix wave post-review adversarial

Sin tasks pre-definidas — se completa tras el review adversarial de B1-B6, molde
`chatwoot-hub-sendpath` Batch F (severidad ALTO/MEDIO/LOW por finding).

---

## Sección FE (repo `ipnext-frontend` — DESPUÉS del BE, D6)

- [ ] **FE.1** `hooks/useBulkMessaging.ts`: `useChatwootLabels()` (molde `useTemplates`, React Query)
  → `GET /api/messaging/bulk/chatwoot-labels`, desenvuelve `res.data.data` (memoria
  `e2e-envelope-mock-mismatch`) → `{title,color}[]`. Test: hook devuelve el catálogo desenvuelto.
- [ ] **FE.2** `ChatwootLabelSelector` (molde `TemplateSelector`, `@/components/molecules/Select`,
  PROHIBIDO `<select>` nativo) en la card "Mensaje" del `CampaignComposer.tsx` (~líneas 463-492,
  debajo de `VariablesMapForm`), gateada `<Can permission="messaging.templates">`. 4 ramas:
  loading/error/empty ("no hay labels" + CTA "Crear label…")/success (swatch de `color`).
  Placeholder "Sin etiqueta (opcional)". Test Vitest: las 4 ramas renderizan correcto.
- [ ] **FE.3** Mini-modal "Crear label…" (patrón de modales del repo, gateado `<Can
  permission="messaging.manage">`): inputs nombre + color picker (default `#1f93ff`, molde D2 de
  Chatwoot). **Normalización visible OBLIGATORIA** (cierra la nota abierta del spec, dato verificado
  del orquestador 2026-07-22 sobre `app/models/label.rb`): input muestra transformación en vivo
  lowercase + espacios→`-`, con **preview del título final** que se va a enviar; validación de
  charset (`UNICODE_CHARACTER_NUMBER_HYPHEN_UNDERSCORE` — letras/números/`-`/`_`, sin otros símbolos)
  antes de habilitar submit. Submit → `POST /bulk/chatwoot-labels {title: normalizado, color}` →
  invalida la query de FE.1 (refetch) + auto-selecciona el label recién creado. Test: "Promo Julio" →
  preview `promo-julio`; charset inválido (ej. `!`) → submit deshabilitado con mensaje.
- [ ] **FE.4** `types/messagingBulk.ts` (`CreateCampaignInput`): gana `chatwootLabel?: string`,
  **omitido cuando vacío** (`...(chatwootLabel ? {chatwootLabel} : {})`, mismo criterio
  `manualClientIds`/`manualContacts`). Test: payload de creación sin label elegido no incluye la key.
- [ ] **FE.5** Naming anti-colisión (riesgo con `ConversationLabelsControl`/`ConversationLabelFilter`
  LOCAL): prefijo `chatwoot` en TODA superficie nueva — `ChatwootLabelSelector`, `useChatwootLabels`,
  `chatwootLabel`. Test de lint/nombre si el repo lo tiene, si no verificación manual en review.

---

## Coordinación de merges

Este change y `bulk-task-recipients` (worktree hermano, en vuelo) tocan los MISMOS archivos:
`resolveCombinedRecipients` / uniones de `RecipientSource` y DTOs, y el `CampaignComposer` FE (tabs
del composer). **D10 de `bulk-task-recipients/design.md` fija el orden explícitamente**: "si csv/label
aterrizan antes, rebasar sobre ellos" — es decir, `campaign-chatwoot-label` es el **primero** en
mergear (junto a `bulk-csv-recipients`, ya base) y `bulk-task-recipients` es el **segundo**, que
rebasea sobre este change una vez mergeado. Puntos de colisión a vigilar en el rebase del segundo: (a)
el array de tabs/cards del `CampaignComposer` (este change agrega la card "Mensaje" con el selector,
D6 — append, no reescritura); (b) el bloque de wiring en `app.ts` (self-contained, molde
noc-broadcast, no interleava con el bloque de este change en `:3018-3077`); (c) `CreateCampaignInput`
del DTO/FE (ambos changes agregan campos opcionales al mismo tipo — orden de merge de líneas, no de
lógica). Ninguna colisión de LÓGICA: todo aditivo en ambos lados.

---

## Desvíos/notas detectadas en esta fase (spec↔design)

- **Cierra la "Nota abierta" del spec (CLBL-2/formato de `title`)** — verificación del orquestador
  2026-07-22 sobre `app/models/label.rb` (Chatwoot v4.13, container real): `title` se
  **downcasea automáticamente** vía `before_validation`; formato validado
  `UNICODE_CHARACTER_NUMBER_HYPHEN_UNDERSCORE` (letras unicode + números + `-`/`_`, sin espacios);
  unicidad por `title`+`account_id` (índice UNIQUE); color default `#1f93ff`. **Decisión tomada para
  B5/CreateChatwootLabel (5.3)**: el use case BE sigue pass-through puro (NO normaliza, NO valida
  charset — deja que Chatwoot downcasee/rechace, mapeado a `ChatwootUnavailableError` vía D2 si
  rechaza). La normalización VISIBLE (lowercase + espacios→`-` + preview + validación de charset) se
  empuja al mini-modal FE (FE.3) porque es ahí donde el operador necesita ver ANTES de submitear qué
  título real va a quedar — evita sorpresas silenciosas de downcase server-side. Color picker FE
  default `#1f93ff` (FE.3) alinea con el default real de Chatwoot.
- **`chatwootGatewayForBulk` es la MISMA instancia que consume `SendCampaign`** (pin D5.d/6.1) — si
  se rompe este pin, el catálogo listado en el picker y el labeling del send-path pegarían a cuentas
  Chatwoot distintas sin error visible (lección W6, ya mordió en `chatwoot-hub-sendpath`).
- **Colisión de título en create (5.3/2.4) mapea a 503, no 409** — limitación conocida y aceptada
  (D2/D8): la convención de resultado único del port no distingue 4xx semánticos. Riesgo residual
  documentado, no bloqueante v1.
