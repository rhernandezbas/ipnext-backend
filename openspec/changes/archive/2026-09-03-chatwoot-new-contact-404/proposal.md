# Proposal: chatwoot-new-contact-404 — asegurar el `ContactInbox` antes de crear la conversación

## Intent

Un envío bulk vía Chatwoot a un teléfono que NUNCA escribió al inbox falla con
`Request failed with status code 404`. Chatwoot **no** hace find-or-create de `ContactInbox`
en `POST /conversations`: hace *find* por `(source_id, inbox_id)` y 404ea. La premisa CHW-2
("find-or-create atómico") es **falsa** — se verificó en su día contra teléfonos que ya
tenían `contact_inbox`. Todo contacto nuevo es hoy un `failed` silencioso con un mensaje
opaco.

## Scope

### In Scope
- `ensureContactInbox(phoneE164, name?)` privado en `HttpChatwootGateway`.
- `createConversationWithTemplate`: **404 → ensure → retry una vez** con el `source_id` que
  Chatwoot devuelve (leído, no re-derivado).
- Mensajes de error tipados que nombran el **paso Chatwoot + status HTTP** (reemplazan el
  texto crudo de axios que hoy se persiste en `CampaignRecipient.error`).
- Tests del adapter con el harness `fakeHttp` existente + verificación en vivo post-deploy.

### Out of Scope
- Endpoint/acción para re-enviar los recipients `failed` de una campaña (follow-up; el
  recipient fallado se re-manda a mano por la API externa).
- Cambiar `this.call()` para el resto del port.
- Migración del inbox a `Channel::Whatsapp` (Cloud API).

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `chatwoot-hub-sendpath`: **CHW-2** deja de prohibir la resolución propia de contacto y
  pasa a exigir el ensure lazy en 404 + retry idempotente. **CHW-7** gana el requisito de
  mensaje diagnóstico (paso + status), sin cambiar el tipo de error.

## Approach

1. `POST /conversations` igual que hoy → **happy path = 1 llamada, cero regresión**.
2. Sólo si el status es **404**: `POST /contacts {inbox_id, name?, phone_number}` (Chatwoot
   crea contacto **y** `contact_inbox` en una transacción y devuelve `contact_inbox.source_id`).
3. `422` "Phone number has already been taken" → `GET /contacts/search` → resolver id →
   `POST /contacts/{id}/contact_inboxes {inbox_id, source_id}`.
4. Reintentar `POST /conversations` **una sola vez** con el `source_id` resuelto.

## Affected Areas

| Área | Impacto | Descripción |
|---|---|---|
| `src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts` | Modified | ensure + retry + helper de status |
| `src/domain/ports/ChatwootGateway.ts` | Modified | docblock CHW-2 (la premisa cambia) |
| `src/application/use-cases/messaging/SendCampaign.ts` | Sin cambio de lógica | hereda el mensaje mejorado |
| `src/__tests__/infrastructure/HttpChatwootGateway.test.ts` | Modified | casos nuevos |

**No toca `app.ts`** (sin wiring nuevo). **No agrega dependencias de Splynx.**

## Risks

| Riesgo | Prob. | Mitigación |
|---|---|---|
| Contactos duplicados | Baja | 422 unique + fallback de búsqueda; el loop de `SendCampaign` es SERIAL |
| Formato de `source_id` distinto | Baja | Se **lee** de la respuesta de Chatwoot, no se re-deriva |
| 404 por otra causa (account/inbox mal) | Baja | El ensure falla con mensaje que nombra el paso — más claro que hoy |
| Costo extra de llamadas | Baja | Sólo lo paga el contacto nuevo; happy path intacto |

## Rollback Plan

Revertir el commit del adapter. El cambio es aditivo y confinado a
`HttpChatwootGateway.createConversationWithTemplate`: sin migraciones, sin flags nuevos,
sin wiring. El feature flag `messaging-send-via-chatwoot` en OFF ya esquiva todo el path.

## Dependencies

- Chatwoot en `.37` con la Application API v1 (endpoints `contacts` / `contact_inboxes`).

## Success Criteria

- [ ] Un teléfono sin contacto en Chatwoot recibe el template: 1 mensaje, 1 conversación, 0 duplicados.
- [ ] Un teléfono con `contact_inbox` existente sigue costando **una sola** llamada HTTP.
- [ ] Un fallo del ensure deja el recipient `failed` con paso + status, y el batch continúa.
- [ ] Smoke en vivo post-deploy contra un número sin contacto previo.
