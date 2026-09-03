# Delta for external-bulk-messaging

Cambio de contrato de `external-labels-required`: `chatwootLabel` pasa de OPCIONAL a **OBLIGATORIO**
en `validate` (nuevo 422 `CHATWOOT_LABEL_REQUIRED`) y su re-chequeo en `send` deja de ser
condicional. VAL-5 pierde la prohibición "el sistema MUST NUNCA crear el label" — **revertida por
pedido explícito del usuario (2026-09-03)**: la creación ahora existe, pero como una operación
SEPARADA y explícita (`POST .../labels`, capacidad `external-labels`), NUNCA como un efecto
implícito de `validate`/`send`. Es un **breaking change** para cualquier caller M2M que hoy valide
sin label. El composer admin (`CreateCampaign`, `messagingBulk.routes.ts`) NO está alcanzado por
este delta: allí el label sigue siendo opcional.

## MODIFIED Requirements

### Requirement: VAL-1 — forma del input
El body MUST tener `recipients: {phone: string, name?: string, variables?: Record<string,string>}[]`
(no vacío), `templateRef` (o `templateName`), `variables?: Record<string,string>` (GLOBAL, default
aplicado a todos), y `chatwootLabel: string` **OBLIGATORIO** (no vacío tras `trim`). El `variables`
POR-RECIPIENT pisa al GLOBAL **por key** (merge, no reemplazo del mapa). Forma inválida (tipos
equivocados, `recipients` vacío o no-array, valores de `variables` que no son string, `templateRef`
ausente) MUST responder 400 `VALIDATION_ERROR` antes de tocar Chatwoot/DB.

`chatwootLabel` ausente, `null`, o vacío/whitespace MUST responder **422 `CHATWOOT_LABEL_REQUIRED`**
— NO 400: es una regla de NEGOCIO (mismo criterio que `CHATWOOT_LABEL_NOT_FOUND`), no un error de
tipos del wire. El rechazo MUST ocurrir ANTES de cualquier llamada a Chatwoot, al proveedor de
templates o a la DB, y MUST NOT persistir preview. El gate del kill-switch (KS-1) sigue siendo el
PRIMERO: con el flag OFF la respuesta es 403 `FEATURE_DISABLED`, no 422.
(Previously: `chatwootLabel?: string` era opcional y su ausencia era un camino válido que producía
un preview con `chatwootLabel:null`.)

#### Scenario: recipients vacío → 400
- Given `recipients: []`
- When `POST .../validate`
- Then responde 400 `VALIDATION_ERROR`, sin llamar a Chatwoot ni persistir preview

#### Scenario: falta templateRef → 400
- Given un body sin `templateRef`/`templateName`
- When `POST .../validate`
- Then responde 400 `VALIDATION_ERROR`

#### Scenario: falta chatwootLabel → 422 (nuevo)
- Given un body válido en todo lo demás pero SIN `chatwootLabel`
- When `POST .../validate`
- Then responde 422 `CHATWOOT_LABEL_REQUIRED`, sin llamar a Chatwoot ni al proveedor de templates,
  sin persistir preview

#### Scenario: chatwootLabel vacío o whitespace → 422 (nuevo)
- Given `chatwootLabel: ""` o `chatwootLabel: "   "`
- When `POST .../validate`
- Then responde 422 `CHATWOOT_LABEL_REQUIRED`

#### Scenario: chatwootLabel `null` EXPLÍCITO → 422, NUNCA 400 (fix wave F1, finding 1)
- Given un body válido en todo lo demás con `chatwootLabel: null` (JSON válido, no ausente)
- When `POST .../validate`
- Then responde 422 `CHATWOOT_LABEL_REQUIRED` — el Zod de la ruta MUST aceptar `null` como tipo
  legítimo (`.nullable().optional()`), la obligatoriedad la resuelve `assertValidShape`, no el schema
  (Previously: el Zod solo declaraba `.optional()`; un `chatwootLabel: null` reventaba con 400
  `VALIDATION_ERROR`, un código de error equivocado para una regla de negocio)

#### Scenario: el kill-switch gana sobre el label faltante (nuevo)
- Given el flag `messaging-external-bulk-enabled` en `false` y un body sin `chatwootLabel`
- When `POST .../validate`
- Then responde 403 `FEATURE_DISABLED` (KS-1 sigue siendo el primer gate), no 422

### Requirement: VAL-5 — label de Chatwoot debe existir en el catálogo vivo
`chatwootLabel` SIEMPRE está presente (VAL-1). El sistema MUST consultar `ListChatwootLabels` en
vivo en TODA llamada a `validate`; label inexistente MUST responder 422 `CHATWOOT_LABEL_NOT_FOUND`;
Chatwoot inalcanzable MUST responder 503 `CHATWOOT_UNAVAILABLE`, fail-closed (nunca aceptado a
ciegas). `validate` MUST NOT crear el label: la creación es una operación separada y explícita
(`POST .../labels`, capacidad `external-labels`) que el caller MUST invocar por su cuenta.
(Previously: el chequeo corría sólo "si `chatwootLabel` está presente", y el requirement prohibía
que el sistema creara el label en cualquier circunstancia.)

**fix wave F1 (finding 2)** — el `chatwootLabel` del caller MUST normalizarse (`normalizeLabelTitle`,
regla ÚNICA compartida con `POST .../labels`, LBL-2) ANTES de compararlo contra el catálogo vivo: el
catálogo SIEMPRE contiene títulos normalizados, así que comparar el crudo del caller rompía el
round-trip create→validate (un caller que reusa el título "bonito" de un label que acaba de crear
recibía `CHATWOOT_LABEL_NOT_FOUND` contra su propio label). El título NORMALIZADO es el que se
persiste en el preview y el que viaja en la respuesta 200 (`chatwootLabel`, D12/VAL-9 aditivo).

#### Scenario: label inexistente
- Given `chatwootLabel:"no-existe"` y el catálogo vivo no lo contiene
- When `POST .../validate`
- Then responde 422 `CHATWOOT_LABEL_NOT_FOUND`

#### Scenario: round-trip create→validate por título normalizado (fix wave F1, finding 2/7, nuevo)
- Given `POST .../labels {"title":"Cobranzas Agosto"}` respondió 201 con `title:"cobranzas-agosto"`
- When `POST .../validate` con `chatwootLabel:"Cobranzas Agosto"` (el título SIN normalizar, tal
  cual lo mandó el caller al crearlo)
- Then responde 200 con `chatwootLabel:"cobranzas-agosto"` en el body — el match contra el catálogo
  NO es case-sensitive/whitespace-sensitive sobre el crudo del caller, matchea por título normalizado

#### Scenario: Chatwoot caído
- Given `ListChatwootLabels` lanza (timeout/5xx)
- When `POST .../validate` con un `chatwootLabel` cualquiera
- Then responde 503 `CHATWOOT_UNAVAILABLE`, sin persistir preview ni aceptar a ciegas

#### Scenario: validate nunca crea el label (nuevo)
- Given `chatwootLabel:"no-existe"`
- When `POST .../validate`
- Then responde 422 `CHATWOOT_LABEL_NOT_FOUND` y `createAccountLabel` NO fue llamado

### Requirement: SEND-4 — re-validación completa al momento del send
`send` MUST re-chequear: flag ON (KS-1), template sigue `approved` (VAL-4), topes vigentes
(VAL-6/VAL-7), opt-out no cambió desde el `validate`, el `chatwootLabel` del preview SIGUE
existiendo en el catálogo vivo (VAL-5, ahora **incondicional**), Y crédito suficiente contra los
destinatarios que REALMENTE se van a crear (`messaging-credit-guard` CG-SEND-1) — un preview válido
puede rechazarse acá si el estado cambió. El re-chequeo de crédito MUST ejecutarse ANTES de crear
la `Campaign` y ANTES de consumir el preview (mismo punto del flujo que el resto de SEND-4):
insuficiente ⇒ 422 `INSUFFICIENT_CREDIT` (CG-SEND-2); balance inalcanzable o `currency` distinta a
la de `MessagingRatesConfig` ⇒ 503 `CREDIT_UNAVAILABLE` (CG-SEND-3), fail-closed. El replay
(SEND-6, misma `Idempotency-Key`, campaña ya creada) MUST NOT re-chequear crédito (CG-SEND-4),
mismo criterio que los caps.

Un preview persistido SIN `chatwootLabel` (`null` — creado ANTES de este change, dentro de la
ventana de TTL de 15 min de un deploy) MUST rechazarse con 422 `CHATWOOT_LABEL_REQUIRED`, sin crear
`Campaign` y sin consumir el preview: el caller re-hace `validate` con label. `send` MUST NOT crear
el label bajo ninguna circunstancia.
(Previously: el bloque de re-validación chequeaba el label sólo "si el preview traía uno"; un
preview con `chatwootLabel:null` era un camino de éxito válido.)

**fix wave F1 (finding 5)** — el guard `CHATWOOT_LABEL_REQUIRED` (preview con `chatwootLabel:null`)
MUST evaluarse ANTES que `assertTemplateApproved` dentro de este mismo paso de re-validación (antes
corría DESPUÉS). Un preview de la ventana de deploy puede traer `chatwootLabel:null` Y apuntar a un
template que mientras tanto dejó de estar aprobado — el orden viejo devolvía `TEMPLATE_NOT_APPROVED`,
un error real pero no el motivo por el que ESTE preview específico ya no sirve.

**fix wave F1 (finding 2)** — `preview.chatwootLabel` MUST normalizarse (`normalizeLabelTitle`,
defensivo) antes de re-chequearlo contra el catálogo vivo y antes de pasarlo a `CreateCampaign`: la
`Campaign` creada aplica el título CANÓNICO del catálogo, nunca un crudo sin normalizar que pudiera
haber quedado en un preview viejo.

#### Scenario: preview viejo sin label Y template ya no aprobado — gana el label (fix wave F1, finding 5, nuevo)
- Given un preview persistido con `chatwootLabel:null` cuyo `templateRef` YA NO está `approved`
- When `POST .../send`
- Then responde 422 `CHATWOOT_LABEL_REQUIRED` (no `TEMPLATE_NOT_APPROVED`) — el guard del label corre
  primero dentro del paso de re-validación

#### Scenario: template desaprobado entre validate y send
- Given un preview `valid` cuyo template pasó a `pending`/`rejected` DESPUÉS del `validate`
- When `POST .../send`
- Then responde 422 `TEMPLATE_NOT_APPROVED`, sin crear `Campaign`, sin consumir el preview

#### Scenario: cupo diario agotado entre validate y send
- Given un preview `valid` de 50 recipients, pero otra campaña `api-messaging` consumió el cupo
  diario DESPUÉS de ese `validate`
- When `POST .../send`
- Then responde 422 `CAP_EXCEEDED`, sin crear `Campaign`

#### Scenario: recipient opt-out entre validate y send
- Given un preview con un recipient `valid`, que se da de baja (opt-out) DESPUÉS del `validate`
- When `POST .../send`
- Then ese recipient MUST excluirse de la `Campaign` creada (no se le envía)

#### Scenario: crédito insuficiente entre validate y send
- Given un preview `valid`, pero el saldo Twilio cayó por debajo del costo estimado DESPUÉS del
  `validate`
- When `POST .../send`
- Then responde 422 `INSUFFICIENT_CREDIT` con `{available, estimatedCost, currency}`, sin crear
  `Campaign`, sin consumir el preview — el chequeo de crédito corre ANTES de esos dos side-effects

#### Scenario: el orden de los guards deja crédito al final, antes de crear la Campaign
- Given un preview cuyo template SIGUE aprobado, topes OK, opt-out sin cambios, pero crédito
  insuficiente
- When `POST .../send`
- Then el rechazo es 422 `INSUFFICIENT_CREDIT` (los guards previos de este mismo requirement ya
  pasaron) — ningún guard posterior a crédito llega a ejecutarse porque la `Campaign` aún no existe

#### Scenario: el label del preview fue borrado de Chatwoot entre validate y send (nuevo)
- Given un preview con `chatwootLabel:"promo-agosto"` y ese label eliminado del catálogo DESPUÉS
  del `validate`
- When `POST .../send`
- Then responde 422 `CHATWOOT_LABEL_NOT_FOUND`, sin crear `Campaign`, sin consumir el preview,
  y sin crear el label

#### Scenario: preview viejo sin label (ventana de deploy) (nuevo)
- Given un preview persistido con `chatwootLabel:null` (creado antes del deploy de este change)
- When `POST .../send`
- Then responde 422 `CHATWOOT_LABEL_REQUIRED`, sin crear `Campaign`, sin consumir el preview
