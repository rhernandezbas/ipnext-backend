# Exploration: chatwoot-new-contact-404

> Bug verificado en vivo el 2026-09-03 desde el contenedor de prod.
> Campaña bulk externa (`api-messaging`, template `ipnext_bienvenida`) a `+5492324505794`
> → `CampaignRecipient.status='failed'`, `error='Request failed with status code 404'`.

## 1. Síntoma reproducido

```
POST {CHATWOOT_BASE_URL}/api/v1/accounts/2/conversations
{ "inbox_id": 1, "source_id": "whatsapp:+5492324505794" }
→ 404 {"error":"Resource could not be found"}
```

Mismo POST con `whatsapp:+5491178547218` (contacto id 2, YA tiene `contact_inbox`) → 200.
`GET /contacts/search?q=2324505794` → `[]` (no existe el contacto).
Inbox 1 = `Channel::TwilioSms` (WhatsApp vía Twilio).

## 2. Causa raíz (evidencia file:line)

`src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts:268-306`
`createConversationWithTemplate` postea la conversación SOLO por `source_id`:

```ts
const normalizedPhone = params.phoneE164.replace(/\s+/g,'').replace(/^whatsapp:/i,'');   // :279
const body = { inbox_id: this.inboxId, source_id: `whatsapp:${normalizedPhone}`, message: {...} };
const { data } = await this.call(() => this.http.post(this.accountPath('/conversations'), body)); // :295
```

El docblock del port lo declara explícitamente como premisa (y es la premisa FALSA):

- `src/domain/ports/ChatwootGateway.ts:177-201` — *"El adapter se apoya ÚNICAMENTE en el
  find-or-create de Chatwoot por `source_id` EXACTO … MUST NOT implementar una búsqueda
  propia de contacto por teléfono antes de este POST (CHW-2)"*.
- `HttpChatwootGateway.ts:257-267` — *"find-or-create ATÓMICO … el `before_action :contact_inbox`
  de Chatwoot resuelve el find-or-create por `source_id` EXACTO (verificado en vivo exploración §6)"*.

**Chatwoot NO hace find-or-create de `ContactInbox` en `POST /conversations`.** Su
`before_action` hace un **find** de `ContactInbox` por `(source_id, inbox_id)` y responde
404 (`Resource could not be found`) cuando no existe. La "verificación en vivo" original
(exploración de `chatwoot-hub-sendpath`, flip de julio) y TODOS mis smokes posteriores
usaron teléfonos que YA tenían `contact_inbox` (habían escrito al inbox alguna vez) — el
camino "contacto nuevo de cero" NUNCA se ejercitó en vivo. Los tests usan
`FakeChatwootGateway`, que devuelve `{chatwootConversationId:888,...}` sin tocar HTTP
(`src/__tests__/helpers/FakeChatwootGateway.ts:195-209`), así que tampoco lo cubrían.

## 3. Verificación del formato de `source_id` (Chatwoot upstream)

`app/builders/contact_inbox_builder.rb` (rama `develop`) — `twilio_source_id`:

| Canal | source_id generado |
|---|---|
| `Channel::TwilioSms` medium **whatsapp** | `"whatsapp:#{contact.phone_number}"` |
| `Channel::TwilioSms` medium sms | `contact.phone_number` |
| `Channel::Whatsapp` (Cloud API) | `contact.phone_number.delete('+')` — SIN `+` |
| `Channel::Email` | `contact.email` |
| `Channel::Api` / `WebWidget` | `SecureRandom.uuid` |

**CONFIRMADO**: para nuestro inbox 1 (`Channel::TwilioSms` + whatsapp) el `source_id`
canónico es `whatsapp:+549…` — exactamente el que ya construye el adapter. El bug NO es
de formato: es la AUSENCIA del `ContactInbox`.

⚠️ Ojo con el gotcha: si algún día el inbox migra a `Channel::Whatsapp` (Cloud API), el
`source_id` pasa a ser el teléfono SIN `+` y sin prefijo. Por eso el diseño debe **leer
de vuelta** el `source_id` que Chatwoot devuelve, no re-derivarlo.

### Endpoints confirmados contra el fuente upstream

- `POST /api/v1/accounts/{a}/contacts` — `contacts_controller#create` corre dentro de una
  transacción: `@contact.save!` y luego `build_contact_inbox`, que **si viene `inbox_id`**
  delega en `ContactInboxBuilder` (el mismo que genera el `source_id` de la tabla de
  arriba). O sea: **una sola llamada crea contacto + contact_inbox**.
- Respuesta (`views/api/v1/accounts/contacts/create.json.jbuilder`): renderiza el partial
  de contacto con `with_contact_inboxes: true` **y además** un bloque
  `contact_inbox: { inbox, source_id }` → **el `source_id` real viene en la respuesta**.
  Es la fuente de verdad a usar para el `POST /conversations` siguiente.
- `POST /api/v1/accounts/{a}/contacts/{id}/contact_inboxes` —
  `contacts/contact_inboxes_controller#create`: toma `inbox_id` (ruta/params) y un
  `source_id` OPCIONAL que reenvía tal cual al `ContactInboxBuilder` (si se omite, lo
  autogenera). Sirve para el caso "contacto existe pero sin contact_inbox en este inbox".
- `GET /contacts/search?q=` — ILIKE sobre `name/email/phone_number/identifier`.
- Duplicado de teléfono: la validación vive en el modelo `Contact` (unique por cuenta) →
  el create responde **422** con el mensaje `Phone number has already been taken`.

## 4. Cómo se propaga hoy el error

- `HttpChatwootGateway.call()` (`:125-131`) envuelve **cualquier** error de axios en
  `ChatwootUnavailableError(err.message)` — pierde el status HTTP. `err.message` de axios
  es literalmente `Request failed with status code 404`.
- `ChatwootUnavailableError` — `src/domain/errors/messaging.ts:77-82`, code `CHATWOOT_UNAVAILABLE`.
- `SendCampaign.processRecipient` (`:283-293`): salvo `TemplateProviderConfigError` (que
  aborta el run), cualquier error cae en `persistRecipientFailed` — best-effort
  per-destinatario, el batch **sigue**.
- `SendCampaign.persistRecipientFailed` (`:461-476`): guarda
  `error: err.message` → de ahí el texto opaco almacenado en la fila.

Consecuencia: hoy el operador ve `Request failed with status code 404` sin saber qué paso
falló. El mensaje debe decir el paso Chatwoot + el status.

## 5. Otros consumidores / áreas afectadas

- `SendTemplateMessage` (path del hilo) usa `sendTemplateMessage(conversationId, …)`
  (`HttpChatwootGateway.ts:237-255`) sobre conversaciones **ya existentes** → NO afectado.
- `searchContact` (`:205-210`) **existe en el port pero no lo consume ningún use case**
  (el propio port lo admite: `ChatwootGateway.ts:120` *"F2: not consumed by any F1 use
  case; kept in the port for contract completeness"*). Es reusable para el fallback 422,
  aunque devuelve solo `{id,name,phone}` — sin `contact_inboxes`.
- No existe hoy ningún `findOrCreateContact` en el código: la premisa CHW-2 lo prohibía
  explícitamente. Este change **revierte esa premisa**.
- Espejo local: `Conversation.contactPhone` / `contactPhoneE164` (`prisma/schema.prisma:3788-3794`,
  índice `:3880`; port `ConversationRepository.ts:36-41`). Es el mirror del inbox, NO
  conoce el `source_id` ni el contact id de Chatwoot → **no sirve como cache** para saltear
  la llamada. Descarta la optimización "consultar el mirror antes de llamar".
- Tests del adapter: `src/__tests__/infrastructure/HttpChatwootGateway.test.ts` con el
  harness `fakeHttp({get,post})` (`:12-26`) que inyecta un `AxiosInstance` fake. El bloque
  `createConversationWithTemplate` está en `:456-575`. Ahí van los tests nuevos.

## 6. Aproximaciones

| # | Enfoque | Pros | Contras | Esfuerzo |
|---|---|---|---|---|
| 1 | **Ensure siempre**: `POST /contacts` (o search) antes de cada `POST /conversations` | Determinista, un solo camino | +1..2 llamadas HTTP por destinatario en TODA campaña (miles); 422 esperable como caso normal → ruido | Media |
| 2 | **404 → ensure → retry once** (lazy) | Happy path intacto (1 llamada); el costo extra sólo lo paga el contacto nuevo; cero regresión sobre el camino verificado en producción | Requiere leer `err.response.status` **antes** de que `this.call` lo aplaste; una rama más | Baja |
| 3 | Crear el contacto desde el webhook/otro proceso previo (pre-provisioning) | Saca el costo del hot path | No resuelve el caso "número nuevo que nunca escribió" (es exactamente el nuestro) | Alta |

## 7. Recomendación

**Opción 2 — 404 → ensure → retry (una sola vez).**

Flujo dentro de `createConversationWithTemplate`:

1. `POST /conversations` con `source_id = whatsapp:<E164>` (idéntico a hoy).
2. Si NO es 404 → devolver como hoy (**happy path = 1 llamada, cero regresión**).
3. Si es **404** → `ensureContactInbox(phoneE164, name)`:
   a. `POST /contacts` `{ inbox_id, name, phone_number }` → 2xx: leer
      `contact_inbox.source_id` de la respuesta (fallback a `contact_inboxes[0].source_id`,
      y como último recurso el `whatsapp:<E164>` derivado).
   b. `422` (teléfono ya tomado) → `GET /contacts/search?q=<dígitos>` → resolver el
      contacto → `POST /contacts/{id}/contact_inboxes` `{ inbox_id }` (SIN `source_id`: lo genera
      Chatwoot según el canal — fix wave F1, FW1) → leer el `source_id` de la respuesta.
4. Reintentar `POST /conversations` **una sola vez** con el `source_id` resuelto.
5. Cualquier fallo del ensure → `ChatwootUnavailableError` con mensaje que nombra el PASO
   y el STATUS (ej. `Chatwoot: falló crear el contacto (POST /contacts) — HTTP 422`),
   nunca el texto crudo de axios.

Requiere un cambio quirúrgico en el manejo de error: `this.call` sigue igual para el resto
del port; `createConversationWithTemplate` inspecciona el status ANTES de delegar en
`this.call` (helper `httpStatusOf(err)`).

Idempotencia: crear un `ContactInbox` que ya existe es un no-op del lado del builder de
Chatwoot; y como el ensure sólo corre tras un 404, la re-ejecución de un recipient `failed`
(SendCampaign es resumible sobre `queued`/`failed`) converge sin duplicar contactos.

## 8. Riesgos

- **Contactos duplicados**: mitigado por el 422 unique-por-cuenta + el fallback de búsqueda.
  Riesgo residual si dos workers procesan el mismo teléfono en paralelo — hoy el loop de
  `SendCampaign` es SERIAL (un carril), así que no aplica.
- **Formato de `source_id`**: mitigado leyendo el `source_id` de la respuesta de Chatwoot
  en vez de re-derivarlo (cubre una futura migración a `Channel::Whatsapp`).
- **Costo extra de llamadas**: acotado al primer contacto nuevo; nulo en el happy path.
- **404 por otra causa** (accountId/inboxId mal, conversación borrada): el ensure correría
  igualmente y fallaría con un mensaje claro que nombra el paso — mejor que hoy.
- **`name` vacío**: `candidate.name` puede ser `''` para recipients CSV
  (`SendCampaign.ts:205-212`) → mandar `name` sólo si no está vacío.

## 9. Fuera de alcance (follow-up)

- Endpoint/acción para **re-enviar** los recipients `failed` de una campaña. Hoy el
  recipient fallado se re-manda a mano por la API externa después del deploy.
- Migración del inbox a `Channel::Whatsapp` (Cloud API).

## Ready for Proposal

**Sí.** El formato de `source_id` quedó verificado contra el fuente upstream y coincide con
el que el adapter ya emite; la causa raíz es la ausencia del `ContactInbox`, no el formato.
