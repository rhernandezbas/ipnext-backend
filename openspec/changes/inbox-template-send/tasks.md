# Tasks — inbox-template-send

**Change**: inbox-template-send · **Phase**: tasks
**Repos**: BE = este worktree (`feat/inbox-template-send`); FE = `ipnext-frontend` (branch NUEVO
`feat/inbox-template-send-fe` desde main — crear al arrancar el Batch 4).
**TDD estricto**: test RED primero, mínimo código, refactor. Correr SOLO los archivos de test
afectados durante el loop; `npm test` completo al cierre de cada batch.
**Colisiones**: `inbox-resolve` (en vuelo) comparte archivos append-only con este change — mapa
completo en design §Colisiones. Merge secuencial: rebase del segundo que llegue a main. OJO: el
tasks.md de inbox-resolve dice "ningún change BE toca messaging" — quedó desactualizado.
**Regla de plataforma (D2)**: el template NO abre la ventana — asertarlo explícito en TS-6/CTA-1.

---

## Batch 1 — BE: dominio + ports + fakes (MODEL-1, PORT-1, PORT-2, base TS-2)

- [x] **T1 — error nuevo `ConversationPhoneMissingError`** (TS-2)
  - Test RED: en el test del use case (T4) — pero el archivo del error se crea acá para que
    compile: `domain/errors/messaging.ts` + code `CONVERSATION_PHONE_MISSING` en el statusMap
    (`errorHandler.ts`, 422) con test del errorHandler si existe patrón (mirar cómo se testeó
    `MESSAGING_WINDOW_EXPIRED`).
  - Actualizar el doc-comment de mapping del archivo de errores (fuente única statusMap).
  - Desvío: `MESSAGING_WINDOW_EXPIRED`/`CONVERSATION_NOT_FOUND` NO tienen test dedicado de
    errorHandler (no existe `messaging.errorHandler.test.ts` — se verifican vía route tests).
    Mismo criterio aplicado acá: sin test standalone, cubierto por TS-2/HTTP-1 (use case + rutas).
- [x] **T2 — `ChatMessageRepository.upsertTemplateMessage` + in-memory** (PORT-1)
  - Test RED: `src/__tests__/infrastructure/adapters/in-memory/InMemoryChatMessageRepository.test.ts`
    (o el archivo existente del adapter) — idempotencia por `providerMessageId`, shape de la fila
    (`origin:'agent_template'`, `chatwootMessageId:null`, `campaignRecipientId:null`,
    `isPrivate:false`), aparece en `listByConversation` ordenado.
  - Código: `UpsertTemplateChatMessageInput` + método en el port (`domain/ports/
    ChatMessageRepository.ts`), `providerMessageId` en `ChatMessageRecord`, impl in-memory.
- [x] **T3 — `ConversationRepository.bumpLastMessage` + in-memory** (PORT-2)
  - Test RED: `InMemoryConversationRepository.test.ts` — escribe SOLO lastMessageAt/preview;
    canReply/status/assignee/area intactos; null si no existe.
  - Código: método en el port + impl in-memory. JSDoc: write-path separado, jamás toca el cache
    de Chatwoot (cita a D2).

## Batch 2 — BE: use case `SendTemplateMessage` (TS-1..TS-6)

- [x] **T4 — test RED completo del use case**
  - `src/__tests__/application/messaging/SendTemplateMessage.test.ts` con
    `InMemoryConversationRepository` + `InMemoryChatMessageRepository` +
    `InMemoryTemplateMessagingGateway` (NUNCA mock de Prisma):
    404 conversación; 422 sin teléfono (y fallback `toWhatsAppE164` del contactPhone crudo);
    422 template pending/inexistente; 422 variables faltantes (con `missing[]`);
    rejected/unavailable/config propagan y CERO persistencia;
    happy path (args exactos a `sendTemplate`, fila proyectada con `renderTemplateBody`, bump de
    preview, DTO devuelto); canReply/status intactos post-envío (D2); enviable con `canReply:true`;
    idempotencia del mirror por providerId; `senderName` pass-through.
  - Desvío: el escenario "fallback E164" (`contactPhoneE164:null` + `contactPhone` convertible)
    es INALCANZABLE vía `InMemoryConversationRepository.upsertByChatwootId` (ese adapter SIEMPRE
    deriva `contactPhoneE164` al escribir `contactPhone`, igual que Prisma) — se usó un fake
    puntual conforme al PORT (`fixedConversationRepo`, no un mock de Prisma) para reproducir la
    fila histórica pre-backfill.
- [x] **T5 — código mínimo del use case**
  - `src/application/use-cases/messaging/SendTemplateMessage.ts` — orden de guards PINNED (TS-1),
    reuso de `renderTemplateBody` (import desde `./SendCampaign`), deps por ports (DIP).
- [x] **Gate Batch 1+2**: suites de application + adapters in-memory verdes.

## Batch 3 — BE: migración + adapters Prisma + rutas + wiring (MODEL-1, HTTP-1..3)

- [x] **T6 — migración `providerMessageId`** (MODEL-1)
  - `npm run prisma:migrate` (nombre sugerido `chatmessage_provider_message_id`) — columna
    `String? @unique`. Jamás SQL a mano.
  - Desvío: sin `DATABASE_URL`/Postgres vivo en este worktree, `prisma migrate dev` no puede
    correr (requiere conexión). Se usó `npx prisma migrate diff --from-schema <HEAD:schema.prisma>
    --to-schema prisma/schema.prisma --script` (diff ESTÁTICO entre dos snapshots del schema, sin
    tocar ninguna DB — sigue siendo el tooling de Prisma, CERO SQL a mano) para generar el SQL
    exacto, timestamp `20260911000000` (posterior a `20260910000000`). Migración pendiente de
    `prisma migrate deploy` en un entorno con DB real antes de mergear a producción.
- [x] **T7 — adapters Prisma** (PORT-1, PORT-2)
  - Test RED: siguiendo el patrón de tests Prisma existente del feature
    (`PrismaConversationRepository.orderBy.test.ts` como molde de nivel de aserción) para el shape
    del upsert/update; si el patrón del repo es cubrirlos vía route-tests, documentarlo en el PR.
  - Código: `PrismaChatMessageRepository.upsertTemplateMessage` (upsert por `providerMessageId`) +
    `PrismaConversationRepository.bumpLastMessage` (update escueto de 2 campos). Comment-block
    cross-ref al in-memory (los adapters no pueden divergir).
  - Nuevos: `PrismaConversationRepository.bumpLastMessage.test.ts` +
    `PrismaChatMessageRepository.upsertTemplateMessage.test.ts` (mismo molde `.orderBy.test.ts`:
    Prisma mockeado a nivel adapter-intention, pinea `where`/`data`/`create` exactos).
- [x] **T8 — rutas + factory** (HTTP-1, HTTP-2)
  - Test RED: `src/__tests__/infrastructure/messaging.routes.test.ts` (o archivo nuevo
    `sendTemplate.routes.test.ts` espejo del patrón) — 401/403 en ambas rutas; 400 body malformado
    (templateRef ausente/no-string; variables con valor no-string) SIN invocar el use case; 201
    happy + mensaje visible en `GET .../messages`; 422/503 tipados vía errorHandler; GET
    `/send-templates` 200 `{data}` con el catálogo del fake; no-regresión de las rutas previas
    con la factory extendida (HTTP-3).
  - Código: 2 rutas en `createMessagingRouter` (+2 args), parsing inline molde `/messages`.
  - Desvío: se agregaron los 2 args nuevos AL FINAL de la firma de `createMessagingRouter` (no
    intercalados) — mismo criterio append-only del design §Colisiones, minimiza el diff contra el
    worktree paralelo `inbox-resolve-be`.
- [x] **T9 — wiring `app.ts`** (HTTP-3)
  - `TwilioContentGateway` propio del bloque messaging + `ListMessagingTemplates` +
    `SendTemplateMessage` cableados. Sin variables compartidas con los bloques bulk/CRUD
    (precedente anti-interleave).
- [x] **Gate Batch 3**: `npm test` completo BE verde. NO `npm run build` (regla del repo).

## Batch F — Fix wave (review adversarial post-Batch 3): 1 ALTO + 1 MEDIO + 2 LOW

Disparado por el review adversarial sobre el estado EN PROD de Batch 1-3. Commit
`fix(inbox-template): idempotency-key server-side + pins (review)`.

- [x] **F1 — idempotencyKey server-side (H1, ALTO — decisión del usuario)** (TS-idempotencia)
  - Contrato: `POST .../send-template` gana `idempotencyKey?: string` en el BODY (UUID del FE,
    generado al abrir el confirm). Documentado en design D5 (reemplaza la mitigación solo-FE
    original) + spec `TS-idempotencia`/HTTP-1 scenarios nuevos.
  - Migración aditiva `20260921000000_chatmessage_idempotency_key` —
    `ChatMessage.idempotencyKey String? @unique` (timestamp posterior a TODA migración hermana en
    vuelo detectada: `bulk-csv-recipients-be` tenía `20260920000000`). Generada vía
    `prisma migrate diff` estático (mismo criterio que T6, sin DB viva en el worktree).
  - Port: `ChatMessageRecord.idempotencyKey` + `UpsertTemplateChatMessageInput.idempotencyKey?` +
    método NUEVO `findByIdempotencyKey`. Ambos adapters (`InMemory`/`Prisma`) implementan la MISMA
    semántica, incluido el backstop de carrera (P2002 en `idempotencyKey` → recupera la fila
    ganadora en vez de 500/duplicar).
  - Use case: guard 0 (fast path, ANTES de los guards 1-5 PINNED D9) + retorno
    `{message, deduped}` (breaking change del retorno de `execute`, propagado a los 2 tests TS-6
    que capturaban el DTO directo).
  - Ruta: parsing de `idempotencyKey` (400 si presente y no-string-no-vacío) + status 200
    (`deduped:true`) vs 201 (`deduped:false`), mismo body en ambos casos.
  - Tests (RED→GREEN por capa): `InMemoryChatMessageRepository.test.ts` (+7),
    `PrismaChatMessageRepository.upsertTemplateMessage.test.ts` (+7, incluye backstop de carrera
    mockeando P2002), `SendTemplateMessage.test.ts` (+3 TS-idempotencia), `messaging.routes.test.ts`
    (+5 H1).
- [x] **F2 — nota de merge H2 (MEDIO)**: `git merge-tree` contra `main` predijo conflicto textual en
  `InMemoryConversationRepository.test.ts` — `inbox-resolve` (YA en `main`, `abc85a34`) y este change
  insertaron un `describe` nuevo en el MISMO anchor (justo después de `'list returns an empty page'`).
  Mitigado: el describe `bumpLastMessage` se movió al FINAL del archivo (después de `§8 —
  tiebreaker…`), anchor que `inbox-resolve` nunca tocó — el merge/rebase futuro contra `main` queda
  como append simple, sin conflicto textual. Documentado en design §Colisiones. Verificado con
  `git merge-tree` antes/después + suite del archivo sigue verde (10/10).
- [x] **F3 — composition pin sobre `createApp()` real (H3, LOW)**: nuevo describe en
  `messaging-composition.test.ts` que BOOTEA `createApp()` de verdad (verificado empíricamente: no
  requiere DB viva para construirse) y ejercita `POST .../send-template` + `GET /send-templates`
  con supertest — 401 sin sesión (no 404), + control de una ruta inexistente de verdad (404). Spec
  `COMP-1`.
- [x] **F4 — precedencia de guards cruzada (H4, LOW)**: 1 test en `SendTemplateMessage.test.ts` —
  conversación sin teléfono Y template pending simultáneamente → gana `ConversationPhoneMissingError`
  (guard 2, corre antes que guard 3 en el orden lineal PINNED D9). Documentado en design D9 + spec
  `GUARD-PREC-1`.
- [x] **Gate Batch F**: tests dirigidos de las 4 capas tocadas verdes + `npx prisma generate` fresco
  + `tsc --noEmit` limpio. NO `npm run build`, NO suite completa (regla del fix wave).

## Batch 4 — FE: capa de datos (WAPI-1, ERR-1 códigos)

- [ ] **T10 — api client**
  - Test RED: `src/__tests__/api/whatsapp.api.test.ts` — unwrap `{data}` del GET; POST flat con
    `{templateRef, variables, idempotencyKey}`; template sin variables manda `variables:{}`.
  - Código: `listSendableTemplates` + `sendWhatsappTemplate` en `api/whatsapp.api.ts`; import de
    `TemplateSummaryDto` desde `types/messagingBulk.ts` (reuso, cero duplicación).
  - **OJO (fix wave F1, contrato H1)**: `sendWhatsappTemplate` MUST aceptar `idempotencyKey` en el
    payload — ver design D11 "CONTRATO H1 para el apply FE" (UUID generado al abrir el modal de
    confirm, reusado en reintentos del MISMO intento, uno nuevo por cada apertura del panel). El BE
    ya está en prod esperando este campo (opcional — sin él sigue funcionando, sin dedup).
- [ ] **T11 — hooks**
  - Test RED: test de hooks (molde de los tests de `useWhatsapp`/`useBulkMessaging`) —
    `useSendableTemplates` gateado por `enabled` + staleTime; `useSendWhatsappTemplate`:
    onSuccess appendea al cache de mensajes (dedup por id) + invalida conversations root; keys
    derivadas de `vars.convId`; `isPending` scoped por convId.
  - Código: ambos hooks en `hooks/useWhatsapp.ts` (keys nuevas exportadas).
- [ ] **T12 — mapSendError extendido** (ERR-1)
  - Test RED: `src/__tests__/utils/mapSendError.test.ts` — 6 códigos nuevos + default intacto.
  - Código: `utils/mapSendError.ts`.

## Batch 5 — FE: UI (CTA-1, PICK-1, VAR-1, SEND-1, A11Y-1)

- [ ] **T13 — CTA en el Composer** (CTA-1)
  - Test RED: `Composer.test.tsx` (extender) — CTA SOLO en la rama expirada; ausente en
    verificando/error/abierta/nota; composer sigue disabled tras un envío exitoso (mock del
    panel).
  - Código: `Composer.tsx` — botón + estado `templatePanelOpen` + mount del panel con
    `key={conversationId}`.
- [ ] **T14 — `TemplateSendPanel`: catálogo 4 ramas + picker** (PICK-1)
  - Test RED: `TemplateSendPanel.test.tsx` — 4 ramas; solo `sendable` listados; retry en error.
  - Código: componente nuevo en `WhatsappInboxPage/components/` + module.css (tokens del design
    system del inbox).
- [ ] **T15 — variables + preview + gate de confirm** (VAR-1, SEND-1 gate)
  - Test RED: inputs por variable declarada con labels; preview vivo con valor tipeado y
    pendiente señalizado; confirm disabled hasta completar; template sin variables habilita
    directo.
  - Código: sub-secciones del panel (helpers propios inspirados en `splitTemplateBody`/
    `renderPreviewMessage` — NO importar los del bulk si el shape difiere; decidir en apply
    import vs clon documentado).
- [ ] **T16 — envío + éxito + errores + a11y** (SEND-1, ERR-1, A11Y-1)
  - Test RED: happy path (POST correcto, mensaje en el hilo vía cache, cierre, foco al CTA,
    announcement); isPending deshabilita confirm; error 422/503 → copy de `mapSendError` en
    `role="alert"` con panel abierto; dialog a11y (role/aria-modal/labelledby, Esc, backdrop,
    focus-return); flujo completable por teclado.
  - Código: integración con `useSendWhatsappTemplate` + a11y molde `PreviewModal`. Motion según
    Emil (transform+opacity, `prefers-reduced-motion`) — SOLO en esta task, no antes.
- [ ] **Gate Batch 5**: suite FE completa verde.

## Batch 6 — Cierre

- [ ] **T17 — E2E vivo (innegociable, memoria `e2e-envelope-mock-mismatch`)**
  - Contra el BE real (dev): catálogo desenvuelve `{data}`; POST feliz con un template aprobado
    real (número de prueba); mensaje visible en el hilo y preview de la lista bumpeado; el
    composer sigue bloqueado (ventana NO abierta); 422 real eligiendo template no aprobado vía
    API cruda.
- [ ] **T18 — colisión re-check + docs**
  - `git log main..` de `inbox-resolve`: si ya mergeó, rebase y re-verificar `messaging.routes.ts`
    / `ConversationRepository.ts` / archivos FE compartidos. Avisar al orquestador que el
    "ningún change toca messaging" de inbox-resolve quedó stale.
- [ ] **T19 — verify + archive** (fases sdd-verify / sdd-archive del ciclo)
