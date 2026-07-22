# campaign-chatwoot-label Specification

RFC-2119, 1 test/scenario (Jest, fake gateway, supertest). Capability NUEVA BE-only; engancha
post-`sent` sin tocar `chatwoot-hub-sendpath`.

## Purpose

Label REAL de Chatwoot opcional por campaña, aplicado best-effort a las conversaciones alcanzadas,
sin acoplar creación/envío a la disponibilidad de Chatwoot.

## Requirements

### Requirement: CLBL-1 — `listAccountLabels`, catálogo
Port `ChatwootGateway` MUST ganar `listAccountLabels(): Promise<{title,color}[]>` (`GET
/accounts/2/labels`). `GET /chatwoot-labels` MUST invocarlo vía `ListChatwootLabels`. Falla HTTP
MUST lanzar `ChatwootUnavailableError`.

> fix wave (F4, reconciliación) — el DTO es `{title,color}` **SIN `id`** (decisión de diseño D1.a:
> los tags de conversación de Chatwoot se aplican/resuelven por `title`, no por id — el `id` sería
> un campo muerto, YAGNI). Corrige la redacción original de este requirement/scenario, que arrastraba
> `{id,title,color}` de la proposal antes de esa decisión.

#### Scenario: catálogo listado
- Given 2 labels en catálogo
- When `GET /chatwoot-labels`
- Then 200 con `[{title,color}]`

### Requirement: CLBL-2 — `createAccountLabel`, ficha completa
Port MUST ganar `createAccountLabel({title,color})` (`POST /accounts/2/labels`). `POST
/chatwoot-labels` MUST invocarlo vía `CreateChatwootLabel`, pass-through (formato no verificado,
nota). Rechazo (incl. duplicado) MUST propagar `ChatwootUnavailableError`.

#### Scenario: label creado, y rechazo propaga
- Given `{title:'promo-julio',color:'#FF0000'}` válido, y por separado un título que Chatwoot
  rechaza (ej. duplicado)
- When `POST /chatwoot-labels` corre para cada caso
- Then el válido responde 201 con `{title,color}` (D1.a, sin `id`); el rechazado propaga
  `ChatwootUnavailableError` sin persistir nada

### Requirement: CLBL-3 — `addConversationLabels`, GET-unión-POST idempotente
Port MUST ganar `addConversationLabels(id, labels: string[])`: GET actuales → unión → POST
completo. MUST NOT postear directo (reemplaza el set). Falla HTTP MUST lanzar
`ChatwootUnavailableError`.

#### Scenario: no pisa manuales, une concurrentes, idempotente en reintento
- Given conversación con `['vip']`; A aplica `'promo-julio'`, B aplica `'cobranzas'` (orden
  cualquiera), luego se reintenta el mismo label
- When cada `addConversationLabels` corre
- Then el set final es siempre `['vip','promo-julio','cobranzas']` — nadie pisa, nadie duplica

### Requirement: CLBL-4 — enganche best-effort en `SendCampaign`
Si `campaign.chatwootLabel` y `chatwootConversationId` existen, `processRecipient` MUST invocar
`addConversationLabels` tras `persistRecipientSent`, en try/catch aislado (`projectToInbox`), solo
loguea; falla MUST NOT re-marcar `failed` ni tocar `sentCount`. Aplica igual sea el id nuevo (CHW-2)
o existente (CHW-1) — CLBL-5.

#### Scenario: labeling exitoso, hilo nuevo y existente
- Given recipient A `sent` con id nuevo y recipient B con id existente, ambos con label seteado
- When `processRecipient` corre para cada uno
- Then ambos invocan `addConversationLabels`, sin distinción; siguen `sent`

#### Scenario: Chatwoot caído en 1 de N destinatarios
- Given 3 recipients `sent`; `addConversationLabels` falla solo en el 2do
- When corre el batch
- Then los 3 quedan `sent`; el 2do sin label; campaña llega a `done`

#### Scenario: label borrado del catálogo entre create y send
- Given el `title` guardado ya no existe en el catálogo
- When se invoca `addConversationLabels` con ese título
- Then Chatwoot tagea igual (semántica de tags) — no es error

> fix wave (F4, reconciliación) — este escenario queda cubierto IMPLÍCITAMENTE, no por un test
> dedicado: `SendCampaign.applyChatwootLabel` (D4) pasa el `title` guardado directo a
> `chatwootGateway.addConversationLabels`, que en `HttpChatwootGateway` (D2) NUNCA consulta el
> catálogo (`GET /accounts/2/labels`) en el send-path — solo hace GET-unión-POST sobre los tags
> de LA CONVERSACIÓN (`GET/POST /conversations/:id/labels`). Como Chatwoot resuelve tags por
> `title` string (no por id de catálogo), un título borrado del catálogo tagea la conversación
> igual — no hay código que pueda fallar acá. Verificado por los tests de
> `HttpChatwootGateway.test.ts` (`describe('addConversationLabels ...')`), que jamás asumen ni
> chequean existencia previa en el catálogo.

### Requirement: CLBL-6 — campo aditivo `Campaign.chatwootLabel`
`Campaign.chatwootLabel String?` (nullable) MUST persistirse tal cual vía `CreateCampaign`, sin
re-consultar el catálogo. POST `/campaigns` MUST parsear `chatwootLabel` opcional.

#### Scenario: pass-through sin validar, y ausencia intacta
- Given input A con `chatwootLabel:'label-borrado'` (no está en catálogo) e input B sin ese campo
- When se crean ambas campañas
- Then A persiste el valor igual (cero llamada a Chatwoot); B queda `null`, sin cambios

### Requirement: CLBL-7 — permisos dos-tier del catálogo
`GET /chatwoot-labels` MUST requerir `messaging.templates`; `POST /chatwoot-labels` MUST requerir
`messaging.manage`.

#### Scenario: 403 sin el permiso correspondiente
- Given un usuario sin `messaging.templates`, y otro con `messaging.templates` pero sin
  `messaging.manage`
- When el primero hace `GET /chatwoot-labels` y el segundo `POST /chatwoot-labels`
- Then ambos reciben 403, sin invocar el port

### Requirement: CLBL-8 — flag OFF / sin conversación = guardado sin efecto
Si `messaging-send-via-chatwoot` está OFF, o falta `chatwootConversationId`, el enganche (CLBL-4)
MUST saltearse sin error.

#### Scenario: flag OFF durante todo el envío
- Given `campaign.chatwootLabel` seteado y flag OFF
- When corre `SendCampaign`
- Then nadie invoca `addConversationLabels`; todos terminan como hoy

#### Scenario: resume no re-etiqueta un recipient ya `sent`
- Given recipient ya `sent` de una corrida previa
- When la campaña se resume (SEND-6)
- Then no se reprocesa — cero nueva llamada a `addConversationLabels`

## Nota abierta (sdd-design)

Formato de `title` en Chatwoot (mayúsculas/espacios vs. unicidad) no verificado — CLBL-2 asume
pass-through, error genérico.
