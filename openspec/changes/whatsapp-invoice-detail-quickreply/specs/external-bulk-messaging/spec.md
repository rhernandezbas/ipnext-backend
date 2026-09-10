# Delta for external-bulk-messaging

## MODIFIED Requirements

### Requirement: TPL-3 — creación de template, botón CTA-URL o quick-reply

`POST .../templates` (y su espejo `POST /api/external/v1/messaging/templates`) MUST aceptar
`button?: {type:'url', title, url} | {type:'quickReply', title}`. La forma LEGACY `{title, url}`
SIN `type` (la única en producción hoy) MUST seguir aceptándose, tratada exactamente como
`{type:'url', title, url}` — byte-idéntica en efecto. `type:'url'`/legacy exige `title` no vacío
tras `trim` y `url` absoluta http(s) (igual que hoy); `type:'quickReply'` exige `title` no vacío
tras `trim` E IGUAL EXACTO a la constante `INVOICE_DETAIL_BUTTON_TITLE` (mecanismo anti-drift:
la creación rechaza cualquier título de quick-reply que no coincida con el que el webhook
espera detectar) — una `url` presente junto a `quickReply` MUST responder 400
`VALIDATION_ERROR` (no se ignora en silencio: un `url` inesperado en un botón quick-reply es
un dato mal formado, no un campo de más a descartar). Cualquier `button` inválido (título
vacío, título de quick-reply que no coincide con la constante, `url` mal formada, `type`
desconocido) MUST responder 400 `VALIDATION_ERROR`, sin llamar al proveedor ni crear nada.
`type:'url'`/legacy MUST seguir emitiendo `twilio/call-to-action`; `type:'quickReply'` MUST
emitir `twilio/quick-reply` (`actions:[{id, title}]` — `id` es un slug derivado del título,
`type` es el discriminador de `twilio/call-to-action` y NO existe en una acción de
quick-reply); ausencia de `button` sigue emitiendo `twilio/text`. Éxito MUST responder 201 con
el DTO curado; la creación MUST NOT submitir el template a Meta (TPL-4).
(Previously: `button?: {title, url}` — shape única, siempre CTA-URL; no existía `quickReply`.)

#### Scenario: legacy sin `type` — sin regresión
- Given `button:{title:"Ver mis facturas", url:"https://..."}` (sin `type`)
- When `POST .../templates`
- Then responde 201 y emite `twilio/call-to-action`, idéntico al comportamiento hoy en producción

#### Scenario: `type:'url'` explícito — equivalente a legacy
- Given `button:{type:'url', title:"Ver mis facturas", url:"https://..."}`
- When `POST .../templates`
- Then responde 201 con el mismo efecto que la forma legacy sin `type`

#### Scenario: quick-reply válido
- Given `button:{type:'quickReply', title:INVOICE_DETAIL_BUTTON_TITLE}` (el título exacto que
  el webhook de detalle de facturas espera detectar)
- When `POST .../templates`
- Then responde 201 y el proveedor recibe `twilio/quick-reply` con
  `actions:[{id:<slug del título>, title:INVOICE_DETAIL_BUTTON_TITLE}]`

#### Scenario: quick-reply con `url` de más → 400
- Given `button:{type:'quickReply', title:INVOICE_DETAIL_BUTTON_TITLE, url:"https://..."}`
- When `POST .../templates`
- Then responde 400 `VALIDATION_ERROR` (no se ignora el `url`, se rechaza el request completo)

#### Scenario: `type` desconocido, título vacío, o título de quick-reply que no coincide → 400
- Given `button:{type:'sms', title:"x"}`, `button:{type:'quickReply', title:"   "}`, o
  `button:{type:'quickReply', title:"otro texto"}` (no coincide con `INVOICE_DETAIL_BUTTON_TITLE`)
- When `POST .../templates`
- Then responde 400 `VALIDATION_ERROR` en los tres casos, sin llamar al proveedor

#### Scenario: sin botón — sin regresión
- Given un body sin `button`
- When `POST .../templates`
- Then responde 201 y emite `twilio/text`, igual que hoy

## ADDED Requirements

### Requirement: TPL-6 — categoría de aprobación puede diferir de la sometida (impacto de costo)

Meta MAY aprobar un template `quickReply` bajo una categoría distinta de la sometida (observado
en vivo: sometido `UTILITY`, aprobado `MARKETING` — `MARKETING` factura ~5x más por mensaje que
`UTILITY`). El sistema MUST reportar siempre la categoría REAL de aprobación
(`approvalCategory`, TPL-2) y MUST NOT asumir que la categoría sometida persiste tras la
aprobación.

#### Scenario: recategorización de Meta sobre un quick-reply
- Given un template `quickReply` sometido con `category:'UTILITY'`
- When Meta lo aprueba bajo `MARKETING`
- Then `GET .../templates/:sid` refleja `approvalCategory:'MARKETING'`, nunca `UTILITY`
