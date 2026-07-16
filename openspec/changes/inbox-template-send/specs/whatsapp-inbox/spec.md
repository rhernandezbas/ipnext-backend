# Spec — inbox-template-send · FE (delta sobre whatsapp-inbox)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).
Repo: `ipnext-frontend`, branch NUEVO `feat/inbox-template-send-fe` desde `main`.

Regla transversal (design D2): enviar el template NO abre la ventana — el composer de texto libre
SIGUE bloqueado después de enviar; la única confirmación visual es el mensaje en el hilo + un
announcement.

---

## Capability: composer — CTA en ventana expirada

### Requirement: CTA-1 — el aviso estático se convierte en aviso + acción

En la rama EXACTA de ventana expirada (`mode==='reply' && !isDetailLoading && !isDetailError &&
!canReply`, hoy `Composer.tsx:240-244`) el composer MUST renderizar, además del aviso, un botón
"Enviar template" que abre el `TemplateSendPanel`. El CTA MUST NOT aparecer en ninguna otra rama:
ni mientras verifica (`isDetailLoading`), ni en error de verificación (`isDetailError && !canReply`),
ni con ventana abierta (`canReply:true`), ni en modo nota. El CTA vive dentro del
`<Can permission="messaging.send">` existente (mismo guard que el envío — cero permiso nuevo).

#### Scenario: CTA solo en la rama expirada
- Given `canReply:false`, `isDetailLoading:false`, `isDetailError:false`, modo reply
- Then el aviso "Ventana de 24h expirada…" Y el botón "Enviar template" son visibles

#### Scenario: sin CTA en las otras 3 ramas + nota
- Given cada una de: `isDetailLoading:true` / `isDetailError:true && !canReply` / `canReply:true`
  / modo nota
- Then el botón "Enviar template" NO se renderiza

#### Scenario: composer sigue bloqueado tras enviar
- Given un envío de template exitoso
- Then el textarea sigue `disabled` y el aviso de ventana expirada sigue visible (la ventana NO
  se abre)

---

## Capability: TemplateSendPanel — picker + variables + preview + envío

### Requirement: PICK-1 — catálogo con 4 ramas, solo aprobados

Al abrir, el panel MUST fetchear el catálogo vía `useSendableTemplates(enabled=open)` (GET
`/messaging/send-templates`, unwrap `{data}`) y renderizar 4 ramas: loading (`role="status"`),
error (`role="alert"` + botón reintentar), empty ("No hay templates aprobados.", que MUST cubrir
también el caso de catálogo con SOLO pending/rejected), y success con el Select PROPIO
(`molecules/Select`) listando ÚNICAMENTE `sendable === true`. El tipo `TemplateSummaryDto` MUST
reusarse de `types/messagingBulk.ts` (cero duplicación).

#### Scenario: 4 ramas
- Given cada estado de la query (pending/error/data vacío o sin aprobados/data con aprobados)
- Then se renderiza exactamente la rama correspondiente

#### Scenario: solo aprobados listados
- Given un catálogo con `approved` + `pending` + `rejected`
- Then el Select ofrece SOLO los approved (los demás NO aparecen ni disabled)

### Requirement: VAR-1 — variables como valores planos + preview real

Elegido un template con variables declaradas, el panel MUST renderizar un input de texto por
variable (label visible `{{N}}`, ids únicos, molde estructural `VariablesMapForm` SIN el Select de
fuentes) y un preview del mensaje real con cada `{{N}}` sustituido por el valor tipeado (patrón
`renderPreviewMessage`/`splitTemplateBody`); una variable vacía MUST mostrarse como pendiente en
el preview (nunca `{{N}}` crudo sin señalizar). Un template SIN variables MUST mostrar el body tal
cual y habilitar confirm directo.

#### Scenario: preview vivo
- Given template `body:'Hola {{1}}, tu saldo es {{2}}'`
- When el agente tipea `1:'Juan'` y deja `2` vacío
- Then el preview muestra "Hola Juan, tu saldo es" con el placeholder de `2` señalizado pendiente

### Requirement: SEND-1 — gate de confirm + envío + aterrizaje en el hilo

Confirm MUST estar deshabilitado hasta que haya template elegido Y todas las variables declaradas
tengan valor no-vacío (defensa en profundidad — el 422 server-side igual se maneja). Al confirmar,
MUST dispararse `useSendWhatsappTemplate(id)` (POST `.../send-template`), con confirm deshabilitado
y estado "Enviando…" mientras `isPending` (previene doble submit — el POST no es idempotente). En
éxito: el mensaje MUST aparecer en el hilo AL TOQUE (append-on-success al cache
`whatsappMessagesKey(convId)` con `await cancelQueries` + dedup por `id`, clon del patrón
`useSendWhatsappMessage.onSuccess`) + invalidación de la lista de conversaciones (preview/orden);
el panel MUST cerrarse, el foco MUST volver al CTA y un announcement (`role="status"`) MUST
anunciar "Template enviado". Todas las keys de cache MUST derivarse de `vars.convId` capturado al
disparar (memoria `inbox-key-por-conversacion`), y el panel MUST montarse con
`key={conversationId}`.

#### Scenario: envío feliz
- Given template elegido y variables completas
- When confirm
- Then el POST viaja `{templateRef, variables}`, el mensaje devuelto aparece en el hilo sin
  esperar el poll, el panel cierra y el foco vuelve al CTA

#### Scenario: doble click no duplica
- Given `isPending:true`
- Then el botón confirm está `disabled`

#### Scenario: cambio de conversación no contamina
- Given un panel abierto en la conversación A
- When el agente cambia a B
- Then el panel se remonta limpio (key) y ningún estado/valor de A aparece en B

### Requirement: ERR-1 — errores mapeados inline, panel abierto

En error del POST, el panel MUST quedar ABIERTO mostrando el mensaje humano de `mapSendError`
(`role="alert"`) y permitir corregir/reintentar. `mapSendError` MUST extenderse (misma función —
única superficie de mapeo del envío) con: `TEMPLATE_NOT_APPROVED`, `MISSING_TEMPLATE_VARIABLES`,
`TEMPLATE_SEND_REJECTED`, `TEMPLATE_PROVIDER_UNAVAILABLE`, `TEMPLATE_PROVIDER_MISCONFIGURED`,
`CONVERSATION_PHONE_MISSING` — copys en español, accionables (p.ej. proveedor caído → "Reintentá
en unos minutos"). El default existente queda intacto.

#### Scenario: 422 template no aprobado
- Given el server responde 422 `{code:'TEMPLATE_NOT_APPROVED'}`
- Then el panel muestra el copy correspondiente en un `role="alert"` y el catálogo permite elegir
  otro template

#### Scenario: 503 proveedor
- Given 503 `{code:'TEMPLATE_PROVIDER_UNAVAILABLE'}`
- Then copy de reintento, confirm re-habilitado

### Requirement: A11Y-1 — modal completo

El panel MUST ser un dialog modal por portal (molde `PreviewModal` del bulk): `role="dialog"`,
`aria-modal="true"`, `aria-labelledby` al título, foco inicial dentro del modal al abrir, Esc y
click en backdrop cierran, foco de retorno al CTA al cerrar. Labels asociados en Select e inputs
de variables (visible o sr-only). Estados dinámicos anunciados: loading `role="status"`, errores
`role="alert"`, éxito `role="status"`. Motion (entrada/salida, swap de ramas) se define en el
apply según Emil — MUST respetar `prefers-reduced-motion`.

#### Scenario: teclado end-to-end
- Given el panel abierto
- Then se puede completar TODO el flujo (elegir template, tipear variables, confirmar) solo con
  teclado, y Esc cierra devolviendo el foco al CTA

---

## Capability: capa de datos FE

### Requirement: WAPI-1 — api client + hooks

`whatsapp.api.ts` MUST ganar: `listSendableTemplates(): Promise<TemplateSummaryDto[]>` (GET
`/messaging/send-templates`, unwrap `.data.data` — envelope `{data}`) y
`sendWhatsappTemplate(id, {templateRef, variables}): Promise<WhatsappMessage>` (POST, respuesta
FLAT). `useWhatsapp.ts` MUST ganar `useSendableTemplates(enabled)` (key
`['whatsapp','sendTemplates']`, `staleTime` 60s, molde `useTemplates(enabled)`) y
`useSendWhatsappTemplate(id)` (mutation con `onSuccess` append+invalidate; expone
`{sendTemplate, isPending scoped por convId, isError, error, reset}`).

#### Scenario: envelope correcto (anti e2e-envelope-mock-mismatch)
- Given el mock del GET devuelve `{data:[...]}` y el del POST devuelve el DTO flat
- Then `listSendableTemplates` resuelve el array desenvuelto y `sendWhatsappTemplate` el DTO tal
  cual (tests de api espejo de los shapes REALES del BE)

#### Scenario: variables ausentes viajan como objeto vacío o se omiten coherentemente
- Given un template sin variables
- When se envía
- Then el body del POST es `{templateRef, variables:{}}` (contrato explícito con HTTP-1)
