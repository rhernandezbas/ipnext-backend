# Explore — messaging-inbox-notes (F1.5 fase D — NOTA PRIVADA)

> Investigación READ-ONLY. Ningún archivo de código fue modificado (salvo este
> `explore.md`). Repos: BE `ipnext-backend` (este repo) y FE `ipnext-frontend`.
>
> Contexto ya resuelto (no re-investigado acá): F1 (inbox texto) + F1.5-A
> (media) + F1.5-B (contexto rico) YA en prod. Chatwoot soporta notas privadas
> vía `message_type:'activity'`/`private:true` en el create; el webhook trae
> `private:true` (boolean) en esos eventos. **F1 hoy DESCARTA las private
> intencionalmente** (era la lección H2 de esa fase: "private notes leaking" —
> nunca deben llegar al cliente). Fase D no revierte esa lección, la
> RECONFIGURA: dejar de descartarlas en la persistencia y en su lugar
> marcarlas, manteniendo intacta la garantía de que NUNCA salen hacia
> WhatsApp/el cliente.

---

## Current State

El pipeline de mensajería tiene DOS caminos de ingesta que ya **detectan**
`private` en el wire, pero ambos lo usan hoy solo para **filtrar** (nunca
persistir):

1. **Webhook** (`message_created`) — `ReceiveChatwootWebhook.handleMessageCreated`
   (`src/application/use-cases/messaging/ReceiveChatwootWebhook.ts:143-182`).
   `payload.private` ya se parsea (línea 65, `ChatwootWebhookPayload.private?: boolean`),
   `isPrivateNote = payload.private === true` (línea 149), y la línea 170 es el
   punto exacto del descarte:
   ```ts
   if (direction === null || isPrivateNote || payload.id === undefined) return; // §7/H2 — not persisted
   ```
2. **Fetch-on-open (GET)** — `GetConversation.syncFromChatwoot`
   (`src/application/use-cases/messaging/GetConversation.ts:56-93`). El mapper
   `HttpChatwootGateway.toMessageDto` (`src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts:352-369`)
   YA expone `ChatwootMessageDto.private` (línea 366: `r.private === true ? true : undefined`,
   tipado en el port `src/domain/ports/ChatwootGateway.ts:63-71`). El descarte
   vive en `GetConversation.ts:73`:
   ```ts
   if (m.direction === null || m.private === true) continue;
   ```

Es decir: **la detección wire-level ya está resuelta en los dos caminos** — el
trabajo de D no es "aprender a reconocer una nota privada", es cambiar qué se
hace con ese booleano ya conocido (dejar de `return`/`continue`, empezar a
persistir con un flag).

El modelo `ChatMessage` (`prisma/schema.prisma:2782-2799`) NO tiene ninguna
columna de privacidad — solo `id/conversationId/chatwootMessageId/direction/
content/senderName/chatwootCreatedAt/createdAt`. El comentario de `direction`
(líneas 2787-2789) dice literalmente que `activity`/`template` "NO se
persisten" — ese comentario sigue siendo cierto para `activity`/`template`
(eso NO cambia en D), pero quedaría desactualizado respecto de `private`.

El envío (`SendMessage`) hoy NO tiene ningún canal para marcar un mensaje como
privado — ni en el use case, ni en el port `ChatwootGateway.sendMessage`, ni
en el adapter HTTP, ni en la ruta. Todo hardcodea `message_type: 'outgoing'`
sin `private`.

---

## Affected Areas

| Archivo | Por qué |
|---|---|
| `src/application/use-cases/messaging/ReceiveChatwootWebhook.ts:143-182` | Punto de descarte 1 (webhook) — sacar `isPrivateNote` del guard de `return`, pasar `isPrivate` al upsert |
| `src/application/use-cases/messaging/GetConversation.ts:56-93` | Punto de descarte 2 (fetch-on-open) — sacar `m.private === true` del guard de `continue`, pasar `isPrivate` al upsert |
| `prisma/schema.prisma:2782-2799` (`model ChatMessage`) | Falta columna `isPrivate Boolean @default(false)` — migración aditiva |
| `src/domain/ports/ChatMessageRepository.ts:5-36` | `ChatMessageRecord`/`UpsertChatMessageInput` necesitan `isPrivate` |
| `src/infrastructure/adapters/prisma/PrismaChatMessageRepository.ts:9-75` | `toDomain` + `upsert.create`/`update` deben mapear `isPrivate` |
| `src/infrastructure/adapters/in-memory/InMemoryChatMessageRepository.ts:12-58` | Mismo mapeo, mirror in-memory (tests de use case) |
| `src/application/dto/messaging.ts:140-147,200-212` (`ChatMessageDto`/`toChatMessageDto`) | DTO necesita `isPrivate: boolean`, nunca exponer el `ChatMessageRecord` crudo (regla del repo) |
| `src/application/use-cases/messaging/SendMessage.ts:86-205` | Guard de `canReply` (línea 106-108) debe NO aplicar cuando `isPrivate`; el bump de preview al final (líneas 191-201) debe NO ejecutarse para una nota (mismo criterio H2 que el webhook) |
| `src/domain/ports/ChatwootGateway.ts:88-101` (`sendMessage`) | Necesita forma de pasar `private:true` a Chatwoot |
| `src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts:164-197` (`sendMessage`) | Ambos caminos (JSON y multipart) hardcodean `message_type:'outgoing'` sin `private` |
| `src/infrastructure/http/routes/messaging.routes.ts:330-365` (`POST /conversations/:id/messages`) | Solo lee `content`/`files` del body — falta leer `private`/`isPrivate` |
| FE `src/types/whatsapp.ts:56-71,173-184` (`WhatsappMessage`/`PendingSend`) | Necesitan `isPrivate?: boolean` |
| FE `src/api/whatsapp.api.ts:58-84` (`SendMessageInput`/`sendWhatsappMessage`) | Necesita threadear `private` en el POST (JSON y multipart) |
| FE `src/hooks/useWhatsapp.ts:148-215` (`useSendWhatsappMessage`) | `SendVars`/`mutationFn`/optimistic `PendingSend` necesitan `isPrivate` |
| FE `src/pages/whatsapp/WhatsappInboxPage/components/Composer.tsx:75-234` | Falta selector Reply/Nota; `windowDisabled` (línea 103) hoy bloquea SIEMPRE por `!canReply`, tiene que dejar de aplicar en modo Nota |
| FE `.../MessageBubble.tsx:112-197` + `MessageBubble.module.css` | Sin variante visual para nota interna; hoy SIEMPRE alinea por `message.direction` (inbound/outbound) |
| FE `src/tokens/variables.css` | No existe token warning/amber (`--color-danger` es lo único fuera de la paleta neutra/primary) — falta uno para el estilo "nota" |

---

## Por área — qué existe / qué falta / esfuerzo / dependencias

### BE — Filtro (el punto delicado)

**Qué existe**: detección wire-level completa y ya verificada en los dos
caminos (webhook + GET fetch-on-open). El booleano `private`/`isPrivateNote`
ya llega limpio a ambos use cases.

**Qué falta**: en AMBOS lugares, sacar la condición de `private` del guard
que hace `return`/`continue` — pero sin tocar la lógica de `bumpsPreview`
(`ReceiveChatwootWebhook.ts:152`, `bumpsPreview = direction !== null &&
!isPrivateNote`), que debe seguir excluyendo privadas del preview del inbox
SIEMPRE. Pasar `isPrivate` al `upsertByChatwootMessageId`.

**Esfuerzo**: Bajo — son 2 condicionales puntuales + threadear un campo nuevo
por 4 archivos ya con el molde idéntico (`upsertByChatwootMessageId`).

**Dependencias**: requiere que el modelo tenga la columna (ver abajo) antes de
poder persistir el flag.

**Riesgo/lección a NO repetir**: el filtro de F1 existe porque una nota
privada mostrada como si fuera un mensaje normal (sin marcar) es un leak real
— un agente podría interpretar una nota interna como algo que el cliente ya
vio, o peor, el mirror podría alimentar algo que sí llegue al cliente. Mostrar
privadas ahora es INTENCIONAL, pero el flag `isPrivate` tiene que viajar
INTACTO hasta el DTO y la UI — cualquier punto donde se "olvide" reenviarlo
(el DTO, el mapper Prisma, el in-memory) reintroduce el leak en forma más
sutil: ya no "se cuela", sino que se muestra SIN el marcador de "interna".

### BE — Modelo

**Qué existe**: `ChatMessage` maduro, con upsert idempotente por
`chatwootMessageId` (mismo patrón que `ChatMessageAttachment`).

**Qué falta**: migración aditiva `isPrivate Boolean @default(false)` (próximo
timestamp libre tras `20260905000100_chat_media_download_flag` — ej.
`20260906000000_add_chat_message_is_private`, nunca editar SQL a mano, correr
`npm run prisma:migrate`). Actualizar el comment de `direction` en el schema
para aclarar que ahora SÍ persiste `private` (solo `activity`/`template`
siguen fuera). Mapear el campo en `ChatMessageRecord`/`UpsertChatMessageInput`
(port), `PrismaChatMessageRepository` (toDomain + create/update) e
`InMemoryChatMessageRepository`.

**Esfuerzo**: Bajo — 1 columna con default, sin backfill (todo lo histórico
ya filtrado nunca se persistió, no hay filas viejas que reinterpretar).

**Dependencias**: bloquea a "BE — Filtro" y "BE — Escribir" (ambos necesitan
la columna existir para poder pasar `isPrivate` al upsert).

### BE — Escribir una nota privada

**Qué existe**: `SendMessage` con guard order pineado (SEND-1): 404 → 422
`canReply` → validar `files` → `gateway.sendMessage` → mirror. El port
`ChatwootGateway.sendMessage(chatwootConversationId, content, files?)` y su
adapter HTTP (JSON y multipart) siempre mandan `message_type:'outgoing'`
sin ningún campo de privacidad.

**Qué falta**:
1. `ChatwootGateway.sendMessage` necesita una forma de pasar `private:true`
   (ej. 4to parámetro `options?: { private?: boolean }` — aditivo, no rompe
   los call sites de 3 args existentes, mismo criterio que `files?` en SEND-4).
2. `HttpChatwootGateway.sendMessage` — ambos caminos (JSON línea 190-196,
   multipart línea 169-188) deben agregar `private: true`/`form.append('private','true')`
   cuando corresponda.
3. `SendMessage.execute(conversationId, content, files=[], isPrivate=false)`
   — el guard `if (!conversation.canReply) throw MessagingWindowExpiredError`
   (línea 106-108) **debe NO aplicar cuando `isPrivate`** — confirmado por el
   contexto del usuario: una nota interna nunca sale a WhatsApp, la ventana de
   24h es una regla de Meta/WhatsApp, irrelevante para algo que no cruza esa
   frontera. Fix: `if (!isPrivate && !conversation.canReply) throw ...`.
4. **Punto delicado nuevo (no existía en F1)**: el bump de preview al final de
   `SendMessage.execute` (líneas 191-201, `conversationRepo.upsertByChatwootId`
   con `lastMessageAt`/`lastMessagePreview` de `sent.createdAt`/`sent.content`)
   corre INCONDICIONALMENTE hoy. Si se agrega `isPrivate` sin guardarlo acá
   también, una nota interna se convertiría en el preview visible de la lista
   de conversaciones — el MISMO leak que el webhook ya resuelve con
   `bumpsPreview`, pero en el camino de ENVÍO en vez de RECEPCIÓN. Hay que
   replicar el criterio: `isPrivate ? skip bump : bump como hoy`.
5. Ruta `POST /conversations/:id/messages` (`messaging.routes.ts:342-364`)
   necesita leer un campo `private`/`isPrivate` del body (JSON o multipart) y
   pasarlo a `sendMessage.execute`.

**Esfuerzo**: Medio — no es solo threadear un booleano, hay DOS guards de
negocio a ajustar con criterio opuesto (canReply se BYPASEA, preview-bump se
BLOQUEA) y un parámetro nuevo en 4 capas (route → use case → port → adapter).

**Dependencias**: BE — Modelo (columna) primero.

**Decisión abierta — permisos**: no hay evidencia en el repo de un permiso
separado para "escribir notas" vs "responder al cliente" — recomiendo reusar
`messaging:send` (mismo guard `perms.send` en la ruta) salvo que el usuario
quiera un permiso nuevo tipo `messaging:note`.

### FE — Composer (tabs Reply/Nota)

**Qué existe**: `Composer.tsx` con un solo modo, `windowDisabled =
isDetailLoading || !canReply` (línea 103) gatea textarea + botón adjuntar +
envío. `useSendWhatsappMessage` (`useWhatsapp.ts:148-215`) con `SendVars`
tipado (`{content, files, drafts, tempId, convId}`, línea 152) sin campo de
privacidad. `api.sendWhatsappMessage` (`whatsapp.api.ts:64-84`) solo manda
`content`/`files`.

**Qué falta**: selector de modo (`'reply' | 'note'`, tabs como Chatwoot).
Cuando `mode==='note'`: `windowDisabled` NO debe incluir `!canReply` (la nota
se puede escribir SIEMPRE, ventana abierta o no) — requiere separar el guard
en dos ramas explícitas en vez de un solo booleano compartido. `trySend()`
debe pasar `isPrivate: mode==='note'` hasta `send()` → `SendVars` →
`api.sendWhatsappMessage(id, {..., private: true})` (JSON body y
`form.append('private','true')` en el camino multipart). `PendingSend`
necesita `isPrivate` para que la burbuja optimista (`toOptimisticMessage`,
`MessageThread.tsx:45-67`) también se renderice como nota mientras está en
vuelo.

**Esfuerzo**: Medio — no es solo agregar un toggle visual, el gating de
`canReply` hoy está mezclado (textarea, botón adjuntar, botón enviar comparten
`windowDisabled`) y hay que bifurcarlo por modo sin romper el camino de Reply
existente.

**Decisión abierta**: ¿adjuntos en una nota privada? Chatwoot lo permite, pero
es una superficie nueva (multer + `ComposerAttachmentTray` ya condicionados a
`windowDisabled`). Recomiendo dejarlo FUERA del alcance de D v1 (solo texto en
notas) y anotarlo como follow-up — evita mezclar dos features en un mismo
cambio.

**Dependencias**: BE — Escribir (el endpoint tiene que aceptar `private`
antes de que el FE lo mande).

### FE — Render de notas privadas

**Qué existe**: `MessageBubble.tsx` SIEMPRE alinea por `message.direction`
(`.row.inbound`/`.row.outbound`, `MessageBubble.module.css:17-52`) — burbuja a
la izquierda (gris) o derecha (azul `--color-primary-hover`). No hay ningún
variante "sistema"/"nota" en el componente ni en el CSS. `src/tokens/variables.css`
NO tiene token warning/amber — solo `--color-danger`/`--color-danger-bg-hover`
fuera de la paleta neutra/primary.

**Qué falta**:
1. `WhatsappMessage.isPrivate?: boolean` (tipo FE, espejo del DTO).
2. Variante visual en `MessageBubble` — el propio pedido del usuario descarta
   alinear la nota como un outbound normal (Chatwoot tampoco lo hace: sus
   notas privadas ocupan el ancho completo, fondo amarillo, sin
   izquierda/derecha). Requiere una tercera rama de `rowClassName` (ni
   `.inbound` ni `.outbound`) + label "Nota interna" (texto o ícono) + ocultar/
   ajustar el `<time>` si corresponde.
3. Token de color nuevo — no hay uno reusable en `variables.css` hoy. Decisión
   abierta: introducir `--color-note-bg`/`--color-note-border` (ej. amarillo
   tipo Chatwoot, `#fff8e1`/`#f0c14b`) vs. reusar una superficie neutra
   existente con un borde/ícono distintivo (menos "ruidoso" visualmente,
   coherente con que el resto del design system del repo no usa amarillos en
   ningún lado — grep confirmó CERO uso de warning/amber en toda `src/`).

**Esfuerzo**: Bajo-Medio — es principalmente CSS + una rama de renderizado
nueva, sin lógica de negocio.

**Dependencias**: FE — Composer (para que existan notas que renderizar) y BE
DTO (`isPrivate` en `ChatMessageDto`).

---

## Approaches

### Cómo viaja `isPrivate` desde el composer hasta el mirror

1. **Extender `SendMessage`/`sendMessage` existentes con un parámetro opcional
   `isPrivate`** (recomendado)
   - Pros: reusa TODO el pipeline ya maduro (validación de attachments,
     mirror, error handling SEND-8); un solo use case, un solo endpoint; cero
     duplicación de la lógica de multipart/JSON.
   - Cons: `SendMessage.execute` ya tiene 4 responsabilidades (validar,
     enviar, mirror, bump preview) — agregar una 5ta rama condicional
     (bypass canReply + skip preview-bump) le suma superficie de bugs si no
     se testea cada combinación (`isPrivate=true/false` × `canReply=true/false`).
   - Efort: Medio.

2. **Use case separado `AddPrivateNote`** (mencionado como opción en el
   contexto del usuario)
   - Pros: separación de responsabilidades más limpia — el guard de
     `canReply` ni siquiera existe en este use case (nunca se evalúa por
     accidente); un endpoint propio `POST /conversations/:id/notes`.
   - Cons: DUPLICA el flujo de validación de `files`/mirror de attachments/
     manejo de errores de `SendMessage` (mismo problema que el repo ya evitó
     deliberadamente en otros lugares — ver el comentario de
     `RawChatwootAttachment` duplicado a propósito SOLO cuando cruza capas,
     nunca dentro de la misma capa); dos endpoints a mantener en paralelo
     para lo que Chatwoot trata como una sola operación (`POST .../messages`
     con `private` como flag).
   - Efort: Medio-Alto.

**Recomendación**: Opción 1 (extender `SendMessage`), con los DOS guards
explícitos y testeados por separado (`isPrivate` bypassea `canReply`,
`isPrivate` bloquea el bump de preview) — es el mismo criterio arquitectónico
que el repo ya usa en el webhook (`bumpsPreview` como variable derivada, no un
segundo código path entero). Mantiene un solo endpoint, coherente con cómo
Chatwoot mismo modela esto (un solo create-message con `private` como flag,
no un recurso aparte).

---

## Decisiones abiertas (para el proposal)

1. **¿Se muestran TODAS las notas privadas de la conversación (incluidas las
   escritas en Chatwoot directo) o solo las de Prominense?** — Recomendación
   del usuario y técnicamente lo único consistente con la arquitectura mirror
   actual: **todas**. Los dos caminos de captura (webhook + fetch-on-open) ya
   traen CUALQUIER nota privada de Chatwoot, sin distinguir el origen — filtrar
   solo las de Prominense requeriría un campo nuevo de "autor/origen" que hoy
   no existe en ningún lado del pipeline (`senderName` es lo más cercano, pero
   no es una fuente confiable de "vino de Prominense").
2. **¿La nota privada ignora el gate de ventana de 24h?** — Sí, confirmado
   arriba (`SendMessage`, guard `!isPrivate && !conversation.canReply`).
3. **¿El flag `isPrivate` en el mirror requiere migración?** — Sí, migración
   aditiva (`Boolean @default(false)`, sin backfill necesario — ver "BE —
   Modelo"). No hay forma de derivarlo de datos existentes: F1 nunca persistió
   una nota privada, así que no hay filas viejas a reinterpretar.
4. **Estilo visual de la nota** — abierto entre introducir un token
   amber/warning nuevo (más fiel a Chatwoot, pero el repo hoy no tiene
   NINGÚN uso de amarillo en su paleta) vs. un token propio más neutro
   (coherente con el resto del design system, menos "importado de Chatwoot
   sin adaptar"). Recomiendo token propio (ej. `--color-note-bg`) definido en
   `variables.css` para que quede reusable si en el futuro aparecen otras
   superficies "internas" (ej. comentarios de ticket, que hoy NO tienen este
   patrón tampoco — grep confirmó cero precedente de "nota interna" en todo
   `ipnext-frontend`).
5. **Permisos de escritura de nota** — reusar `messaging:send` (recomendado,
   sin evidencia de necesidad de un permiso separado) vs. un permiso nuevo
   `messaging:note`.
6. **Adjuntos en notas privadas** — fuera de alcance de D v1 (recomendado);
   Chatwoot los soporta pero es superficie nueva no pedida explícitamente.

---

## Recommendation

Extender el pipeline existente en vez de crear una ruta paralela:
- **Persistencia**: 1 columna aditiva (`ChatMessage.isPrivate`) + sacar la
  condición de `private` de los DOS guards de descarte existentes
  (`ReceiveChatwootWebhook.ts:170`, `GetConversation.ts:73`), sin tocar
  `bumpsPreview` (eso sigue excluyendo privadas del preview del inbox, tal
  cual hoy).
- **Envío**: extender `SendMessage`/`ChatwootGateway.sendMessage` con
  `isPrivate` opcional (aditivo, cero regresión en las llamadas de 3 args
  existentes) — bypassea `canReply`, bloquea el bump de preview al final
  (el punto NUEVO y delicado que F1 no tenía que resolver).
- **FE**: selector Reply/Nota en `Composer`, gating de `canReply` bifurcado
  por modo, variante visual nueva en `MessageBubble` (fila completa, sin
  alineación inbound/outbound, label "Nota interna", token de color propio).

Esto reusa el 100% del pipeline maduro (dedup, idempotencia, manejo de
errores, attachments) y mantiene la garantía central de F1 (una nota NUNCA
llega al cliente) — solo cambia qué hace la UI de Prominense con algo que
Chatwoot YA le manda marcado.

---

## Risks

- **El filtro de F1 es la salvaguarda real, no cosmética**: revertirlo mal
  (ej. olvidar `bumpsPreview`/el guard nuevo de preview en `SendMessage`)
  reintroduce el leak original, pero disfrazado — el mensaje ya no se
  descarta, se muestra sin marcar como privado en el lugar equivocado
  (preview de la lista de conversaciones, visible sin abrir el thread).
- **Dos guards con criterio OPUESTO en el mismo use case** (`isPrivate`
  BYPASEA `canReply` pero BLOQUEA el bump de preview) — alto riesgo de que una
  implementación apurada invierta uno de los dos o los trate como el mismo
  flag. Necesita tests explícitos para las 4 combinaciones
  (`isPrivate`×`canReply`).
- **Sin precedente visual en el repo** ("nota interna" no existe en ningún
  otro módulo, ni tickets ni tareas) — la variante de `MessageBubble` es
  diseño nuevo, no un clon de un patrón ya probado (a diferencia de, por
  ejemplo, los adjuntos que clonaron 1:1 `task-photos`).
- **Adjuntos en notas** quedan fuera de alcance — si el proposal decide
  incluirlos después, el guard de `windowDisabled`/multer en el composer va a
  necesitar otra pasada.

---

## Ready for Proposal

**Sí.** El punto delicado (el filtro de F1) está localizado con precisión
quirúrgica en 2 líneas (`ReceiveChatwootWebhook.ts:170`, `GetConversation.ts:73`)
más 1 punto NUEVO no obvio (`SendMessage.ts:191-201`, el bump de preview al
enviar). El modelo necesita 1 migración aditiva sin backfill. El resto es
threadear un booleano por capas ya maduras. Las decisiones abiertas (todas
las notas vs. solo Prominense, token visual, permisos, adjuntos) no bloquean
el proposal — tienen recomendación default razonable para que el usuario solo
confirme o corrija.
