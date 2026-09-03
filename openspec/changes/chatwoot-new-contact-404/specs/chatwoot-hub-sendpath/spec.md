# Delta for chatwoot-hub-sendpath

> Corrige una premisa FALSA de CHW-2: Chatwoot **no** hace find-or-create de `ContactInbox` en
> `POST /conversations` — hace *find* por `(source_id, inbox_id)` y responde 404. Verificado en
> vivo 2026-09-03 y contra el fuente upstream (`ContactInboxBuilder`, `contacts_controller#create`).

## MODIFIED Requirements

### Requirement: CHW-2 — `ChatwootGateway.createConversationWithTemplate` (ensure-on-404, bulk)

El port MUST exponer `createConversationWithTemplate({phoneE164, name, templateName, language,
processedParams, content}): Promise<{chatwootConversationId, chatwootMessageId: number|null}>`.

El adapter MUST intentar PRIMERO `POST /conversations` con `source_id` derivado del teléfono
(`whatsapp:+E164`) — camino sin cambios, **una sola llamada** cuando el `ContactInbox` ya existe.

Cuando —y SÓLO cuando— esa llamada responde **HTTP 404**, el adapter MUST asegurar el contacto y
su `ContactInbox` en el inbox configurado y MUST reintentar `POST /conversations` **exactamente una
vez** con el `source_id` que Chatwoot devolvió. El adapter MUST usar el `source_id` **leído de la
respuesta** de Chatwoot y MUST NOT re-derivarlo de un formato asumido. El adapter MUST NOT
reintentar más de una vez, y MUST NOT ejecutar el ensure ante cualquier otro status.

La operación MUST ser idempotente: reprocesar un recipient `failed` no MUST crear un segundo
contacto ni una segunda conversación por el mismo teléfono.

(Previously: exigía resolver contacto+conversación+mensaje en UNA sola llamada apoyándose
ÚNICAMENTE en un supuesto find-or-create atómico de Chatwoot por `source_id`, y PROHIBÍA
explícitamente que el adapter resolviera el contacto por su cuenta.)

#### Scenario: teléfono con `ContactInbox` existente — una sola llamada (no-regresión)
- GIVEN un teléfono cuyo `source_id` ya tiene `ContactInbox` en el inbox
- WHEN se invoca `createConversationWithTemplate(...)`
- THEN el `POST /conversations` responde 2xx a la primera
- AND NO se emite ninguna llamada a `/contacts` ni a `/contact_inboxes`

#### Scenario: teléfono sin contacto en Chatwoot — se crea contacto + inbox y luego la conversación
- GIVEN un teléfono sin `Contact` ni `ContactInbox` en Chatwoot
- WHEN se invoca `createConversationWithTemplate(...)`
- THEN el primer `POST /conversations` responde 404
- AND el adapter crea el contacto con su `ContactInbox` y toma el `source_id` de esa respuesta
- AND reintenta `POST /conversations` con ese `source_id`, devolviendo `chatwootConversationId`
- AND se envía UN solo mensaje (sin duplicados)

#### Scenario: contacto ya existe pero sin `ContactInbox` en este inbox
- GIVEN un teléfono con `Contact` en la cuenta pero sin `ContactInbox` en el inbox configurado
- WHEN el `POST /conversations` responde 404 y la creación del contacto responde 422 por teléfono duplicado
- THEN el adapter resuelve el contacto existente por teléfono y le agrega el `ContactInbox`
- AND reintenta `POST /conversations` con el `source_id` resultante
- AND NO se crea un segundo `Contact`

#### Scenario: `source_id` con formato distinto al derivado
- GIVEN que Chatwoot devuelve un `source_id` que NO coincide con `whatsapp:+E164`
- WHEN el adapter reintenta la creación de la conversación
- THEN MUST usar el `source_id` devuelto por Chatwoot, no el derivado localmente

#### Scenario: reintento de un recipient `failed` tras el fix — idempotente
- GIVEN un recipient `failed` cuyo contacto ya fue creado por un intento anterior
- WHEN el worker lo reprocesa
- THEN el `POST /conversations` resuelve a la primera
- AND no se crean contactos ni conversaciones duplicadas

### Requirement: CHW-7 — `ChatwootUnavailableError` en falla de Chatwoot, con paso diagnóstico y sin persistencia

El adapter Chatwoot (CHW-1/CHW-2) MUST lanzar `ChatwootUnavailableError` (existente en
`domain/errors/messaging.ts`, mismo error de `ChatwootGateway.sendMessage`/`setStatus`) ante
CUALQUIER falla de red/timeout/4xx-5xx — NUNCA `TemplateProviderUnavailableError` (reservado al
path Twilio-directo). En falla, MUST NOT persistirse nada (mismo guard-order que hoy).

Cuando la falla ocurre en el ensure de contacto/`ContactInbox` (CHW-2), el mensaje del error MUST
identificar el PASO Chatwoot que falló y su STATUS HTTP, y MUST NOT ser el texto crudo del cliente
HTTP. El mensaje MUST seguir sin cargar el payload/response crudo del proveedor (HIST-3).

(Previously: mismo error tipado, pero sin exigir que el mensaje identificara el paso ni el status —
el recipient quedaba con el texto opaco `Request failed with status code 404`.)

#### Scenario: Chatwoot caído — one-off
- GIVEN Chatwoot inalcanzable (timeout) y flag ON
- WHEN `SendTemplateMessage.execute(...)`
- THEN lanza `ChatwootUnavailableError` (→503); el mirror queda EXACTAMENTE como estaba

#### Scenario: Chatwoot caído — bulk, no aborta el batch
- GIVEN Chatwoot caído durante el worker de `SendCampaign`
- WHEN procesa UN recipient
- THEN ESE recipient termina `failed` con el error saneado; el resto sigue procesándose

#### Scenario: el ensure falla — recipient `failed` con paso y status, el batch continúa
- GIVEN un teléfono nuevo y un fallo de Chatwoot al crear el contacto
- WHEN el worker procesa ese recipient
- THEN ESE recipient queda `failed` con un mensaje que nombra el paso y el status HTTP
- AND el mensaje NO es `Request failed with status code <n>` a secas
- AND los recipients siguientes se siguen procesando
