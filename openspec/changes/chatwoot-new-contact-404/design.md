# Design: chatwoot-new-contact-404

## Technical Approach

Todo el cambio vive DENTRO de `HttpChatwootGateway` (infra). El port cambia sólo su docblock;
`SendCampaign` no cambia ni una línea de lógica — hereda el mensaje mejorado por el `err.message`
que ya persiste (`SendCampaign.ts:461-476`). Cero wiring nuevo en `app.ts`.

## Architecture Decisions

| Decisión | Alternativa descartada | Razón |
|---|---|---|
| **Ensure LAZY (sólo en 404)** | Ensure eager antes de cada `POST /conversations` | El happy path (99% de una campaña) queda en 1 llamada, byte-idéntico a hoy → cero regresión sobre el camino ya verificado en prod. El eager sumaría 1-2 llamadas × miles de recipients y convertiría el 422 en el caso normal. |
| **Leer `source_id` de la respuesta** | Re-derivar `whatsapp:+E164` | El `ContactInboxBuilder` de Chatwoot genera el `source_id` según el canal (`whatsapp:+E164` para `Channel::TwilioSms`, teléfono sin `+` para `Channel::Whatsapp`). Leerlo hace el adapter inmune a una migración de canal. |
| **Helper `httpStatusOf(err)` + inspección ANTES de `this.call`** | Cambiar `this.call` para propagar el status en todo el port | `this.call` es el criterio único de fallo de las 12 operaciones del port (CHW-7). Tocarlo es blast radius innecesario. |
| **Retry EXACTAMENTE una vez** | Loop de reintentos | El ensure es determinista: o el `ContactInbox` quedó, o falló con un error que hay que reportar. Un segundo 404 es un bug real, no algo a reintentar. |
| **Reusar `searchContact` del port** | Nuevo `POST /contacts/filter` | `searchContact` ya existe (`HttpChatwootGateway.ts:205-210`) y está sin consumir (el port lo admite en `ChatwootGateway.ts:120`). El ILIKE de Chatwoot cubre `phone_number`. |

## Data Flow

```
createConversationWithTemplate(phoneE164, ...)
        │
        ├─ POST /conversations {inbox_id, source_id:"whatsapp:+E164", message:{…}}
        │        │
        │   2xx ─┴──────────────────────────────────────► return {convId, msgId}   (1 llamada)
        │        │
        │   404  ▼
        │   ensureContactInbox(phoneE164, name)
        │        │
        │        ├─ POST /contacts {inbox_id, name?, phone_number:"+E164"}
        │        │     2xx → source_id ← data.contact_inbox.source_id
        │        │                       ?? payload.contact_inboxes[0].source_id
        │        │                       ?? "whatsapp:+E164"          (último recurso)
        │        │     422 (SÓLO si el body indica teléfono duplicado — fix wave FW2) →
        │        │             GET /contacts/search?q=<solo dígitos>
        │        │             → match por teléfono → contactId
        │        │             → POST /contacts/{contactId}/contact_inboxes {inbox_id}
        │        │                    (fix wave FW1: SIN source_id — el ContactInboxBuilder de
        │        │                     Chatwoot lo genera según el canal; forzarlo acá pisaba el
        │        │                     formato viejo sobre una migración de canal, exactamente lo
        │        │                     que esta decisión ya evita en el paso anterior)
        │        │             → source_id ← respuesta (filtrado por inboxId si hay >1 inbox, FW4)
        │        │     otro → throw ChatwootUnavailableError(paso + status)
        │        ▼
        └─ POST /conversations con el source_id resuelto  ──► return {convId, msgId}
                 (un 404 acá también → ChatwootUnavailableError con paso + status)
```

## File Changes

| Archivo | Acción | Descripción |
|---|---|---|
| `src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts` | Modify | `httpStatusOf`, `ensureContactInbox`, `postConversation`, reescritura de `createConversationWithTemplate` |
| `src/domain/ports/ChatwootGateway.ts` | Modify | Docblock de CHW-2: la premisa "MUST NOT buscar contacto" se invierte |
| `src/__tests__/infrastructure/HttpChatwootGateway.test.ts` | Modify | Casos nuevos en el describe `createConversationWithTemplate` |

## Interfaces / Contracts

La firma pública del port **no cambia**. Todo lo nuevo es privado del adapter:

```ts
/** Status HTTP de un error de axios, o null si no fue una respuesta HTTP (red/timeout). */
function httpStatusOf(err: unknown): number | null;

/** Error tipado que nombra el paso Chatwoot y el status — nunca el texto crudo de axios. */
function chatwootStepError(step: string, err: unknown): ChatwootUnavailableError;
// → new ChatwootUnavailableError(`Chatwoot: ${step} — HTTP ${status}`)
// → sin status (red/timeout): `Chatwoot: ${step} — sin respuesta`
// step ∈ 'crear la conversación (POST /conversations)'
//      | 'crear el contacto (POST /contacts)'
//      | 'buscar el contacto (GET /contacts/search)'
//      | 'vincular el contacto al inbox (POST /contacts/:id/contact_inboxes)'

/** Devuelve el source_id CANÓNICO que Chatwoot asocia al ContactInbox de este teléfono. */
private async ensureContactInbox(phoneE164: string, name?: string | null): Promise<string>;
```

Reglas de detalle:
- `name` se envía **sólo si es no-vacío** (`candidate.name` puede ser `''` para CSV,
  `SendCampaign.ts:205-212`).
- El `q` de la búsqueda usa **solo dígitos** del teléfono (el ILIKE de Chatwoot no normaliza `+`).
- Match del contacto: comparar dígitos de `phone` contra dígitos del `phoneE164`; si hay 0 matches
  → `chatwootStepError('buscar el contacto…')`.

## Testing Strategy

| Capa | Qué | Cómo |
|---|---|---|
| Unit (adapter) | Los 5 scenarios de CHW-2 + el del ensure fallado de CHW-7 | Harness `fakeHttp({get,post})` ya existente (`HttpChatwootGateway.test.ts:12-26`); el 404 se simula con `mockRejectedValueOnce({response:{status:404}, isAxiosError:true, message:'Request failed with status code 404'})` y se assertea la SECUENCIA de `post.mock.calls` (paths + bodies) |
| Unit (no-regresión) | Happy path = 1 sola llamada | `expect(http.post).toHaveBeenCalledTimes(1)` y `expect(http.get).not.toHaveBeenCalled()` |
| Use case | `SendCampaign` sigue marcando `failed` y continuando el batch | `FakeChatwootGateway.failCreateConversationWithTemplate` — **sin cambios** (el fake no habla HTTP) |
| Integration/E2E | — | No aplica: no hay ruta HTTP nueva |
| **Live** | Smoke post-deploy | Ver abajo |

**Nota de proceso**: correr SOLO `npx jest src/__tests__/infrastructure/HttpChatwootGateway.test.ts`.
Nunca la suite completa desde este worktree.

### Plan de verificación en vivo (post-deploy)

1. Elegir un número de prueba **sin contacto en Chatwoot** — confirmar con
   `GET /api/v1/accounts/2/contacts/search?q=<dígitos>` → `[]`.
2. Enviar por la API externa de bulk (template `ipnext_bienvenida`, flag
   `messaging-send-via-chatwoot` ON).
3. Verificar: recipient `sent`; existe el `Contact` con su `contact_inbox`; UNA conversación; UN
   mensaje entregado.
4. Re-enviar al recipient originalmente fallado (`+5492324505794`) — **el orquestador/usuario
   decide** si el smoke usa ese número directamente o uno controlado aparte.
5. Control de no-regresión: un envío a `+5491178547218` (ya tenía `contact_inbox`) debe seguir
   funcionando.

## Migration / Rollout

No requiere migración de datos ni flag nuevo. `messaging-send-via-chatwoot` en OFF ya esquiva
todo el path. Rollback = revertir el commit del adapter.

## Open Questions

- [ ] ¿El smoke en vivo usa `+5492324505794` (re-envío real de la campaña fallada) o un número de
      prueba controlado? — decisión del orquestador/usuario.
- [ ] Follow-up fuera de alcance: acción para re-enviar en bloque los recipients `failed` de una
      campaña (hoy es manual por la API externa).
