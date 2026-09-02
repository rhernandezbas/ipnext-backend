# Exploration: external-bulk-messaging

> Endpoint en la API Externa (`/api/external/v1`, sin login de admin) para que una
> IA/skill cargue números libres + template aprobado + label Chatwoot y dispare un
> envío masivo por WhatsApp. Decisiones de producto ya LOCKED por el usuario (ver
> prompt) — este documento investiga el código real para alimentar `sdd-propose`,
> no reabre esas decisiones.

## Resumen ejecutivo

- **El 90% de la maquinaria de negocio YA EXISTE y es reusable tal cual.**
  `CreateCampaign` + `resolveCombinedRecipients` + `matchManualContacts` ya
  soportan EXACTAMENTE el caso "números libres, sin cliente" — un `manualContacts`
  sin match a `Client` entra como `clientId: null, source:'csv', status:'no_cliente'`
  y se ENVÍA igual (`matchManualContacts.ts:76`); el opt-out se re-chequea por
  SUFIJO contra `Client.whatsappOptOutAt` aunque el número no matchee ningún
  cliente (`matchManualContacts.ts:66-74`, `buildOptOutSuffixIndex`). Esto es
  literalmente la decisión LOCKED #1, ya implementada.
- **`createdById` (FK obligatoria a `RbacUser`, `onDelete: Restrict`,
  `prisma/schema.prisma:4161-4162`) se resuelve con el MISMO patrón que
  `POST /tickets` y `POST /news`**: `rbacUserRepo.findByLogin(API_USER_LOGIN)`
  (`externalV1.routes.ts:448,639`, `API_USER_LOGIN='api'` bootstrapeado
  incondicionalmente en `main.ts`). Cero diseño nuevo acá — copiar el molde.
- **La key dedicada YA es soportada por la infraestructura de middleware, sin
  tocar la global.** `createApiKeyMiddleware(configuredKey?)` (generalizado en
  `noc-alerts-hub` A18, `apiKeyMiddleware.ts:41`) acepta cualquier key explícita;
  `createApiKeyMiddleware()` sin args sigue leyendo `config.externalApi.apiKey`
  (la global, intacta). Solo falta: 1 env var nueva (`EXTERNAL_MESSAGING_API_KEY`
  o similar, patrón opt-in de `config.ts:511-513`) + montar el router de
  messaging bulk externo con `createApiKeyMiddleware(config.externalMessaging.apiKey)`.
- **Gap real #1 — auditoría de la mutación queda "anonymous".**
  `auditMutationsMiddleware` (montado global post-auth) audita TODO POST bajo
  `/api`, pero `createApiKeyMiddleware` NUNCA setea `req.user` (es M2M puro,
  `apiKeyMiddleware.ts:32`) → el audit row queda `actorId: null, actorLogin:
  'anonymous'` (`auditMutationsMiddleware.ts:130-135`). Esto es CONSISTENTE con
  `POST /tickets`/`POST /news` hoy (mismo gap, no introducido por este change),
  pero vale la pena decidir en el proposal si el nuevo endpoint quiere un evento
  de auditoría más rico (ej. incluir qué key/origen disparó, ya que a diferencia
  de tickets/news esto es GASTO de plata real).
- **Gap real #2 — el "preview con `previewId` + vencimiento" NO tiene molde
  directo en el código.** `CreateCampaign` no es un preview: persiste la
  `Campaign` (`pending`) Y sus `CampaignRecipient` de una — no hay estado
  "borrador sin persistir". Dos caminos, ver sección 4 (tradeoffs), NINGUNO
  trivial:
  - **(A) reusar `Campaign` en `pending` como preview** — barato (cero tablas
    nuevas), pero el cupo diario y el "no consumir cupo hasta enviar" (decisión
    LOCKED #4) obligan a contar el cap sobre `sentCount`/recipients realmente
    `sent`, NUNCA sobre `total`/creación — si no, cada preview no-enviado
    infla el cupo igual.
  - **(B) tabla nueva `ExternalBulkPreview`** (hash del payload + `expiresAt`) —
    más trabajo, pero separa limpiamente "propuesta" de "campaña real" y hace
    el vencimiento explícito sin heurísticas sobre campañas `pending` huérfanas.
- **Gap real #3 — el lock de envío es GLOBAL, no por-origen.**
  `CampaignRunner.CAMPAIGN_LOCK_KEY = 'messaging-campaign-send'`
  (`CampaignRunner.ts:12`) es UNA sola clave para TODO el backend — si un
  admin humano dispara una campaña desde la UI mientras la IA manda su lote,
  UNA de las dos `start()` devuelve `{accepted:false}` SIN encolar ni
  reintentar sola (`CampaignRunner.ts:75-79`). No hay cola ni backoff
  automático hoy. Si la IA manda 4 lotes seguidos, los 3 últimos rebotan salvo
  que el llamador (la skill) implemente poll+retry. Esto es comportamiento
  REAL del sistema hoy, no específico de este change, pero el nuevo endpoint
  hereda la limitación y el proposal debe decidir qué le devuelve al caller
  (409 con retry-after, o un 202 "queued" que en realidad no encola nada —
  sería engañoso).
- **`manualContacts` EXIGE `name` no-vacío** (`matchManualContacts.ts:54`,
  `assertHasRecipients`/D9) — un contacto con `phone` pero `name:''` se
  EXCLUYE con `reason:'sin_nombre'`. Para "números libres" (sin nombre real
  conocido por la IA), el endpoint nuevo necesita una convención (ej. usar el
  número mismo o un placeholder como `name`) — no es un bloqueante, es un
  detalle de mapeo en la capa route/DTO nueva, no en el use case compartido.
- **No existe ningún concepto de "costo" ($) en el codebase de mensajería.**
  `PreviewCampaignSegment` devuelve `count`/`skipped`/`statusCounts`/`sample`
  (20 items), nunca un monto. El "costo/cantidad estimada" del ask #3 del
  preview solo puede ser un CONTEO (contra los topes configurables), no un
  monto en pesos/USD — no hay tarifa de WhatsApp Business modelada en ningún
  lado del backend.
- **El label de Chatwoot NO tiene catálogo local — es SIEMPRE una consulta
  viva a Chatwoot.** `ListChatwootLabels.execute()` → `chatwootGateway.
  listAccountLabels()` (`ListChatwootLabels.ts:16`, `ChatwootGateway.ts:208`).
  "Debe existir en el catálogo" (decisión LOCKED #6) se valida en runtime
  contra ESE resultado, no contra una tabla propia — cada `/validate` que
  incluya `chatwootLabel` debe llamar a `listAccountLabels()` y chequear el
  título, exactamente como hace hoy `campaign-chatwoot-label` en el composer
  (`CreateCampaign.ts:141` es pass-through puro — CERO validación ahí; la
  validación, si se quiere, hay que agregarla en el nuevo flujo).
- **Idempotencia — molde ya construido, requiere una columna nueva.**
  `ChatMessage.idempotencyKey String? @unique` + guard-0 fast-path
  (`SendTemplateMessage.ts:116-121`) + backstop de carrera vía `@unique`
  + P2002 (`SendTemplateMessage.ts:69-73`, resuelto en el repo Prisma/
  in-memory). El `Idempotency-Key` de `POST .../send` necesita el MISMO molde,
  probablemente en `Campaign` (ej. `Campaign.externalIdempotencyKey String?
  @unique`) — no existe hoy, es trabajo nuevo pero de bajo riesgo (patrón
  probado 2 veces en el repo).
- **Kill-switch — molde exacto ya usado 5+ veces.** `flags.get(key)?.enabled
  === true`, fail-safe a OFF ante error del repo (`SendCampaign.ts:159-169`,
  `resolveViaChat`), seed vía migración `INSERT ... ON CONFLICT DO NOTHING`
  con el flag en `false` (DARK) — 5 changes hermanos ya siguen este patrón
  exacto (`iclass-gps-ingest`, `pppoe-auto-move`, `radius-auto-cure`,
  `fiber-auto-provision-watcher`, `ai-assistant-enabled`).
- **Topes configurables — molde exacto `WhatsappTaskStageTransitionConfig`/
  `FinanceReceiptSyncConfig`**: singleton `id: String @id @default("singleton")`,
  una fila, editable por `PATCH`. El endpoint de Config → WhatsApp necesita una
  card nueva (molde `ChatwootSendPathCard.tsx`, leída completa — toggle +
  confirm + banner de error "estado desconocido") + inputs numéricos para los
  2 topes (500/2000), sin molde de card específico para *números* encontrado
  en este repo (las cards de settings existentes son todas boolean/singleton
  simple) — la card nueva tendrá que combinar el patrón toggle de
  `ChatwootSendPathCard` con inputs numéricos, sin un precedente 1:1 en FE.

## Affected areas (verificado, file:line)

- `src/infrastructure/http/routes/externalV1.routes.ts` — molde de escritura
  externa (`POST /tickets` L392-487, `POST /news` L496-681): required-field
  400, resolución del reporter M2M por `API_USER_LOGIN`, 422 en errores de
  dominio tipados. El router nuevo (`external-bulk-messaging` o extensión de
  este mismo archivo) debe seguir el mismo esqueleto.
- `src/infrastructure/http/middleware/apiKeyMiddleware.ts:41` —
  `createApiKeyMiddleware(configuredKey?)` YA parametrizado; solo falta la env
  var + el wiring en `app.ts`.
- `src/infrastructure/config.ts:508-513` — patrón opt-in para la key nueva
  (`config.externalApi.apiKey`, `process.env.X ?? ''`, sin fail-fast).
- `src/infrastructure/bootstrap/bootstrapApiUser.ts` + `bootstrapSystemUsers.ts`
  — reporter M2M `API_USER_LOGIN='api'`, bootstrapeado incondicional en
  `main.ts:48`.
- `src/infrastructure/http/middleware/auditMutationsMiddleware.ts:32,130-135`
  — audita `/api/external/v1` genéricamente pero `actorLogin:'anonymous'`
  (gap heredado, no nuevo).
- `src/application/use-cases/messaging/CreateCampaign.ts` — orquesta
  validación (template aprobado, variables, permisos) + persistencia; input
  `manualContacts` es el canal correcto para números libres.
- `src/application/use-cases/messaging/matchManualContacts.ts` — matching por
  teléfono + compliance de opt-out para crudos (líneas 38-78, 111-140 el N=6
  del sufijo).
- `src/application/use-cases/messaging/resolveCombinedRecipients.ts` — unión
  dedup + caps (`MAX_MANUAL_CONTACTS=5000`, línea 37) — el nuevo cap de
  500/request es MÁS estricto y vive en una capa distinta (la ruta/use case
  nuevo), no reemplaza este.
- `src/application/use-cases/messaging/PreviewCampaignSegment.ts` — preview de
  solo lectura (`SEG-5`, sin `CampaignRepository`); no renderiza el body del
  mensaje — para el preview del ask (mensaje renderizado) hay que sumar
  `renderTemplateBody`/`resolveCampaignVariables`, ya exportados desde
  `SendCampaign.ts:499-567`.
- `src/infrastructure/scheduling/CampaignRunner.ts` — lock GLOBAL
  (`CAMPAIGN_LOCK_KEY`, línea 12), guard in-process + `PgAdvisoryLock`
  (`src/infrastructure/adapters/pg/PgAdvisoryLock.ts`), sin cola.
- `src/application/use-cases/messaging/SendTemplateMessage.ts:46-79,116-121`
  — molde de idempotencia (`idempotencyKey`, guard-0 + `@unique` backstop).
- `prisma/schema.prisma:4134-4172` (`Campaign`), `:4161-4162`
  (`createdById` FK Restrict), `:3987-4000` (`ChatMessage.idempotencyKey`),
  `:623-640` (`WhatsappTaskStageTransitionConfig`, molde singleton),
  `:2672-2692` (`FinanceReceiptSyncConfig`, molde singleton con topes
  numéricos editables).
- `src/infrastructure/http/routes/featureFlags.routes.ts` — `GET /:key`,
  `PATCH /:key` (requiere `admin.flags`); `SetFeatureFlag` hace `update`, NO
  `upsert` — la fila del flag SIEMPRE debe nacer de una migración (ver
  `20261028000000_iclass_gps_ingest_flag/migration.sql`, el propio comentario
  documenta el incidente de un flag sembrado a mano que rompió el 404).
- `ipnext-frontend/src/components/settings/ChatwootSendPathCard.tsx` — molde
  COMPLETO de card de flag (toggle + confirm doble + banner "estado
  desconocido" en error de fetch) para la card nueva de Config → WhatsApp.
- `ipnext-frontend/src/pages/whatsapp/WhatsappSettingsPage.tsx` — página
  destino de la card nueva.

## Approaches — dónde persistir el `previewId`

1. **Reusar `Campaign` en `pending` como preview** (extender lo existente)
   - Pros: cero tablas nuevas; `CreateCampaign` YA hace toda la validación
     pesada (template aprobado, variables, dedup, opt-out); `previewId` =
     `campaign.id`; `send` = `CampaignRunner.start(campaignId)` casi tal cual.
   - Cons: el "vencimiento" no tiene campo nativo (`Campaign` no tiene
     `expiresAt`) — habría que agregarlo SOLO para campañas de origen
     external, o correr un job de limpieza de `pending` externas viejas. El
     cupo diario DEBE contarse sobre recipients `sent` (no `total`/creación),
     lo cual es correcto pero exige disciplina en el query del cap (fácil de
     romper si alguien cuenta `campaign.total` por error). También: los
     `CampaignRecipient` quedan persistidos desde el "preview" aunque nunca se
     envíe — no es grave (misma huella que un draft manual hoy), pero es un
     dato a limpiar eventualmente.
   - Esfuerzo: Bajo-Medio.

2. **Tabla nueva `ExternalBulkPreview`** (hash del payload + `expiresAt`)
   - Pros: separación limpia preview/campaña real; vencimiento explícito y
     nativo; cupo diario cuenta SOLO sobre `Campaign`s realmente creadas en
     `send` (nunca sobre previews descartados) — menos superficie de error.
   - Cons: hay que RE-VALIDAR todo en `send` igual (template sigue aprobado,
     label sigue existiendo, opt-out no cambió) porque el preview es
     snapshot-en-el-tiempo — el mismo trabajo doble que ya existe hoy
     entre `CreateCampaign` (create-time) y `SendCampaign` (send-time
     re-check de opt-out, SEND-5). Construir el hash+expiresAt+dedup-de-replay
     es trabajo genuinamente nuevo (no hay molde directo en el repo).
   - Esfuerzo: Medio-Alto.

**Sugerencia (no vinculante — decisión del `sdd-propose`)**: Opción 1 con un
campo `expiresAt` nuevo en `Campaign` (nullable, solo poblado para origen
external) y el cupo diario contado por `CampaignRecipient.status='sent'` +
`sentAt` en carriles de campañas con `createdById = <api user>` filtradas por
algún marcador de origen (ver próximo punto) — reaprovecha CASI todo el código
ya probado y evita construir un segundo sistema de expiración/hash en
paralelo al de campañas reales.

## Gap no resuelto: no hay forma de distinguir "campaña externa" de "campaña de UI"

`Campaign` no tiene `source` ni `externalKeyId` — `createdById` apunta SIEMPRE
al mismo usuario `api` bootstrapeado, que HOY también es el reporter de
`POST /tickets`/`POST /news` (no es exclusivo de mensajería). Para el cupo
diario (decisión LOCKED #4, "500/request, 2000/día") hace falta ALGUNA señal
para filtrar qué `Campaign`s cuentan contra el cupo de mensajería externa.
Ninguna opción existe hoy — el `sdd-design` debe elegir entre:
- un campo nuevo `Campaign.source: String @default("ui")` (`'ui' | 'external-api'`),
  o
- un `RbacUser` DEDICADO para la key de mensajería (`API_USER_LOGIN` propio,
  ej. `'api-messaging'`), reusando el mismo bootstrap pattern pero con un
  login distinto — permite filtrar por `createdById` sin tocar el schema de
  `Campaign` en absoluto.

La segunda opción es más barata (cero migración de `Campaign`, solo un
segundo `bootstrapApiUser`-like) y separa auditoría/created-by naturalmente
sin inventar un campo `source` que años después colecciona valores basura
(riesgo ya señalado como deuda conocida en otros lados del repo, ver
`openspec/config.yaml` `known_debt`).

## Riesgos y edge cases (verificados contra el código, no supuestos)

- **Número con opt-out**: cubierto — `matchManualContacts` excluye por match
  exacto (`Client` vinculado, `whatsappOptOutAt != null`) Y por sufijo para
  crudos sin vincular (`buildOptOutSuffixIndex`, N=6 dígitos, `matchManualContacts.ts:111-140`).
- **Mismo número repetido entre lotes del día**: NO cubierto entre campañas
  distintas — el dedup de `resolveCombinedRecipients` es INTRA-campaña
  (dentro de una sola `CreateCampaign`), no hay dedup cross-campaign. Si la IA
  manda el mismo número en dos `/send` distintos el mismo día, ambos se
  envían (double-send real, doble costo) — el cupo diario limita CANTIDAD
  total, no duplicados. A documentar como riesgo aceptado o resolver en
  `sdd-design` (ej. ventana de "ya contactado hoy" — no existe hoy en ningún
  lado del código de mensajería).
- **Template con variables faltantes**: cubierto (`MissingTemplateVariablesError`,
  `CreateCampaign.ts:80-83`) — 422 antes de persistir.
- **Template con variables sobrantes**: explícitamente PERMITIDO (comentario
  CAMP-3, no bloquea).
- **Template no aprobado o inexistente**: cubierto, tratados IGUAL
  (`TemplateNotApprovedError`, `CreateCampaign.ts:72-74`), re-chequeado
  también al SEND real si el flag `messaging-send-via-chatwoot` está ON
  (`SendCampaign.ts:180-189`).
- **Label inexistente en Chatwoot**: NO validado hoy en `CreateCampaign`
  (pass-through puro, CLBL-6 Decisión D) — el nuevo endpoint externo necesita
  agregar esa validación explícitamente (ask decisión LOCKED #6), llamando
  `ListChatwootLabels` antes de aceptar.
- **Flag OFF (kill-switch de mensajería externa)**: molde listo
  (`resolveViaChat`-like, fail-safe a OFF/rechazo si el repo de flags falla)
  — a diferencia de `messaging-send-via-chatwoot` (que decide un PATH de
  envío), este flag nuevo debe ser un GATE de acceso (403/503 si OFF), más
  parecido al patrón de `apiKeyMiddleware` (`!configuredKey → 401`) que al de
  `SendCampaign`.
- **Key inválida**: cubierto por `createApiKeyMiddleware` (401, constant-time
  compare, fail-closed si la key configurada está vacía).
- **Preview vencido / reusado (replay) / payload distinto con mismo
  `previewId`**: NINGUNO tiene molde en el repo — es diseño 100% nuevo,
  cualquiera sea la opción de persistencia elegida (sección "Approaches").
  Recomendación mínima: `send` DEBE re-hashear el payload recibido y
  comparar contra el hash guardado en el preview — un payload distinto con el
  mismo `previewId` es 409/422, nunca "éxito silencioso con datos viejos".
- **Rate limit / lock del `CampaignRunner`**: confirmado GLOBAL, sin cola
  (sección "Resumen ejecutivo", gap #3). Un segundo `/send` mientras el
  primero corre devuelve `{accepted:false}` sin re-encolar — el caller debe
  reintentar. Esto es la limitación MÁS seria para "la IA manda 4 lotes
  seguidos": hoy 3 de 4 rebotan si se disparan simultáneos.

## Alcance FE mínimo (Config → WhatsApp)

- Card nueva junto a `ChatwootSendPathCard`/`ChatwootLabelsCard` en
  `WhatsappSettingsPage.tsx`: toggle del flag kill-switch (molde EXACTO de
  `ChatwootSendPathCard.tsx`, confirm + banner "estado desconocido") + 2
  inputs numéricos para los topes (por-request, diario) — sin precedente 1:1
  de "card con inputs numéricos + guardar" en `components/settings/` de este
  repo (los singletons existentes como `FinanceReceiptSyncConfig` no tienen
  su card FE localizada en esta exploración — puede no existir UI para ese
  singleton específico, o vivir en otra página no revisada). El `sdd-design`
  debe asumir que la card de topes es la PRIMERA de su tipo en este FE, sin
  molde a copiar 1:1 (sí puede componer el patrón de fetch/mutate de
  `useFeatureFlags.ts` con inputs controlados simples).

## Ready for Proposal

**Sí**, con 3 decisiones abiertas para el `sdd-propose`/`sdd-design` (ninguna
requiere al usuario — todas tienen un default razonable arriba):
1. Persistencia del preview: Campaign-pending-reusado (recomendado) vs tabla
   nueva.
2. Cómo distinguir campañas de origen externo para el cupo diario:
   `RbacUser` dedicado (recomendado) vs `Campaign.source` nuevo.
3. Contrato de "lock global ocupado" en `/send`: qué le devuelve el endpoint
   al caller (409 + retry-after explícito es lo más honesto, dado que no hay
   cola real hoy).
