# Tasks: chatwoot-new-contact-404

> **STRICT TDD activo** — RED → GREEN → REFACTOR. El test falla primero, siempre.
> Runner acotado: `npx jest src/__tests__/infrastructure/HttpChatwootGateway.test.ts`.
> **NUNCA** correr la suite completa desde este worktree.

## Fase 1 — Fundación: helpers de error (B1a)

- [x] 1.1 RED: en `HttpChatwootGateway.test.ts`, test — un rechazo con `{response:{status:404}}` en
      `POST /conversations` (sin ensure aún) deja el mensaje del `ChatwootUnavailableError` con el
      paso y el status, no `Request failed with status code 404`.
- [x] 1.2 GREEN: agregar `httpStatusOf(err): number|null` y `chatwootStepError(step, err)` en
      `HttpChatwootGateway.ts`; usarlos en el `POST /conversations` de
      `createConversationWithTemplate`. Sin tocar `this.call`.
- [x] 1.3 RED+GREEN: test — un fallo de red (sin `response`) da `— sin respuesta` en el mensaje.

## Fase 2 — Core: `ensureContactInbox` + retry (B1b)

- [x] 2.1 RED: test CHW-2 "teléfono con ContactInbox existente" — 2xx a la primera;
      `expect(http.post).toHaveBeenCalledTimes(1)` y `expect(http.get).not.toHaveBeenCalled()`.
      (Debe pasar YA: es el guard de no-regresión.)
- [x] 2.2 RED: test CHW-2 "teléfono sin contacto" — 404 en el 1er `POST /conversations`, luego
      `POST /contacts` 2xx; assertear la secuencia de `post.mock.calls` (paths + bodies) y que el
      2º `POST /conversations` usa el `source_id` de la respuesta.
- [x] 2.3 GREEN: implementar `ensureContactInbox` (rama `POST /contacts` 2xx) y el retry único en
      `createConversationWithTemplate`. `name` sólo si es no-vacío.
- [x] 2.4 RED: test CHW-2 "contacto existente sin ContactInbox" — `POST /contacts` → 422; luego
      `GET /contacts/search` y `POST /contacts/{id}/contact_inboxes`; NO se crea un 2º `Contact`.
- [x] 2.5 GREEN: implementar la rama 422 → search (q = solo dígitos, match por dígitos) →
      `POST /contacts/:id/contact_inboxes`; 0 matches → `chatwootStepError('buscar el contacto…')`.
- [x] 2.6 RED+GREEN: test CHW-2 "`source_id` con formato distinto" — Chatwoot devuelve un
      `source_id` que no es `whatsapp:+E164`; el retry MUST usar ESE valor.
- [x] 2.7 RED+GREEN: test — el ensure NO corre ante un status distinto de 404 (ej. 500):
      una sola llamada, error tipado del paso conversación.
- [x] 2.8 RED+GREEN: test CHW-7 "el ensure falla" — `POST /contacts` responde 500 → mensaje con
      `crear el contacto (POST /contacts)` + `HTTP 500`.
- [x] 2.9 REFACTOR: extraer `postConversation(sourceId, params)` para que ambos intentos compartan
      el armado del body; verificar que no queda duplicación.

## Fase 3 — Contrato y no-regresión (B2)

- [x] 3.1 Actualizar el docblock de `createConversationWithTemplate` en
      `src/domain/ports/ChatwootGateway.ts` (CHW-2): la premisa "find-or-create atómico / MUST NOT
      buscar contacto" se reemplaza por "ensure-on-404 + retry único, `source_id` leído de la
      respuesta". Idem el docblock del adapter (`HttpChatwootGateway.ts:257-267`).
- [x] 3.2 Correr `npx jest src/__tests__/application/messaging/` (acotado) — confirmar que
      `SendCampaign` sigue verde SIN cambios (`FakeChatwootGateway` no habla HTTP).
- [x] 3.3 `npx tsc --noEmit` — sin errores de tipos.

## Fase 4 — Verificación en vivo (post-deploy)

- [ ] 4.1 Confirmar que el número de smoke NO tiene contacto:
      `GET /api/v1/accounts/2/contacts/search?q=<dígitos>` → `[]`.
- [ ] 4.2 Enviar el template `ipnext_bienvenida` por la API externa de bulk (flag
      `messaging-send-via-chatwoot` ON) a ese número.
- [ ] 4.3 Verificar: recipient `sent`; existe `Contact` con su `contact_inbox`; UNA conversación;
      UN mensaje. Sin duplicados.
- [ ] 4.4 Re-enviar el recipient originalmente fallado (`+5492324505794`) — **confirmar con el
      usuario** si el smoke de 4.1-4.3 usa ese mismo número o uno controlado aparte.
- [ ] 4.5 Control de no-regresión en vivo: envío a `+5491178547218` (ya tenía `contact_inbox`)
      sigue funcionando.

## Fix wave F1 — code review post-implementación (2026-09-03)

> Red-green por finding, `HttpChatwootGateway.test.ts` acotado, después full suite.

- [x] FW1 (MEDIUM-HIGH): `POST /contacts/:id/contact_inboxes` ya NO manda `source_id` en el
      body — se deja que `ContactInboxBuilder` de Chatwoot lo genere por canal; el retry SIEMPRE
      usa el `source_id` leído de la respuesta (test con valor distinto al derivado).
- [x] FW2 (MEDIUM): `isDuplicatePhoneConflict(err)` — sólo un 422 cuyo body indica "teléfono ya
      existe" dispara la resolución por búsqueda; cualquier otro 422 propaga error tipado
      `crear el contacto (POST /contacts) — HTTP 422` sin correr la búsqueda.
- [x] FW3a (MEDIUM): `searchContactRaw` (sin pasar por `this.call`) preserva `err.response.status`
      dentro del ensure — `buscar el contacto (GET /contacts/search)` ya no dice "sin respuesta"
      ante un 500/timeout real con status HTTP conocido.
- [x] FW3b (MEDIUM): 0 coincidencias → mensaje propio exacto `sin coincidencias para <phone>`,
      distinto de "sin respuesta" (no hubo fallo HTTP).
- [x] FW4 (LOW-MEDIUM): `extractContactInboxSourceId` filtra `contact_inboxes[]` por
      `inbox.id === this.inboxId` (fallback al primero + `console.warn` si ninguno matchea).
- [x] FW5 (LOW): tests explícitos para las dos shapes reales (`contact_inbox` plano y
      `{payload:{contact,contact_inbox}}` envuelto) + `console.warn` con las keys del shape
      cuando cae al fallback derivado `whatsapp:+E164`.
- [x] FW6 (LOW): `name` se sanitiza (`trim`, tope 255 chars, se omite si queda vacío tras el trim).
- [x] Gate: `npx tsc --noEmit` limpio; suite completa `npm test` verde
      (`Tests: 88 skipped, 13289 passed, 13377 total`); `HttpChatwootGateway.test.ts` en
      72/72; `git status --short` sólo los archivos de este change.
- Gap conocido (fuera de alcance, no bloqueante): `FakeChatwootGateway` no modela
  `contact_inbox`/multi-inbox — no hacía falta tocarlo porque la firma pública del port
  (`createConversationWithTemplate`) no cambió; si un futuro fix wave necesita testear
  `ensureContactInbox` desde el use case (no sólo desde el adapter), el fake seguirá sin
  poder simularlo.
