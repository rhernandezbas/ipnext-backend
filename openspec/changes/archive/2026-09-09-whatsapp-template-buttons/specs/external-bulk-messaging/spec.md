# Delta for external-bulk-messaging

## MODIFIED Requirements

### Requirement: TPL-3 — creación de template, con botón CTA opcional

`POST .../templates` MUST aceptar `{friendlyName, language, body, category?, variables?: string[],
button?: {title: string, url: string}}` y delegar en `CreateTemplate`, que valida
`friendlyName`/`language`/`body` no vacíos y `category` ∈ {UTILITY, MARKETING, AUTHENTICATION} si
viene. `button` es OPCIONAL y ADITIVO: si viene, `title` MUST ser no vacío tras `trim` y acotado en
largo, y `url` MUST ser una URL absoluta `http`/`https` bien formada; cualquiera inválido MUST
responder 400 `VALIDATION_ERROR`, sin llamar al proveedor y sin crear nada. Si `button` viene válido,
el template creado MUST emitir al proveedor el tipo de contenido `twilio/call-to-action` (con
`actions: [{type:'URL', title, url}]`); si `button` está ausente, el payload emitido MUST seguir
siendo `twilio/text`, byte-idéntico al comportamiento previo. Éxito MUST responder 201 con el DTO
curado del template creado (`approvalStatus:'unsubmitted'`). La creación MUST NOT submitir el
template a Meta: submit sigue siendo un paso EXPLÍCITO y separado (TPL-4).
(Previously: sólo aceptaba `{friendlyName, language, body, category?, variables?}` y siempre creaba
`twilio/text`; no existía `button`.)

#### Scenario: creación válida sin botón — sin regresión
- Given `{friendlyName:"promo_setiembre", language:"es", body:"Hola {{1}}", variables:["1"]}` (sin `button`)
- When `POST .../templates`
- Then responde 201 con `contentSid`, `approvalStatus:'unsubmitted'`, `sendable:false`
- And el payload enviado al proveedor es `twilio/text`, sin ningún campo de `call-to-action`

#### Scenario: creación con botón CTA válido
- Given `{friendlyName:"recordatorio_deuda", language:"es", body:"Hola {{1}}, mirá tu factura",
  button:{title:"Ver mis facturas", url:"https://portal.ipnext.com.ar/facturas"}}`
- When `POST .../templates`
- Then responde 201 con `contentSid`, `approvalStatus:'unsubmitted'`
- And el proveedor recibió `types:{'twilio/call-to-action':{body, actions:[{type:'URL',
  title:"Ver mis facturas", url:"https://portal.ipnext.com.ar/facturas"}]}}`

#### Scenario: botón inválido (título vacío o url mal formada/no http-s) → 400
- Given `button:{title:"   ", url:"https://example.com"}`, o `button:{title:"Ver más",
  url:"no-es-una-url"}`, o `button:{title:"Ver más", url:"ftp://example.com/x"}`
- When `POST .../templates`
- Then responde 400 `VALIDATION_ERROR` en TODOS los casos, sin llamar al proveedor ni crear nada
- And el botón NUNCA se pierde silenciosamente: o se crea completo, o el request falla

#### Scenario: body vacío — sin regresión
- Given `{friendlyName:"x", language:"es", body:"   "}`
- When `POST .../templates`
- Then responde 400 `VALIDATION_ERROR`, sin llamar al proveedor

#### Scenario: category fuera del enum — sin regresión
- Given `{friendlyName:"x", language:"es", body:"y", category:"PROMO"}`
- When `POST .../templates`
- Then responde 400 `VALIDATION_ERROR`, sin crear nada

### Requirement: VAL-3 — renderizado del mensaje POR RECIPIENT

El sistema MUST renderizar el body del template (`renderTemplateBody`) UNA VEZ POR RECIPIENT, con
el mapa resultante del merge de VAL-10. Cada recipient `valid` MUST llevar su `renderedMessage`
propio en la respuesta. El `renderedMessage` de nivel superior MUST ser una MUESTRA — el del PRIMER
recipient `valid` (`''` si no hay ninguno) — y MUST NOT interpretarse como el texto de todos.
Un recipient cuyo merge NO resuelve todos los placeholders NO se renderiza: cae en `invalid`
(VAL-10), y el batch sigue. Un template creado con `button` (TPL-3, `twilio/call-to-action`) MUST
renderizarse EXACTAMENTE igual que uno `twilio/text`: sólo el `body` alimenta `renderedMessage`; el
botón (`title`/`url`) MUST NOT aparecer en `renderedMessage` ni en ningún otro campo de la respuesta
de `validate` — el preview es sólo texto (gap aceptado, documentado en el proposal).
(Previously: no existía ninguna mención a templates con botón; el requirement sólo cubría el
render por-recipient de templates `twilio/text`.)

#### Scenario: dos recipients, dos mensajes distintos
- Given un template `"Hola {{1}}"` y dos recipients con `variables:{"1":"Ana"}` y `{"1":"Beto"}`
- When `POST .../validate`
- Then `valid[0].renderedMessage === "Hola Ana"`, `valid[1].renderedMessage === "Hola Beto"`
- And el `renderedMessage` de nivel superior es `"Hola Ana"` (muestra del primero)

#### Scenario: sin recipients válidos no hay muestra
- Given un batch donde TODOS los recipients caen en `invalid`
- When `POST .../validate`
- Then responde 422 `EMPTY_RECIPIENTS` (no se persiste un preview sin destino)

#### Scenario: preview de un template con botón CTA no muestra el botón (nuevo)
- Given un template aprobado creado con `button:{title:"Ver mis facturas", url:"https://..."}`
- When `POST .../validate` lo referencia como `templateRef`
- Then `renderedMessage` de cada recipient contiene SOLO el texto del body, igual que un template
  `twilio/text`
- And ningún campo de la respuesta expone `title`/`url`/`actions` del botón
