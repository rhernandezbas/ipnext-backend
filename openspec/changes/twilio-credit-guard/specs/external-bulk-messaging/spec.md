# Delta for external-bulk-messaging

Extensión ADITIVA de `twilio-credit-guard`: `validate` suma `credit`+`warnings` a su salida y al
snapshot persistido; `send` suma un re-chequeo de crédito más al bloque SEND-4 (mismo criterio de
"re-leer, no confiar en el preview" que ya usa con template/label/caps); ruta hermana nueva
`GET /credit`. Ningún requirement existente cambia de semántica — solo se agrega superficie.
Comportamiento detallado del crédito (tarifas, balance, punto fijo, gate) vive en la capacidad
nueva `messaging-credit-guard` — este delta solo referencia los puntos de integración.

## MODIFIED Requirements

### Requirement: VAL-9 — forma de la respuesta
200 MUST devolver `{previewId, expiresAt, renderedMessage /*muestra, VAL-3*/,
counts:{received,valid,invalid,optedOut,duplicated}, valid:[{phone,name,variables,
renderedMessage}], invalid:[{input,reason,missingVariables?}], caps:{maxPerRequest,maxPerDay,
remainingToday}, credit:{available,currency,category,unitCost,estimatedCost,sufficient,
categoryAssumed?,unknown?}, warnings?:['INSUFFICIENT_CREDIT'|'CREDIT_UNAVAILABLE']}`.
`valid[].variables` MUST ser el mapa MERGEADO efectivo de ese recipient (no el global crudo) — es
lo que el humano audita antes de autorizar el `send`. El bloque `credit` MUST calcularse según
`messaging-credit-guard` (COST-1..4, CG-VAL-1) y MUST NUNCA convertir un 200 en error por
insuficiencia/inalcanzabilidad de crédito (eso es CG-VAL-1, `warnings`, no un código 4xx/5xx).
(Previously: la respuesta no incluía `credit` ni `warnings` — solo conteos/caps.)

#### Scenario: respuesta completa con mezcla de válidos/inválidos
- Given un batch con 2 válidos, 1 duplicado, 1 opt-out, 1 formato inválido
- When `POST .../validate`
- Then `counts = {received:5, valid:2, invalid:2, optedOut:1, duplicated:1}` y `invalid` trae los
  3 excluidos con su `reason` propia
- And cada entrada de `valid` trae su `variables` mergeado y su `renderedMessage` propio

#### Scenario: la respuesta trae el bloque credit (nuevo, twilio-credit-guard)
- Given un batch con 2 `valid`, template `UTILITY`, tarifas y saldo suficientes
- When `POST .../validate`
- Then la respuesta 200 incluye `credit:{available, currency, category:'UTILITY', unitCost,
  estimatedCost, sufficient:true}` junto a `counts`/`caps`/`valid`/`invalid` de siempre
- And no hay `warnings` en la respuesta (crédito suficiente, sin degradación)

#### Scenario: warnings conviven con un 200 exitoso
- Given el mismo batch, pero con `estimatedCost > available`
- When `POST .../validate`
- Then sigue respondiendo 200 (VAL-9 no cambia de código por esto), con
  `credit.sufficient:false` y `warnings:['INSUFFICIENT_CREDIT']` agregados a la respuesta

### Requirement: SEND-4 — re-validación completa al momento del send
`send` MUST re-chequear: flag ON (KS-1), template sigue `approved` (VAL-4), topes vigentes
(VAL-6/VAL-7), opt-out no cambió desde el `validate`, Y (nuevo, `twilio-credit-guard`) crédito
suficiente contra los destinatarios que REALMENTE se van a crear (`messaging-credit-guard`
CG-SEND-1) — un preview válido puede rechazarse acá si el estado cambió. El re-chequeo de crédito
MUST ejecutarse ANTES de crear la `Campaign` y ANTES de consumir el preview (mismo punto del flujo
que el resto de SEND-4): insuficiente ⇒ 422 `INSUFFICIENT_CREDIT` (CG-SEND-2); balance
inalcanzable o `currency` distinta a la de `MessagingRatesConfig` ⇒ 503 `CREDIT_UNAVAILABLE`
(CG-SEND-3), fail-closed. El replay (SEND-6, misma `Idempotency-Key`, campaña ya creada) MUST NOT
re-chequear crédito (CG-SEND-4), mismo criterio que los caps.
(Previously: el bloque de re-validación cubría flag/template/topes/opt-out; no existía chequeo de
crédito en `send`.)

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

#### Scenario: crédito insuficiente entre validate y send (nuevo, twilio-credit-guard)
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

## ADDED Requirements

### Requirement: CRED-ROUTE-1 — `GET /credit` es una ruta hermana en el MISMO router dedicado
El router de `external-bulk-messaging` MUST montar `GET /credit` junto a `/validate`/`/send`/
`/templates/*`/`/campaigns/:id`, bajo la MISMA key dedicada (AUTH-1/2/3) y el MISMO kill-switch
(KS-1) por construcción — no una exención nueva. El comportamiento detallado de la respuesta y sus
errores está especificado en `messaging-credit-guard` (CRED-1, CRED-2, CG-AUTH-1); este requirement
cubre solo el punto de integración: la ruta existe en este router y respeta el orden de mount
(COMP-1).

#### Scenario: /credit hereda el orden de mount de COMP-1
- Given el `app.ts` real ensamblado, router dedicado montado ANTES del mount global
- When `GET .../messaging/bulk/credit` se llama con la key GLOBAL
- Then responde 401 (AUTH-2, mismo criterio que `/validate`/`/send`)
- And con la key DEDICADA responde 200/503 según CRED-1/CRED-2
