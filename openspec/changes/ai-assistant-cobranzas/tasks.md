# Tasks — `ai-assistant-cobranzas`

Strict TDD: toda tarea de código lleva su test (RED → GREEN, refactor si aplica). No se corre
`npm run build`. Verificación final: `npx tsc --noEmit` + `npm test` completo.

Convención de lotes: un **Lote** agrupa tareas que un solo sub-agente puede tomar sin pisar
archivos de otro lote corriendo en paralelo. **Fase** = orden de dependencia real.

---

## Fase 1 — Schema (bloqueante para adapters Prisma; NO bloquea Lotes B/C)

### Lote A — Migration (solo este lote toca `prisma/`)
- [x] 1.1 `prisma/schema.prisma`: agregar `AssistantIntent.labels String[] @default([])` y
  `AssistantIntent.triggerPatterns String[] @default([])`; agregar `Client.grPaymentUrl String?`.
- [x] 1.2 `npm run prisma:migrate` (nombre sugerido `assistant_cobranzas_labels_triggers`) y editar
  el SQL generado para agregar, al final: `INSERT INTO "AssistantAction" (key,label,"riskLevel") VALUES ('handoff','Derivar a un humano con etiqueta','green') ON CONFLICT (key) DO NOTHING;` e
  `INSERT INTO "AssistantDataSource" (key,label,enabled) VALUES ('cliente.facturas','Facturas y links de pago',true) ON CONFLICT (key) DO NOTHING;` (nombres de columna: verificar contra
  el resto del schema de `AssistantAction`/`AssistantDataSource` antes de escribir el SQL).
  Test: la migración corre limpia sobre una DB con datos existentes (sin backfill, aditiva) —
  correr `npm run prisma:migrate` en local y confirmar `AssistantAction`/`AssistantDataSource`
  tienen las 2 filas nuevas.
  NOTA (sdd-apply): no hay DB local disponible en este entorno — se escribió
  `prisma/migrations/20261114000000_assistant_cobranzas_labels_triggers/migration.sql` a mano
  siguiendo el estilo de `20261023000000_ai_assistant_multiagent` (columnas verificadas contra
  el schema real de `AssistantAction`/`AssistantDataSource`: `key,label,riskLevel,updatedAt` y
  `key,label,enabled,updatedAt`); `npx prisma validate` OK. La corrida contra una DB con datos
  existentes queda pendiente para el deploy (igual que la migración precedente).
- [x] 1.3 `prisma generate` (compartido entre worktrees — correr desde el worktree activo si hay
  error de tipos tras el paso 1.2).

### Lote G0 — 2da migration de la enmienda D9–D11 (⚠️ ESPERAR a que el Lote A cierre: mismo
directorio `prisma/`, nunca en paralelo)
- [x] 1.4 `prisma/schema.prisma`: agregar `AssistantIntent.unassign Boolean @default(false)` (D10) y
  `AssistantIntent.roleKey String?` (D11). Sin índice único global — la unicidad por perfil se
  valida en la ruta de config (2.8/CFG-2).
- [x] 1.5 `npm run prisma:migrate` (`assistant_cobranzas_unassign_rolekey`) y agregar al SQL:
  `INSERT INTO "AssistantDataSource" (key,label,enabled) VALUES ('cliente.recibos_hoy','Recibos de hoy y match de comprobante',true) ON CONFLICT (key) DO NOTHING;`
  Test: corre limpia sobre DB con datos, sin backfill; la fila nueva queda en el catálogo.
  NOTA (sdd-apply): sin DB local disponible — se escribió
  `prisma/migrations/20261115000000_assistant_cobranzas_unassign_rolekey/migration.sql` a mano,
  mismo estilo que la migración precedente; `npx prisma validate` OK. Corrida contra DB con
  datos queda pendiente para el deploy.
- [x] 1.6 `prisma generate` desde el worktree activo.

---

## Fase 2 — Dominio (paralelizable con Fase 1; nada de esto toca DB real)

### Lote B — Entities y ports (un solo lote: son archivos chicos y relacionados)
- [x] 2.1 `src/domain/entities/assistant.ts`: agregar `labels: string[]` y
  `triggerPatterns: string[]` al tipo `AssistantIntent`.
- [x] 2.2 `src/domain/ports/AssistantThreadReader.ts`: agregar tipo `AssistantThreadMessage
  { role, text, generatedByAssistant: boolean }` y cambiar `readRecentTurns` para devolverlo
  (el motor sigue mapeando a `AssistantThreadTurn` para el modelo — el flag no debe llegar al
  prompt, eso se cubre en 3.4/5.2).
  NOTA (sdd-apply): cambiar el shape del puerto rompía `tsc --noEmit` en 3 puntos que ya
  existían (`ChatMessageThreadReader.ts`, el mapeo en `ReplyWithAssistant.ts` y el fixture de
  `ReplyWithAssistant.test.ts`) — se aplicó el parche MÍNIMO de compatibilidad de tipos en los
  tres (rol `'agent'` con `generatedByAssistant:false` como default seguro, y el mapeo de
  vuelta a `AssistantThreadTurn` para el modelo sigue colapsando `'agent'` a `'assistant'`,
  sin cambio de comportamiento observable). La derivación REAL de `generatedByAssistant` desde
  el origen del mensaje sigue siendo tarea de 4.6 (Lote D2) — el placeholder está marcado con
  `TODO(4.6)` en el código. Ver riesgos en el reporte de esta corrida.
- [x] 2.3 `src/domain/ports/AssistantInvoicesReader.ts` (**crear**): interfaz
  `listOpenByClientId(clientId): Promise<AssistantInvoiceFact[]>` con campos `tipo, numero,
  vencimiento, saldo, pdfUrl, couponPdfUrl, paymentUrl` — sin `customerName` ni identidad (DAT-2).
- [x] 2.4 `src/domain/ports/ClientMirrorRepository.ts`: agregar `paymentUrl?: string | null` a los
  params de `updateBalanceAndInvoices` (DAT-3).

### Lote G1 — Entities y ports de la enmienda D9–D11 (⚠️ ESPERAR a que el Lote B cierre: 2.5 y 2.8
tocan los mismos archivos que 2.1 y 2.2)
- [x] 2.5 `src/domain/entities/assistant.ts`: agregar `unassign: boolean` y `roleKey: string | null`
  al tipo `AssistantIntent` (D10/D11).
- [x] 2.6 `src/domain/ports/GestionRealPort.ts`: agregar `FetchClientReceiptsParams
  { grClienteId: string; fechaDesde: string; fechaHasta: string }` (formato `DD-MM-AAAA`,
  `grClienteId` OBLIGATORIO) y el método `fetchClientReceipts(params): Promise<FetchClientReceiptsResult>`.
  NO tocar `fetchReceipts` ni `FetchReceiptsParams` — la ingesta global de finanzas no se altera (D9).
  NOTA (sdd-apply): ripple — `GestionRealClient`/`InMemoryGestionRealPort` implementan el port y
  quedaron con un stub que TIRA (`TODO(4.7, Lote D3)`), nunca un `{disponible:false}` silencioso:
  nada debe confundir "no está cableado" con "GR no tiene recibos".
- [x] 2.7 `src/domain/ports/AssistantConversationGateway.ts`: agregar
  `unassign(conversationId): Promise<void>` con el comentario de por qué desasigna en los DOS lados
  (espejo local + Chatwoot) — ACT-4.
  NOTA (sdd-apply): ripple — `ChatwootAssistantConversationGateway` (único implementador de infra)
  y el `SpyGateway` de `ReplyWithAssistant.test.ts` recibieron un stub compat
  (`TODO(4.10, Lote D3)`); el gateway real TIRA a propósito, el spy sólo cuenta llamadas.
- [x] 2.8 `src/domain/ports/AssistantThreadReader.ts`: agregar `attachmentFilenames: string[]` a
  `AssistantThreadMessage` (creado en 2.2) — el motor necesita el `filename` del adjunto para
  detectar `comprobante_<op>.*` (DAT-4/D11).
  NOTA (sdd-apply): ripple — `ChatMessageThreadReader.ts` recibió el mismo placeholder de
  compatibilidad que 2.2 (`[]`, `TODO(4.11, Lote D3)`); tests de `AssistantThreadReader.test.ts` y
  `ReplyWithAssistant.test.ts` actualizados con el campo nuevo. Tests nuevos agregados a
  `AssistantThreadReader.test.ts` para `attachmentFilenames` (con y sin adjuntos).

### Gap fix (2.9) — labels/triggerPatterns/unassign/roleKey expuestos vía CRUD de config (CFG-2)
- [x] 2.9 Encontrado por el Lote A+B anterior y confirmado en este run: `CreateAssistantIntentInput`/
  `UpdateAssistantIntentInput` (`domain/ports/AssistantProfileRepository.ts`), los comandos de
  `CreateAssistantIntent.ts`/`UpdateAssistantIntent.ts`, `AssistantIntentDto`
  (`application/dto/assistant.dto.ts`), los repos `InMemoryAssistantIntentRepository`/
  `PrismaAssistantIntentRepository` y las rutas `POST /profiles/:id/intents` /
  `PATCH /intents/:id` (zod `CreateIntentSchema`/`UpdateIntentSchema`) NO exponían
  `labels`/`triggerPatterns`/`unassign`/`roleKey` pese a existir en la entidad y el schema desde
  1.1/1.4 — sin este fix, CFG-2/D10/D11 son literalmente imposibles de configurar. Implementado:
  los 4 campos pasan por el CRUD completo; nueva validación `assertTriggerPatternsAllowed`
  (compartida por create/update) tira `TriggerPatternsRequireHandoffActionError` (400,
  `ASSISTANT_TRIGGER_PATTERNS_REQUIRE_HANDOFF`) si `triggerPatterns` no vacío y el `actionKey`
  EFECTIVO (el del patch, o el existente si el patch no lo toca) no es `'handoff'` — cubre también
  el caso "cambiar actionKey lejos de handoff con triggerPatterns vigentes de un patch anterior".
  Gap adicional encontrado y corregido: `ASSISTANT_ACTION_SEED`/`ASSISTANT_DATA_SOURCE_SEED`
  (`domain/ports/AssistantCatalogRepository.ts`, el espejo in-memory de las migraciones) NO tenían
  `handoff`/`cliente.facturas`/`cliente.recibos_hoy` pese a que las 2 migraciones de este change ya
  las insertan en DB — sin este fix, CFG-3 rechazaba con 400 cualquier intent que usara estas keys.
  Tests: `AssistantConfigUseCases.test.ts`, `InMemoryAssistantRepositories.test.ts`,
  `assistant.routes.test.ts` (conteos del catálogo actualizados 4→6 fuentes, 5→6 acciones).
  CERRADO en el batch D/E/G2: la unicidad de `roleKey` POR PERFIL (spec CFG-2, "roleKey duplicado
  dentro del mismo perfil se rechaza") ya está implementada — `assertRoleKeyIsFree`
  (`CreateAssistantIntent.ts`, compartida con `UpdateAssistantIntent`) tira
  `AssistantRoleKeyConflictError` (400, `ASSISTANT_ROLE_KEY_CONFLICT`). `null` nunca choca; la
  edición se excluye a sí misma; el MISMO roleKey en OTRO perfil es válido (sin índice único
  global, D11). Tests en `AssistantConfigUseCases.test.ts` (6 casos).

---

## Fase 3 — Application: funciones puras (depende de 2.1–2.3; independiente de Fase 1)

Strict TDD por tarea: escribir el test primero, confirmar rojo, implementar, confirmar verde.

### Lote C1 — Render y split (mismo dominio, un sub-agente)
- [x] 3.1 RED: `src/__tests__/application/assistant/splitForWhatsapp.test.ts` — casos: 6 facturas
  → 2 chunks ≤1400 numerados `(1/2)`/`(2/2)` con el prefijo dentro del cap; URL nunca cortada a
  la mitad; corte preferido `\n\n` > `\n` > espacio (REN-2).
  GREEN: `src/application/use-cases/assistant/splitForWhatsapp.ts` (**crear**).
- [x] 3.2 RED: `src/__tests__/application/assistant/renderInvoiceBlock.test.ts` — casos: bloque con
  N facturas + link total (`Client.grPaymentUrl`); aclaración de alias "titular IPNEXT S.A., CUIT
  30-70849985-0" cuando corresponde pagar por alias; `null` si no hay facturas (REN-1).
  GREEN: `src/application/use-cases/assistant/renderInvoiceBlock.ts` (**crear**).

### Lote C2 — Triggers y guarda de agente activo (mismo dominio, otro sub-agente — no toca los
mismos archivos que C1, corre en paralelo)
- [x] 3.3 RED: `src/__tests__/application/assistant/assistantTriggers.test.ts` — casos: "ya pagué y
  no tengo internet" matchea `reclamo_servicio` sin invocar al modelo; intent deshabilitada no
  matchea; regex inválida se ignora con warn y no rompe (RTR-4).
  GREEN: `src/application/use-cases/assistant/assistantTriggers.ts` (**crear**) con
  `matchTriggerIntent(lastCustomerText, intents)`.
- [x] 3.4 RED: extender `src/__tests__/application/assistant/assistantGuards.test.ts` — casos: hay
  un turno `role:'agent', generatedByAssistant:false` posterior al último `customer` ⇒
  `stop('agent_active')`; agente respondió ANTES del último customer ⇒ continúa; sin señales ⇒
  continúa (SEC-6).
  GREEN: `src/application/use-cases/assistant/assistantGuards.ts` — agregar
  `evaluateAgentActivity(thread)` y el reason `'agent_active'` al union type.

### Lote C3 — Funciones puras de la enmienda D9–D11 (archivos NUEVOS: no pisa C1 ni C2, corre en
paralelo con ambos; sólo depende de 2.5/2.6)
- [x] 3.5 RED: `src/__tests__/application/assistant/comprobantes.test.ts` (**crear**) —
  `extractComprobanteOperacion`: `comprobante_177332834792.pdf` ⇒ `'177332834792'`; `.jpg`/`.jpeg`/
  `.png` también; menos de 6 dígitos ⇒ `null`; otro archivo ⇒ `null`; varios adjuntos ⇒ el primero
  que matchea. `matchReceiptOperation`: matchea si una referencia CONTIENE la op
  (`"MercadoPago: 177332834792"`); NO matchea por prefijo corto ni con lista vacía.
  `detectDoublePayment`: 2 recibos de $77.997,19 ⇒ `true` (caso Bravo); importes distintos ⇒
  `false`; comparación en centavos, sin errores de float (DAT-4).
  GREEN: `src/application/use-cases/assistant/comprobantes.ts` (**crear**).
- [x] 3.6 RED: mismo archivo de test — `detectPaymentPromise(texto, patterns)` con los patterns de
  la fila `promesa_pago`: "te pago el lunes", "a fin de mes", "cuando cobre", "no puedo ahora" ⇒
  `true`; "ya te pagué" ⇒ `false`; regex inválida se ignora con warn (INT-2).
  GREEN: agregar `detectPaymentPromise` a `comprobantes.ts`.
- [x] 3.7 RED: `src/__tests__/application/assistant/renderBalanceSignMessage.test.ts` (**crear**) —
  `debt>0` ⇒ menciona pago recibido + saldo restante + N facturas y NUNCA la frase "al día"
  (caso Vargas: pago $41.410,56, `debt` $72.589,41); `debt=0` ⇒ al día; `debt<0` ⇒ al día +
  saldo A FAVOR (caso Bravo: `-77.997,19`); saldo no disponible ⇒ `null`, no afirma nada (RSP-1).
  GREEN: `src/application/use-cases/assistant/renderBalanceSignMessage.ts` (**crear**).
- [x] 3.8 RED: `src/__tests__/application/assistant/selectComprobanteOutcome.test.ts` (**crear**) —
  las 5 filas de la tabla D11: sin match o `recibos_no_disponibles` ⇒ `comprobante_transferencia`;
  match + `debt>0` + promesa ⇒ `pago_parcial_con_promesa`; match + `debt>0` sin promesa ⇒
  `comprobante_mp`; match + `debt≤0` ⇒ `comprobante_mp`; `posibleDoblePago` ⇒ además label
  `administracion`. Y: `roleKey` de destino ausente o deshabilitado ⇒ handoff `necesita-humano`
  con el motivo, nunca comportamiento inventado (INT-3, INT-4).
  GREEN: `src/application/use-cases/assistant/selectComprobanteOutcome.ts` (**crear**).
  NOTA (sdd-apply): la función devuelve `{kind:'roleKey', roleKey, extraLabels}` o
  `{kind:'missing_role', roleKey, reason}` — el mapeo de `missing_role` a `handoff` +
  `necesita-humano` + nota privada es responsabilidad del caller (5.7, Lote G2), fuera de este
  batch. `debt===null` con match encontrado cae en `comprobante_mp` (no está en la tabla D11
  explícitamente); `renderBalanceSignMessage` ya devuelve `null` en ese caso, así que no se
  afirma nada — comportamiento seguro por defecto, no verificado con un caso propio en el test.

---

## Fase 4 — Infrastructure: adapters (Lote D1 depende de 2.3; Lote D2 Prisma depende también de
Fase 1 completa; D1 e D2 no comparten archivo, corren en paralelo)

### Lote D1 — Reader in-memory + resolver (no requiere migración aplicada)
- [x] 4.1 RED: `src/__tests__/infrastructure/adapters/in-memory/InMemoryAssistantInvoicesReader.test.ts`
  — devuelve las facturas cargadas por `clientId`, proyección sin PII.
  GREEN: `src/infrastructure/adapters/in-memory/InMemoryAssistantInvoicesReader.ts` (**crear**).
- [x] 4.2 RED: `src/__tests__/infrastructure/adapters/assistant/assistantMotivoGuia.test.ts` —
  extender con el motivo `'facturas_no_disponibles'` (DAT-1).
  GREEN: `src/infrastructure/adapters/assistant/assistantMotivoGuia.ts`.
- [x] 4.3 RED: `src/__tests__/infrastructure/adapters/assistant/ClienteFacturasResolver.test.ts`
  (**crear**) con dobles in-memory de `RefreshClientBalanceIfStale` y `AssistantInvoicesReader` —
  casos: balance fresco → devuelve facturas sin refrescar de nuevo; stale y el refresh falla →
  `motivoNoDisponible('facturas_no_disponibles')` sin facturas viejas; refresh corrige stale pero
  lista vacía → NO afirma "al día" (DAT-1, D7/D8).
  GREEN: `src/infrastructure/adapters/assistant/ClienteFacturasResolver.ts` (**crear**), molde
  `ClienteSaldoResolver`.

  NOTA (sdd-apply): `AssistantInvoicesReader` ganó un segundo metodo,
  `findTotalPaymentUrlByClientId` (el link "pagar todo junto", `Client.grPaymentUrl`, D8). Vive
  en ESTE puerto y no en `CustomerRepository` por la misma razon que `listOpenByClientId`: sacarlo
  de la ficha del cliente obligaria al resolver a cargar nombre/mail/telefono/direccion (SEC-1 al
  reves). Lista de facturas VACIA ⇒ `motivoNoDisponible('facturas_no_disponibles')`, literal segun
  D7 — el resolver nunca emite un hecho que se pueda leer como "al dia".
### Lote D2 — Reader Prisma + mirror + thread reader (requiere Fase 1 aplicada)
- [x] 4.4 RED: `src/__tests__/infrastructure/PrismaAssistantInvoicesReader.test.ts` (**crear**,
  mismo directorio que `PrismaPortalPaymentsReader.test.ts`) — proyección SELECT sin
  `customerName`/identidad; filtra por `clientId` (DAT-2).
  GREEN: `src/infrastructure/adapters/prisma/PrismaAssistantInvoicesReader.ts` (**crear**).
- [x] 4.5 RED: `src/__tests__/infrastructure/PrismaClientMirrorRepository.paymentUrl.test.ts`
  (**crear**) — payload con `payments_url_saldos.MercadoPago` escribe `grPaymentUrl` en la MISMA
  transacción que saldo+facturas; payload sin ese campo NO vacía el valor anterior (DAT-3).
  GREEN: `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts`
  (`updateBalanceAndInvoices`).
- [x] 4.6 RED: `src/__tests__/infrastructure/adapters/assistant/ChatMessageThreadReader.test.ts`
  (**crear**) — `readRecentTurns` devuelve `generatedByAssistant` por mensaje, derivado del
  autor/origen del mensaje en el espejo.
  GREEN: `src/infrastructure/adapters/assistant/ChatMessageThreadReader.ts`.

  NOTA (sdd-apply): el espejo NO tiene hoy ninguna marca de "lo escribio el bot" (`ChatMessage`
  no distingue un outbound de `SendMessage` de uno de un agente en Chatwoot; `origin` es
  `'chatwoot'` en los dos). La derivacion quedo por LISTA BLANCA de `senderName`
  (`ChatMessageThreadReaderOptions.assistantSenderNames`), con default `[]`. Asimetria
  deliberada: marcar de MENOS solo hace al motor mas cauto; marcar de MAS apaga SEC-6 y lo hace
  hablar encima de un humano. ⚠️ Con el default vacio la señal queda del lado seguro pero INERTE
  — cablear la lista en `app.ts`/composicion es follow-up (Lote F).
### Lote D3 — Adapters de la enmienda D9–D11 (depende de 2.6/2.7/2.8; 4.11 comparte archivo con
4.6 ⇒ esperar a que el Lote D2 cierre)
- [x] 4.7 RED: `src/__tests__/infrastructure/adapters/gestion-real/fetchClientReceipts.test.ts`
  (**crear**) — el body posteado lleva `action:'recibos'`, `cliente_id` y fechas `DD-MM-AAAA`;
  la respuesta DICT `recibos` se parsea reusando `parseReceiptsResponse`; los anulados
  (`fecha_anulacion` real, ≠ `00-00-0000`) quedan afuera; `items[].numero_transferencia` sobrevive
  al parseo (DAT-4).
  GREEN: `GestionRealClient.fetchClientReceipts` + `InMemoryGestionRealPort.fetchClientReceipts`.
- [x] 4.8 RED: `src/__tests__/infrastructure/adapters/assistant/ClienteRecibosHoyResolver.test.ts`
  (**crear**) — recibo de hoy con `"MercadoPago: <op>"` ⇒ `matchOperacion.encontrado:true` con
  importe; sin match ⇒ `false`; GR tira ⇒ `{disponible:false, motivo:'recibos_no_disponibles'}` y
  NO afirma que no hay pago; 2 recibos del mismo importe ⇒ `posibleDoblePago:true`; hechos sin PII
  (`assertFactsArePiiFree`) (DAT-4).
  GREEN: `src/infrastructure/adapters/assistant/ClienteRecibosHoyResolver.ts` (**crear**), molde
  `ClienteSaldoResolver`.
- [x] 4.9 RED: extender `src/__tests__/infrastructure/adapters/assistant/assistantMotivoGuia.test.ts`
  con el motivo `'recibos_no_disponibles'`.
  GREEN: `src/infrastructure/adapters/assistant/assistantMotivoGuia.ts`.
- [x] 4.10 RED: `src/__tests__/infrastructure/adapters/assistant/ChatwootAssistantConversationGateway.unassign.test.ts`
  (**crear**) — `unassign` delega en `AssignConversation(conversationId, null, null)` (espejo local)
  Y llama al gateway de Chatwoot (`assignee_id: 0`); si UNO de los dos falla, no lanza y queda
  logueado (ACT-4). ⚠️ verificado: `AssignConversation` NO habla con Chatwoot — hacen falta los dos.
  GREEN: `ChatwootAssistantConversationGateway.unassign` + `ChatwootGateway.unassignConversation`
  (método nuevo) + el doble in-memory del gateway del assistant.
- [x] 4.11 RED: extender `src/__tests__/infrastructure/adapters/assistant/ChatMessageThreadReader.test.ts`
  (creado en 4.6) — `readRecentTurns` devuelve `attachmentFilenames` por mensaje desde el espejo de
  adjuntos; mensaje sin adjuntos ⇒ `[]` (DAT-4).
  GREEN: `src/infrastructure/adapters/assistant/ChatMessageThreadReader.ts`.

---

## Fase 5 — Application: wiring del use case (depende de Fase 2, 3 y 4 completas)

### Lote E — `ReplyWithAssistant.ts` + webhook (un solo lote: todo cae en el mismo flujo y en
gran parte el mismo archivo — evitar dos sub-agentes tocando `ReplyWithAssistant.ts` a la vez)
- [x] 5.1 RED: extender `src/__tests__/application/assistant/ReplyWithAssistant.test.ts` — "ya
  pagué y no tengo internet" con `triggerPattern` en `reclamo_servicio` fuerza esa intent SIN
  llamar al clasificador, `AssistantRun.reason='trigger_pattern'` (RTR-4).
  GREEN: enchufar `matchTriggerIntent` (3.3) antes de `runtime.classify` en
  `src/application/use-cases/assistant/ReplyWithAssistant.ts`.
- [x] 5.2 RED: mismo archivo de test — intención `handoff` aplica `intent.labels ∪
  ASSISTANT_LABEL_NEEDS_HUMAN`, nota privada `🤖 STOP: <motivo>`, NO responde al cliente; label
  inválido no bloquea `necesita-humano` ni la nota (ACT-3).
  GREEN: agregar el caso `'handoff'` a `executeAction` en `ReplyWithAssistant.ts`.
- [x] 5.3 RED: mismo archivo — turno de agente humano posterior al último customer, o
  `assigneeName` no vacío ⇒ noop con `reason='agent_active'`, sin llamar al modelo (SEC-6).
  GREEN: invocar `evaluateAgentActivity` (3.4) + chequeo de `assigneeName` en el flujo antes de
  redactar.
- [x] 5.4 RED: mismo archivo — 2 facturas + `grPaymentUrl` ⇒ el texto del modelo no lleva montos
  ni links y el bloque anexado (post SEC-4, sobre `generated.text` solamente) lista ambas con su
  `paymentUrl` y el link total; split ≤1400 en el mismo `reply`/`privateNote` existente sin
  cambiar el puerto; falla el 2do de 3 chunks ⇒ `outcome:'partial_send'` + nota privada
  `🤖 envié N de M mensajes, seguí vos` — nunca `safely` mudo (D3, REN-1, REN-2).
  GREEN: en `ReplyWithAssistant.ts` — paso 6b (append `renderInvoiceBlock`) y 6c (split e
  iteración secuencial de chunks) entre SEC-4 y el envío; capturar el índice de fallo.
- [x] 5.5 RED: extender `src/__tests__/application/messaging/ReceiveChatwootWebhook.test.ts` —
  `conversation.meta.assignee` presente en el payload se propaga como
  `ReplyWithAssistantCommand.assigneeName`; ausente ⇒ `null` (D4.2).
  GREEN: `src/application/use-cases/messaging/ReceiveChatwootWebhook.ts` — leer
  `conversation.meta.assignee` y pasarlo al comando.

### Lote G2 — Enmienda D9–D11 en `ReplyWithAssistant.ts` (⚠️ MISMO archivo que el Lote E: NO
paralelizar — empezar cuando 5.1–5.5 estén cerradas)
- [x] 5.6 RED: extender `ReplyWithAssistant.test.ts` — el último inbound trae adjunto
  `comprobante_<op>.pdf` ⇒ el pre-chequeo NO deja ganar a `promesa_pago` y fuerza la intent con
  `roleKey:'comprobante_mp'` (la que declara `cliente.recibos_hoy`); sin adjunto, la promesa sí
  gana (D11).
  GREEN: excepción del comprobante en el pre-chequeo de `ReplyWithAssistant.ts`.
- [x] 5.7 RED: mismo archivo — etapa 4b: con los hechos resueltos, `selectComprobanteOutcome` (3.8)
  puede REDIRIGIR a otra intent por `roleKey`; sin match ⇒ `comprobante_transferencia`; match +
  `debt>0` + promesa ⇒ `pago_parcial_con_promesa`; `roleKey` faltante ⇒ `necesita-humano` + nota
  (INT-3, INT-4).
  GREEN: paso 4b en `ReplyWithAssistant.ts`, entre hechos y redacción.
- [x] 5.8 RED: mismo archivo — `intent.labels` y `intent.unassign` se aplican para CUALQUIER
  `actionKey` (`whatsapp_reply` y `private_note`, no sólo `handoff`); orden acción → labels →
  `unassign`; un fallo de `unassign` no cambia el `outcome:'replied'` ni tumba la nota; con
  `unassign:false` se etiqueta pero no se desasigna (ACT-3, ACT-4).
  GREEN: mover la aplicación de labels/unassign al final del pipeline en `ReplyWithAssistant.ts`.
- [x] 5.9 RED: mismo archivo — R2 punta a punta: pago verificado + `debt>0` ⇒ el mensaje reconoce el
  pago, informa saldo restante y facturas y NO dice "al día"; `debt<0` ⇒ al día + saldo a favor;
  `cliente.saldo` no disponible ⇒ no afirma ninguno de los dos (RSP-1); `posibleDoblePago` ⇒ el
  mensaje lo menciona y se aplica `administracion` (INT-4).
  GREEN: enchufar `renderBalanceSignMessage` (3.7) en el armado de la respuesta.

  NOTA (sdd-apply): `ClienteSaldoResolver` emite `saldo: 0` para TODO `balanceDue <= 0`
  (fix wave FW2-1), asi que un saldo A FAVOR llega al motor como `0`: la rama `debt < 0` de
  `renderBalanceSignMessage` es inalcanzable por este camino y el bot dice "quedaste al dia" sin
  mencionar el credito. Sub-informar es el lado seguro; el caso peligroso (`debt > 0`) si esta
  cubierto. Reportado como riesgo.
---

## Fase 6 — Composición (depende de Fase 4 y 5 completas)

### Lote F — Wiring final (un solo lote: `composeAssistantEngine.ts` es un archivo compartido,
no paralelizar)
- [x] 6.1 RED: extender `src/__tests__/infrastructure/assistant-composition.test.ts` —
  `cliente.facturas` registrado en el `AssistantDataSourceRegistry` y habilitado; el
  `ClienteFacturasResolver` usa la MISMA instancia de `RefreshClientBalanceIfStale` que
  `cliente.saldo` (pin contra el bug W6, D8).
  GREEN: `src/infrastructure/http/composeAssistantEngine.ts` — instanciar
  `PrismaAssistantInvoicesReader`, registrar `ClienteFacturasResolver` bajo `'cliente.facturas'`
  reusando el `RefreshClientBalanceIfStale` ya compartido.
- [x] 6.2 `src/infrastructure/http/app.ts` — **única** línea: pasar el nuevo reader al compose.
  Nada más se toca acá (regla God Object). Sin test propio (cubierto por 6.1 vía composición).
  NOTA (sdd-apply, desviación): el `PrismaAssistantInvoicesReader` NO se pasa desde `app.ts`
  — se instancia dentro de `composeAssistantEngine` (que es lo que pide 6.1 textualmente, y
  es lo que ya hace con los otros 6 adapters Prisma: no tiene config ni colaboradores). Lo que
  `app.ts` SÍ tuvo que aportar son las 3 deps que el compose no puede construir solo:
  `gestionReal` (el MISMO `GestionRealClient` del refresh, hoisteado del bloque opt-in de GR),
  `assignConversation` (hoisteada: la instancia ahora se comparte con el router de mensajería)
  y los options del `ChatMessageThreadReader` (`chatAttachmentRepo` + `assistantSenderNames`).
  Cubierto por 5 tests de boot REAL de `createApp()` en `assistant-composition.test.ts`
  (identidad con `toBe`, más los 2 controles de ausencia).

### Lote G3 — Composición de la enmienda (⚠️ mismo archivo que 6.1: después del Lote F)
- [x] 6.3 RED: extender `src/__tests__/infrastructure/assistant-composition.test.ts` —
  `cliente.recibos_hoy` registrado y habilitado; el `ClienteRecibosHoyResolver` usa el MISMO
  `GestionRealPort` que el resto y el `unassign` del gateway está cableado al `AssignConversation`
  real (no a un stub) (D9/ACT-4).
  GREEN: `src/infrastructure/http/composeAssistantEngine.ts` — registrar el resolver bajo
  `'cliente.recibos_hoy'` y pasar `AssignConversation` + `ChatwootGateway` al gateway del assistant.

---

## Fase 7 — Verificación de código (bloqueante, sin paralelismo, tras Fases 1–6 en verde)
- [x] 7.1 `npx tsc --noEmit` — cero errores de tipos en todo el repo.
- [x] 7.2 `npm test` — suite completa en verde, sin workers huérfanos (matar `jest` residuales
  antes de correr). Corrida con `npx jest --runInBand` (un solo proceso, 600,8 s):
  **1284 suites passed + 6 skipped (1290 total), 13520 tests passed + 88 skipped (13608 total),
  0 failed**.
  ⚠️ NOTA (sdd-apply): el proceso sale con **exit code 1** pese a los 0 failed, por 4 avisos
  `Cannot log after tests are done` de un `void repo.record(...)` fire-and-forget en
  `auditMutationsMiddleware.ts:136` que rechaza tarde (no hay Postgres con credenciales válidas
  en este entorno). **Verificado que es PRE-EXISTENTE y no de este change**: con
  `assistant-composition.test.ts` revertido a su versión baseline (y todos los cambios de
  fuente de este batch aplicados) la corrida de `src/__tests__/infrastructure` sigue dando
  exit 1 con los MISMOS 4 avisos; excluyendo ese archivo da exit 0 y cero avisos. El rechazo
  huérfano nace en otra suite y aterriza durante los `createApp()` de la composition-root test,
  que ya existían antes de este change. Puede hacer fallar el job de CI — fix fuera de alcance.

---

## Fase 8 — CONFIG post-deploy (NO es código; ejecuta el usuario tras mergear y deployar Fases
1–7; estrictamente secuencial, cada paso depende del anterior)

- [ ] 8.1 Chatwoot (usuario): crear los labels `soporte` y `administracion` si no existen.
- [ ] 8.2 UI de config del proveedor (`UpdateAssistantProviderConfig`, ya existente): cargar la
  API key de DeepSeek para este entorno, si no está cargada.
- [ ] 8.3 Config (`UpdateAssistantRoutingConfig`, ya existente): `defaultAreaId =
  e09fac32-34eb-46cc-8ec0-c809039eb8ea` (Facturación) (D1/CFG-1).
- [ ] 8.4 Config (`CreateAssistantProfile`, ya existente): crear el único perfil de este change en
  Facturación, `enabled:true`, `enabledActions` incluye `handoff` y `private_note` — **sin**
  `whatsapp_reply` todavía (D6/DFT-1).
- [ ] 8.5 Config (`CreateAssistantIntent` × 7, ya existente): sembrar las intents STOP de INT-1,
  todas `actionKey:'handoff'`: `reclamo_servicio` (`labels:['soporte']`, triggerPattern p.ej.
  `no tengo (internet|servicio)`), `plan_pago` (`labels:[]`), `disputa_monto` (`labels:[]`),
  `baja` (`labels:[]`), `enojo` (`labels:[]`), `comprobante_transferencia`
  (`labels:['administracion']`, triggerPattern p.ej. `transferenc|comprobante`),
  `equivocado`/`auto-responder` (`labels:[]`, handoff silencioso, no cierra la conversación).
- [ ] 8.6 Config (`CreateAssistantIntent` × 4, ya existente): crear las intents de cobranza que sí
  redactan contenido (usan `cliente.facturas` + `cliente.saldo`), `actionKey:'private_note'`,
  `responseGuide` con la instrucción explícita de NO escribir montos ni links (SEC-4/REN-1). El
  copy exacto (nombres, `examples`, texto del `responseGuide`, aclaración de alias) lo define el
  usuario — pregunta abierta del `design.md`, no se inventa en código ni en este seed.
- [ ] 8.7 Flag global `ai-assistant-enabled` → `true`, recién después de confirmar 8.1–8.6.
- [ ] 8.8 Prueba en vivo con UN cliente real en modo borrador: verificar nota privada, bloque de
  facturas con links reales, numeración de chunks si aplica, y los labels correctos por intent.
- [ ] 8.9 Tras una semana sin incidentes en borrador: "soltar" las 4 intents de cobranza —
  `actionKey` a `whatsapp_reply` y habilitarla en `enabledActions` del perfil (D6, sin deploy).

### Lote G4 — CONFIG de las 3 intents nuevas (usuario; va entre 8.6 y 8.7 en el orden real)
- [ ] 8.10 `CreateAssistantIntent` — `promesa_pago`: `roleKey:'promesa_pago'`,
  `actionKey:'handoff'`, `labels:['administracion']`, `unassign:true`, `dataSourceKeys:[]`,
  `triggerPatterns` con las frases de promesa: `pago (luego|mas tarde|despues)`,
  `(te )?pago (mañana|el lunes|el martes|…)`, `la (proxima )?semana( que viene)?`, `a fin de mes`,
  `cuando (cobre|me paguen|cobro)`, `no puedo (pagar )?(ahora|hoy)`, `me esperas`. Esta lista es la
  ÚNICA fuente de frases de promesa — 8.11 la reusa (INT-2/D11).
- [ ] 8.11 `CreateAssistantIntent` — `pago_parcial_con_promesa`: `roleKey` homónimo,
  `labels:['administracion']`, `unassign:true`,
  `dataSourceKeys:['cliente.recibos_hoy','cliente.saldo','cliente.facturas']`,
  `actionKey:'private_note'` (nace en borrador, D6). SIN `triggerPatterns` (la elige el selector
  4b, no el pre-chequeo — guardarlos daría 400 por CFG-2). `responseGuide`: UN solo mensaje,
  reconocer el pago, saldo restante y N facturas, mencionar la fecha prometida si la dijo, NO
  escribir montos ni links (los pone el código) (INT-3).
- [ ] 8.12 `CreateAssistantIntent` — `comprobante_mp`: `roleKey` homónimo, `labels:[]`,
  `unassign:false`, mismos `dataSourceKeys` que 8.11, `actionKey:'private_note'`. `responseGuide`
  con las tres ramas del signo del saldo (RSP-1) y la mención de doble pago cuando el hecho
  `posibleDoblePago` viene en `true`, sin prometer devolución ni plazo (INT-4).
- [ ] 8.13 Revisar que `comprobante_transferencia` (sembrada en 8.5) tenga `roleKey` homónimo,
  `unassign:true` y `labels:['administracion']` — es el destino del selector cuando no hay match.
- [ ] 8.14 Prueba en vivo (borrador) con los 3 casos reales del 04-09 antes de soltar nada:
  comprobante con deuda restante (Vargas, op 177332834792), pago parcial + promesa de fin de mes
  (Moreyra Evelyn) y doble pago (Bravo Eduardo, 2× $77.997,19). Verificar: mensaje correcto según
  el signo, label `administracion` donde corresponde y conversación DESASIGNADA en Chatwoot **y**
  en el inbox de Prominense.

---

## Resumen de paralelismo

| Puede correr junto | Motivo |
|---|---|
| Lote A + Lote B | Prisma vs. TS puro, sin overlap de archivos |
| Lote C1 + Lote C2 | archivos distintos (`splitForWhatsapp`/`renderInvoiceBlock` vs. `assistantTriggers`/`assistantGuards`) |
| Lote D1 + Lote D2 | in-memory/resolver vs. Prisma/mirror/thread-reader — D2 requiere Fase 1 aplicada, D1 no |
| Lote E | NO paralelizar internamente — todo cae en `ReplyWithAssistant.ts` |
| Lote F, Fase 7, Fase 8 | secuenciales, sin paralelismo |
| Lote C3 + C1 + C2 | archivos NUEVOS (`comprobantes`/`selectComprobanteOutcome`/`renderBalanceSignMessage`) |

### Enmienda D9–D11 — lotes nuevos y sus bloqueos

| Lote | Tareas | Bloqueado por | Motivo |
|---|---|---|---|
| G0 | 1.4–1.6 | **Lote A cerrado** | mismo directorio `prisma/`, 2da migration |
| G1 | 2.5–2.8 | **Lote B cerrado** | 2.5/2.8 tocan `assistant.ts` y `AssistantThreadReader.ts` |
| C3 | 3.5–3.8 | 2.5/2.6 | archivos nuevos: paralelo con C1/C2 |
| D3 | 4.7–4.11 | G1; 4.11 además Lote D2 | 4.11 comparte archivo con 4.6 |
| G2 | 5.6–5.9 | **Lote E cerrado** | todo cae en `ReplyWithAssistant.ts` |
| G3 | 6.3 | Lote F | mismo `composeAssistantEngine.ts` |
| G4 | 8.10–8.14 | 8.6 | config del usuario, va antes del flag (8.7) |

---

## Fase 9 — FIX WAVE (post verificación adversarial 2026-09-05)

> Cada tarea nació de un hallazgo del `verify-report`, con TDD estricto: el test que lo
> reproduce falla contra el código previo. Detalle y porqués: design **D12**.

### CRITICAL

- [x] 9.1 (C1) El adjunto `comprobante_*` deja de desactivar TODOS los `triggerPatterns`:
      `matchTriggerIntent` corre PRIMERO y el adjunto sólo sobrescribe `roleKey:'promesa_pago'`
      (`ReplyWithAssistant.ts`). Test: comprobante + "no tengo internet" ⇒ `reclamo_servicio`.
- [x] 9.2 (C2) `splitForWhatsapp`: guarda `cut <= 0 ⇒ cut = cap` — una URL más larga que el cap
      colgaba el event loop del backend. Test con URL de 2.000+ chars (el viejo usaba 80).
- [x] 9.3 (C3) "en N facturas" sólo con N conocido; `invoiceCount: number | null`.
- [x] 9.4 (C4) Hecho INTERNO `_aFavor` en `ClienteSaldoResolver` + `toPublicFacts` en el motor:
      la rama "saldo a favor" deja de ser inalcanzable sin reabrir el agujero de FW2-1.
- [x] 9.5 (C5) `assistantPhraseGuard.contradictsBalanceState` después de SEC-4, en los dos
      sentidos; sin bloque determinístico ⇒ handoff `contradicts_balance`.

### WARNING / SUGGESTION

- [x] 9.6 (W1) `AssistantThreadMessage.at` (Prisma reader desde `createdAt`) + ventana
      configurable (`ASSISTANT_AGENT_ACTIVE_WINDOW_MIN`, default 60) en `evaluateAgentActivity`;
      sin timestamp ⇒ ACTIVO.
- [x] 9.7 (W2) `assigneeName` ausente ⇒ `undefined` + warning ⇒ tratado como ASIGNADO.
- [x] 9.8 (W3) `markNeedsHuman` aplica `labels[]`/`unassign` de la intent en TODOS sus caminos.
- [x] 9.9 (W4) Ancho del prefijo `(i/N)` iterado hasta estabilizar; test property-style sobre
      7 largos distintos.
- [x] 9.10 (W5) `ReceiptFact.fecha`/`esDeAyer`; match y doble pago SÓLO sobre los de HOY.
- [ ] 9.11 (W6) Evitar la segunda `readRecentTurns` de `ClienteRecibosHoyResolver` —
      **NO SE HACE**: pasar el hilo por el contexto del resolver viola SEC-1 (el contexto no
      lleva contenido) y cambiar el registry por una fuente es desproporcionado para una query.
- [x] 9.12 (W7) `partial_send` deja `necesita-humano`, nunca `bot-respondió`.
- [x] 9.13 (W9) `invoiceBlockFrom` pasa `payByAlias` (fuente: `ASSISTANT_PAY_ALIAS` vía
      `ClienteFacturasResolver`); disclaimer completo con "Si ves otro dato, no transfieras".
- [x] 9.14 (W10) `renderTransferAcknowledgement` + envío en el camino `handoff` cuando
      `roleKey==='comprobante_transferencia'`, con gates de ACT-1/SEC-3. Spec INT-1 y design
      D12.5 actualizados (decisión del dueño, 2026-09-05).
- [x] 9.15 (S1) `spans` muerta en `rawSplit`; (S2) sin importe de GR no se renderiza "$0,00".
- [x] 9.16 Deltas: `design.md` D12, `specs/ai-assistant/spec.md` (SEC-6, ACT-3) y
      `specs/assistant-cobranzas/spec.md` (RSP-1, REN-1, INT-1, DAT-4).

---

## Fase 10 — FIX WAVE 2 (post re-verificación adversarial 2026-09-05)

> Dos regresiones que introdujo la Fase 9 (N1/N2), un agujero del invariante de hechos internos
> (N3) y los follow-ups de N4 con el fuente REAL de Chatwoot v4.13. Detalle: design D12 enmendado.

- [x] 10.1 (N1) `renderTransferAcknowledgement` reescrito: no afirma el MEDIO de pago y califica
      el saldo como pre-imputación ("sin contar este pago"). Se cayó el parámetro `amount` (en
      esta rama nunca se conoce). Test: recibo MP de AYER 23:55 ⇒ el texto no dice "transferencia"
      ni "no por link" y sí dice "sin contar este pago". Spec INT-1 + design D12.5/D12.7.
- [x] 10.2 (N2) `contradictsBalanceState` consciente de la NEGACIÓN: borra las cláusulas negadas
      (corte en `,`/`;`/`.`) y recién ahí busca afirmaciones, en las dos direcciones. Archivo de
      test propio `assistantPhraseGuard.test.ts` (20 casos) + 3 tests end-to-end nuevos.
- [x] 10.3 (N3) `toPublicFacts` recurre en ARRAYS (y en los objetos anidados adentro). Test con
      `_interno` dentro de `cliente.facturas.facturas[i]`, espiando los hechos que ve `generate`.
- [x] 10.4 (N4.1) Comentario + fixture con la forma REAL del webhook de Chatwoot v4.13
      (`meta.assignee: null`, `meta.assignee_type: null`, clave PRESENTE), para que nadie
      "arregle" el mapeo de W2 al revés y deje al bot mudo.
- [x] 10.5 (N4.2) `assignee_type: 'AgentBot'` NO cuenta como humano asignado (SEC-6): si contara,
      el asistente se auto-silenciaría en cuanto Chatwoot le asignara la conversación.
- [x] 10.6 (N6) Trampa de config PINEADA con un test: si la acción de la PRIMERA intent no está
      habilitada, la Etapa 3 corta antes del selector D11 y la conversación sale con
      `necesita-humano` + los labels de esa intent. **No hay test de invariante del seed porque no
      hay seed en el repo**: las intents las carga el operador en la Fase 8 — queda como chequeo
      de rollout, no como test.
- [ ] 10.7 (N4, ROLLOUT) Confirmar en el primer mensaje real que el `console.warn` de
      `ReceiveChatwootWebhook` NO se dispara antes de prender `ai-assistant-enabled`.

