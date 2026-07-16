# Spec — inbox-resolve · FE (delta sobre whatsapp-inbox, repo ipnext-frontend)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

Delta ADITIVO sobre el inbox FE (`src/pages/whatsapp/WhatsappInboxPage*`). NO reabre el toggle
Resolver/Reabrir del header (`ConversationStatusToggle`), ni `useSetConversationStatus` (optimista
+ rollback field-scoped), ni el toast de error — LOCKED con tests verdes.

---

## Capability: tabs de ciclo de vida en la lista

### Requirement: TAB-1 — tabs Abiertas/Resueltas, default Abiertas, filtro server-side

La lista MUST ofrecer un control segmentado **Abiertas | Resueltas** (radiogroup con radios
nativos, patrón `ConversationAssignmentFilter` — NO `role="tab"`), con default **Abiertas**. El
valor MUST viajar server-side como `status` en `WhatsappPaginatedQuery`
(`'open'` | `'resolved'`, espejo del contrato BE) — el estado inicial de la page MUST ser
`{ status: 'open' }`. El cache key de `useWhatsappConversations` deriva del objeto query → cada
tab MUST tener su propio cache entry (sin flicker al alternar, `keepPreviousData`).

#### Scenario: default Abiertas
- Given el inbox recién montado
- When se fetchea la lista
- Then el request lleva `status=open` y la tab Abiertas está seleccionada

#### Scenario: cambiar a Resueltas
- When el usuario selecciona Resueltas
- Then el request lleva `status=resolved` y la lista muestra solo resueltas

#### Scenario: combinable con filtros existentes
- Given la tab Abiertas y el filtro de asignación "Mías"
- Then el request lleva `status=open&assignment=mine` (los filtros existentes NO se resetean al
  cambiar de tab)

### Requirement: TAB-2 — filtro client-side de cinturón (bucket coherente con el optimista)

`ConversationList` MUST excluir client-side las filas cuyo `status` no matchea el bucket de la tab
activa (Abiertas = `status !== 'resolved'`, Resueltas = `status === 'resolved'`) — así el parche
OPTIMISTA de `useSetConversationStatus` (que cambia `status` en el cache de la lista) saca/mete la
fila al instante, sin esperar el refetch. El filtro server-side sigue siendo la fuente de verdad en
cada refetch.

#### Scenario: resolver saca la fila de Abiertas al instante
- Given la tab Abiertas con la conversación X seleccionada y visible
- When el agente pulsa Resolver (el optimista corre)
- Then la fila X deja de estar en la lista SIN esperar la respuesta del POST ni el refetch

#### Scenario: rollback re-entra la fila
- Given el mismo caso pero el POST falla (503)
- Then el rollback restaura `status` y la fila X reaparece en Abiertas, más el toast de error
  existente

### Requirement: TAB-3 — la selección y el thread sobreviven

Ni resolver ni cambiar de tab MUST tocar `selectedId`: el thread queda abierto (paridad Chatwoot),
el header muestra el badge Resuelta + botón Reabrir (existente). El nombre del contacto en el
header MUST seguir resolviendo desde `detail` aunque la fila ya no esté en la lista
(`contactNameFallback` existente).

#### Scenario: thread abierto post-resolver
- Given la conversación X abierta en el thread
- When se resuelve X (la fila sale de Abiertas)
- Then el thread de X sigue montado, badge Resuelta, botón Reabrir visible

### Requirement: TAB-4 — empty states por tab

Cada tab MUST tener su empty state propio: Abiertas → "No hay conversaciones abiertas.",
Resueltas → "No hay conversaciones resueltas." (el actual "No hay conversaciones." es ambiguo con
buckets). El empty state por búsqueda sin resultados queda como está.

#### Scenario: todo resuelto
- Given todas las conversaciones resueltas
- When la tab Abiertas está activa
- Then se muestra "No hay conversaciones abiertas." (no el mensaje de error ni el genérico)

## Capability: transición de salida (motion)

### Requirement: MOTION-1 — salida animada, reduced-motion respetado

Cuando una fila deja de matchear el bucket activo por una acción del AGENTE (resolver/reabrir
optimista), su remoción MUST animarse: colapso de altura + fade de opacidad, 200-250ms, ease-out
(las filas siguientes acompañan el colapso, sin salto). Con `prefers-reduced-motion: reduce` la
remoción MUST ser instantánea. Implementación con CSS modules (el repo NO tiene framer-motion y no
se agrega); la técnica exacta la decide apply con las skills de motion (Emil/impeccable). La
disciplina `key={conv.id}` por fila MUST quedar intacta (regla del repo:
`inbox-key-por-conversacion`).

#### Scenario: salida animada
- Given la tab Abiertas y motion normal
- When se resuelve una conversación visible
- Then la fila colapsa (altura+opacidad, ≤300ms) y luego desaparece del flow

#### Scenario: reduced motion
- Given `prefers-reduced-motion: reduce`
- When se resuelve una conversación visible
- Then la fila desaparece sin animación

## Capability: undo del resolver

### Requirement: UNDO-1 — resolver directo + toast "Deshacer" 5s

Resolver MUST ser directo (sin confirm). Tras disparar el resolve, MUST mostrarse un toast de
acción "Conversación resuelta · **Deshacer**" durante ~5s (extensión del mecanismo `inboxToast`
local existente — NO se instala un ToastContext global). "Deshacer" MUST despachar
`setStatus('open')` sobre el `convId` CAPTURADO AL MOMENTO del resolve (nunca el `selectedId`
actual — disciplina `vars.convId` de `useSetConversationStatus`). El toast MUST descartarse al
cambiar de conversación seleccionada (efecto de limpieza existente — evita el bug de contaminación
entre conversaciones que ya nos mordió dos veces). El toast de ERROR existente queda intacto y
tiene prioridad si el POST falla.

#### Scenario: deshacer dentro de la ventana
- Given la conversación X resuelta hace 2s, toast visible
- When el agente pulsa Deshacer
- Then se despacha `setStatus('open')` para X y la fila vuelve a Abiertas

#### Scenario: deshacer apunta a la conversación correcta
- Given X resuelta (toast visible) y el agente selecciona la conversación Y
- Then el toast se descarta al cambiar la selección (nunca puede deshacer sobre Y)

#### Scenario: expiración
- Given el toast visible
- When pasan ~5s sin interacción
- Then el toast desaparece y no queda ningún timer colgado

## Capability: contrato API/tipos

### Requirement: API-1 — `status` en query y tipos, espejo del BE

`WhatsappPaginatedQuery` MUST sumar `status?: 'open' | 'resolved'`;
`listWhatsappConversations` MUST incluirlo en el querystring solo cuando viene definido (misma
convención que `assignment`/`campaignId`). Ningún tipo existente se rompe (aditivo).

#### Scenario: param presente solo si definido
- When se llama `listWhatsappConversations({ status: 'open' })`
- Then el GET lleva `?status=open`; con `{}` no lleva `status`
