# Spec — messaging-campaign-manual-recipients (delta sobre messaging-bulk)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

Delta ADITIVO sobre `messaging-bulk`. NO reabre las decisiones LOCKED de F2 (send-path Twilio,
opt-out enforcement, RBAC, etc.). Extiende la capacidad "creación de campaña" (CAMP-*) para aceptar
una lista manual de clientes combinable con el segmento.

---

## Capability: creación de campaña — lista manual combinable

### Requirement: MAN-1 — crear campaña con lista manual, segmento, o ambos
`CreateCampaign` MUST aceptar un input `manualClientIds?: string[]` PARALELO al `segment` (NO dentro
de `CampaignSegment`). Una campaña MUST ser válida cuando tiene un segmento filtrado, O una lista
manual no vacía, O ambos. Los destinatarios finales MUST ser la UNIÓN de (destinatarios resueltos del
segmento, si hay segmento filtrado) y (clientes de `manualClientIds`), deduplicada por `clientId`.

#### Scenario: solo segmento (no-regresión)
- Given una campaña con `segment: { statuses: ['late'] }` y sin `manualClientIds`
- When se crea la campaña
- Then se resuelve y materializa EXACTAMENTE igual que antes de este change (comportamiento intacto)

#### Scenario: solo lista manual
- Given una campaña con `segment: { statuses: [] }` (sin criterio) y `manualClientIds: ['c1','c2']`
  que existen
- When se crea la campaña
- Then se materializan 2 `CampaignRecipient` (c1, c2) y NO se rechaza por segmento sin criterio

#### Scenario: segmento + lista manual (unión deduplicada)
- Given un segmento que resuelve `['c1','c2']` y `manualClientIds: ['c3']` (existe, disjunto)
- When se crea la campaña
- Then se materializan 3 `CampaignRecipient` (c1, c2, c3)

#### Scenario: manual que ya cae en el segmento (dedup, sin error)
- Given un segmento que resuelve `['c1','c2']` y `manualClientIds: ['c2']`
- When se crea la campaña
- Then se materializan 2 `CampaignRecipient` (c1, c2) — c2 UNA sola vez, sin error

### Requirement: MAN-2 — rechazar campaña sin segmento NI lista manual
`CreateCampaign` MUST rechazar (con `UnfilteredSegmentError`) una campaña cuyo segmento no tenga
criterio real Y cuya lista manual esté vacía o ausente. Una lista manual no vacía MUST bastar para
que la campaña sea válida aunque el segmento no tenga criterio.

#### Scenario: ni segmento ni manual → rechazada
- Given `segment: { statuses: [] }` y sin `manualClientIds`
- When se intenta crear
- Then MUST lanzar `UnfilteredSegmentError` (400 `UNFILTERED_SEGMENT`), nada persistido

#### Scenario: solo manual con segmento sin criterio → aceptada
- Given `segment: { statuses: [] }` y `manualClientIds: ['c1']` (existe)
- When se crea
- Then MUST aceptarse (NO lanza `UnfilteredSegmentError`)

### Requirement: MAN-3 — fail-loud si algún manualClientId no existe
`CreateCampaign` (y `PreviewCampaignSegment` cuando recibe manuales) MUST rechazar la request con un
error de dominio tipado (`ManualRecipientsNotFoundError` → 422 `MANUAL_RECIPIENTS_NOT_FOUND`) que
expone `missingClientIds` cuando uno o más `manualClientIds` no resuelven a un `Client`. MUST NUNCA
dropear un id inexistente en silencio.

#### Scenario: un manualClientId inexistente → error
- Given `manualClientIds: ['c1','no-existe']` donde `c1` existe y `no-existe` no
- When se intenta crear
- Then MUST lanzar `ManualRecipientsNotFoundError` con `missingClientIds: ['no-existe']`, nada
  persistido

#### Scenario: todos los manualClientIds existen → ok
- Given `manualClientIds: ['c1','c2']`, ambos existen
- When se crea
- Then se materializan sin error

### Requirement: MAN-4 — compliance sobre la lista manual
Los clientes de `manualClientIds` MUST pasar por la MISMA resolución (`resolveRecipients`) que el
segmento: opt-out (`whatsappOptOutAt != null`) excluido SIEMPRE, teléfono inválido descartado, dedup
por `normalizePhone`. La EXISTENCIA es fail-loud (MAN-3); las exclusiones de compliance son
silenciosas (igual que el segmento).

#### Scenario: manualClientId opt-out se excluye sin error
- Given `manualClientIds: ['c1','c2']` donde c2 tiene `whatsappOptOutAt != null`
- When se crea (c1 enviable)
- Then se materializa solo c1; c2 se excluye por opt-out sin lanzar error

## Capability: segmentación por estado — preview de la unión

### Requirement: MAN-5 — preview cuenta la unión sin doble-contar el overlap
`PreviewCampaignSegment` MUST aceptar `manualClientIds?: string[]` y, cuando se pasan, MUST devolver
un `count` = tamaño de la unión (segmento ∪ manuales) deduplicada por `clientId`, sin contar dos veces
los manuales que ya caen en el segmento.

#### Scenario: overlap no se doble-cuenta
- Given un segmento que resuelve `['c1','c2']` y `manualClientIds: ['c2','c3']` (existen)
- When se previsualiza
- Then `count` MUST ser 3 (c1, c2, c3) — NO 4

## Capability: búsqueda de clientes — por teléfono

### Requirement: MAN-6 — el search de ListClients matchea por teléfono
`buildClientListWhere` MUST incluir `Client.phone` en el OR del search (junto a `name`/`email`/`login`),
para poder encontrar clientes por fragmento de teléfono al armar la lista manual.

#### Scenario: buscar por fragmento de teléfono
- Given un `search: '3364'`
- When se construye el where
- Then el OR MUST incluir `{ phone: { contains: '3364', mode: 'insensitive' } }` además de
  name/email/login
