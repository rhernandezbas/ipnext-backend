# Spec — inbox-resolve · BE (delta sobre messaging-inbox)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

Delta ADITIVO sobre `messaging-inbox` (spec principal en `openspec/specs/messaging-inbox/spec.md`).
NO reabre STATUS-1 (`SetConversationStatus`, ruta `POST /conversations/:id/status`, gateway
`setStatus`, webhook `conversation_status_changed`) — todo eso es LOCKED y ya tiene tests verdes.

---

## Capability: listado del inbox — filtro por ciclo de vida

### Requirement: LS-1 — `ConversationListQuery.status` con semántica de bucket

`ConversationRepository.list` MUST aceptar `status?: 'open' | 'resolved'` en
`ConversationListQuery`:

- `'open'` MUST filtrar `status != 'resolved'` (bucket ACTIVAS: incluye `open` y cualquier estado
  passthrough no-resuelto como `pending`/`snoozed` llegado por webhook — ninguna fila puede quedar
  invisible para ambos buckets).
- `'resolved'` MUST filtrar `status === 'resolved'` (match exacto).
- Ausente MUST devolver todas (comportamiento actual INTACTO — no-regresión).

Ambos adapters (`InMemoryConversationRepository`, `PrismaConversationRepository`) MUST implementar
la MISMA semántica (el in-memory es el fake de los use case tests — no puede divergir del real).
`total` MUST reflejar el universo FILTRADO. El orden (lastMessageAt DESC, nulls last, id ASC
tiebreaker) MUST quedar intacto.

#### Scenario: bucket open incluye pending, excluye resolved
- Given el mirror con conversaciones de status `open`, `pending` y `resolved`
- When `list({ status: 'open' })`
- Then devuelve las de status `open` y `pending`, NO la `resolved`, y `total` = 2

#### Scenario: bucket resolved es match exacto
- Given el mismo mirror
- When `list({ status: 'resolved' })`
- Then devuelve SOLO la `resolved`, `total` = 1

#### Scenario: sin status → sin filtro (no-regresión)
- Given el mismo mirror
- When `list({})`
- Then devuelve las 3, mismo orden que hoy

#### Scenario: combinable con asignación y campaña
- Given conversaciones resueltas y abiertas, algunas asignadas al agente A y/o en la campaña C
- When `list({ status: 'open', assigneeId: A, campaignId: C })`
- Then devuelve solo las NO resueltas de A en C (AND de los tres filtros)

#### Scenario: paginación sobre el universo filtrado
- Given 3 abiertas y 5 resueltas
- When `list({ status: 'resolved', page: 1, limit: 2 })`
- Then `data.length` = 2 y `total` = 5

### Requirement: LS-2 — parsing de `?status=` en `GET /conversations`

La ruta `GET /conversations` MUST parsear `?status=` y pasarlo al query SOLO cuando el valor es
`'open'` o `'resolved'`; cualquier otro valor MUST ignorarse (sin filtro, sin error — mismo
criterio que `assignment` con valor no reconocido). El guard de permisos MUST seguir siendo
`perms.read` (sin cambios).

#### Scenario: status=open filtra activas
- Given un usuario con `messaging.read` y el mirror con abiertas y resueltas
- When `GET /conversations?status=open`
- Then 200 con SOLO las no-resueltas en `data`

#### Scenario: status=resolved filtra resueltas
- When `GET /conversations?status=resolved`
- Then 200 con SOLO las resueltas

#### Scenario: valor desconocido se ignora
- When `GET /conversations?status=banana`
- Then 200 con TODAS las conversaciones (idéntico a sin param)

#### Scenario: combinable en la ruta
- When `GET /conversations?status=open&assignment=mine`
- Then 200 con las no-resueltas asignadas al usuario autenticado

## Capability: reconciliación del ciclo de vida vía webhook (verificación, sin código nuevo)

### Requirement: LS-3 — reopen automático de Chatwoot reconcilia el mirror

Cuando Chatwoot reabre automáticamente una conversación resuelta (mensaje inbound del cliente —
comportamiento verificado en el source de Chatwoot, design D4), el webhook
`conversation_status_changed` MUST dejar el mirror en `open` con el handler EXISTENTE
(`handleConversationStatusChanged`), idempotente ante redelivery. Este requirement NO introduce
código — exige que el escenario quede cubierto por test explícito si no lo está ya
(`ReceiveChatwootWebhook.reconciliation.test.ts`).

#### Scenario: resuelta + status_changed(open) → mirror open
- Given una conversación en el mirror con `status: 'resolved'`
- When llega `{ event: 'conversation_status_changed', id: <chatwootId>, status: 'open' }`
- Then el mirror queda `status: 'open'` y NINGÚN otro campo cambia (assignee/area/preview intactos)

#### Scenario: redelivery idempotente
- Given el mismo evento ya procesado (mismo dedup key)
- When llega de nuevo
- Then se ackea sin reprocesar (disciplina PROCESS-THEN-RECORD existente)
