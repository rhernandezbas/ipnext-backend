# Design — `ai-assistant-cobranzas`

Decisiones técnicas. No hay motor nuevo: todo se enchufa en las etapas de `ReplyWithAssistant`
(design `ai-assistant-multiagent` D1/D2/D3/D4/D11, que se respeta sin excepción).

---

## D1 — Perfil en Facturación, labels de STOP en Chatwoot

**Decisión.** `AssistantRoutingConfig.defaultAreaId = e09fac32-34eb-46cc-8ec0-c809039eb8ea`
(Facturación) y ahí vive el único `AssistantProfile` de este change. Labels de derivación:
`soporte` y `administracion` (las crea el usuario en Chatwoot).

**Por qué.** El 100% de las intents de este change son de cobranza; Administración recibiría
tráfico que no sabe atender. `defaultAreaId` ya existe (RTR-0) — cero código.

**Descartado.** Administración como default: sus intents serían las mismas y el re-ruteo (RTR-0)
las traería igual, con un salto de más.

**Impacto.** Sólo seed/config. **Riesgo:** una conversación sin área cae al perfil de cobranza
aunque el cliente pregunte otra cosa → lo atajan las intents de STOP (D2) y el `out_of_scope`.

## D2 — Acción `handoff` + `AssistantIntent.labels String[]`

**Decisión.** Campo aditivo `labels String[] @default([])` en `AssistantIntent` y nueva acción de
catálogo `handoff` (`riskLevel: 'green'`). `executeAction('handoff')` aplica `intent.labels` +
`ASSISTANT_LABEL_NEEDS_HUMAN`, deja nota privada `🤖 STOP: <motivo>` y **NO le habla al cliente**.

**Por qué.** Un label de Chatwoot es una **string de un sistema externo**: no hay integridad
referencial posible desde nuestra base. ADR 0003 exige catálogos editables en DB **en lugar de
enums en código** — `String[]` en la fila de la intent ya cumple ese fin (editable en runtime,
sin deploy). Un `AssistantLabel` normalizado agregaría CRUD, UI y FK sobre un vocabulario cuya
autoridad vive en Chatwoot: un catálogo que puede divergir en silencio de la fuente real.

**Descartado.** (a) catálogo `AssistantLabel` — falsa integridad, ver arriba; (b) reusar
`apply_label` — hoy es fijo (`ASSISTANT_LABEL_REPLIED`) y encima no deja nota: un STOP silencioso,
justo lo que el change combate.

**Impacto.** `prisma` (1 columna + seed de la acción), `domain/entities/assistant.ts`
(`AssistantIntent.labels`), repos Prisma/InMemory de intents, `executeAction`, rutas de config
(passthrough). **Riesgo:** label mal tipeado en la UI ⇒ Chatwoot lo crea o lo ignora; es
best-effort (`safely`) y el `necesita-humano` sale igual.

## D3 — Bloque determinístico ANEXADO post-SEC-4, y splitter ≤1.400

**Decisión.** Fuente nueva `cliente.facturas` (D8). El modelo escribe **sólo el texto corto**; el
código renderiza el bloque de facturas y links. Orden en el motor:

```
5 REDACTAR → 6 SEC-4 sobre generated.text SOLO → 6b append bloque → 6c split → 7 enviar chunks
```

Render y split son **funciones puras en `application/`**:
`renderInvoiceBlock(facts): string | null` y `splitForWhatsapp(text, cap=1400): string[]`
(numera `(1/2)` reservando el prefijo DENTRO del cap; corta en `\n\n` > `\n` > espacio, nunca a
mitad de URL). `executeAction` **itera los chunks secuencialmente** sobre el `reply`/`privateNote`
que ya existen — el puerto NO cambia (evita romper 5 call sites y el in-memory).

**Por qué.** El bloque no pasa por SEC-4 porque es **determinístico**: sale de los hechos de GR
sin intermediación del modelo. Meterlo en el whitelist sería relajar el verificador; anexarlo
después lo deja intacto (0 rechazos por URLs con dígitos, 0 alucinación de montos).

**Descartado.** (a) `reply(conversationId, string[])` — cambia el puerto y esconde el orden;
(b) dejar que el modelo escriba los links — SEC-4 los rechazaría por dígitos, y es exactamente la
superficie de alucinación que queremos cerrar.

**Impacto/riesgo.** Un chunk falla a mitad ⇒ el cliente queda con media respuesta: se atrapa por
chunk, `AssistantRun.outcome:'error'`, `reason:'partial_send'` + nota privada
`🤖 envié N de M mensajes, seguí vos`. **Nunca `safely` mudo.**

## D4 — Guarda "agente activo" (dos señales, ambas determinísticas)

**Decisión.**
1. **Ya respondió un agente**: `readRecentTurns` pasa a devolver
   `AssistantThreadMessage { role, text, generatedByAssistant }`. El motor sigue mapeando a
   `AssistantThreadTurn` para el modelo (el flag NUNCA llega al prompt). Guarda pura nueva en
   `assistantGuards.ts`: `evaluateAgentActivity(thread)` ⇒ `stop('agent_active')` si existe un
   turno `role:'agent'` con `generatedByAssistant:false` **después** del último `customer`.
2. **Asignada a un humano**: `ReplyWithAssistantCommand.assigneeName: string | null`, tomado del
   payload que dispara la corrida (`conversation.meta.assignee`) en `ReceiveChatwootWebhook`.

**Por qué.** (1) usa el hilo que el motor **ya carga**: cero queries, cero puerto nuevo, test puro.
(2) el payload del webhook es la verdad del instante: cero latencia y **cero staleness**.

**Descartado.** Columna espejo `Conversation.assigneeName`: hoy no se procesan
`assignee_changed`/`conversation_updated` (`switch` de 4 eventos verificado), así que el espejo
sólo se escribiría desde `message_created` — misma información que el comando, más una migración y
una columna que puede quedar vieja y aparentar protección. Queda como follow-up si el inbox la
quiere mostrar. Consultar Chatwoot en vivo: descartado por D4/D11 (latencia y un segundo camino).

**Riesgo.** Si el inbound disparador aún no está espejado, "último inbound" es uno anterior y la
guarda calla de más: el error cae del lado seguro (silencio), nunca del lado de hablar encima.

## D5 — Precedencia STOP: pre-chequeo determinístico antes del clasificador

**Decisión.** `AssistantIntent.triggerPatterns String[] @default([])`. Función pura
`matchTriggerIntent(lastCustomerText, intents)` corre **antes** de `runtime.classify`: si matchea
una intent habilitada, se usa ESA y no se consulta al modelo. Regex inválida ⇒ se ignora con warn.

**Por qué.** Cobrarle a alguien sin servicio es el peor modo de falla del change y no puede
depender de que el clasificador acierte. Configurable (no constante de código) porque el operador
va a querer sumar frases sin deploy — el mismo argumento de ADR 0003.

**Descartado.** Confiar sólo en el clasificador (probabilístico); lista hardcodeada (deploy para
cada frase nueva).

**Riesgo.** Patrón demasiado amplio secuestra conversaciones ⇒ por convención de seed **sólo las
intents de STOP llevan patterns**: un falso positivo cuesta un handoff, jamás una respuesta mala.

## D6 — Modo borrador: configuración, no código

Las 4 intents que responden nacen con `actionKey:'private_note'` y `enabledActions` sin
`whatsapp_reply`. El bot redacta, el agente lee la nota y copia. **Soltar** = cambiar `actionKey` a
`whatsapp_reply` desde la UI (y habilitarla en el perfil). Cero código, cero deploy, reversible.
El split (D3) aplica igual a la nota privada.

## D7 — "Estás al día" y comprobantes

`cliente.saldo` sigue siendo la ÚNICA fuente autorizada para afirmar que no hay deuda
(`assistant-balance-guard`: `disponible:true` + `tieneDeuda:false` en ESTA corrida). El resolver de
facturas **nunca** afirma al-día por lista vacía: emite `motivoNoDisponible('facturas_no_disponibles')`
y el `responseGuide` deriva. `recibos_hoy` (GR `action=recibos`) queda **fuera de alcance**:
requiere una llamada GR nueva sin espejo, y el caso "ya pagué" hoy se resuelve con el saldo fresco.

## D8 — `cliente.facturas` sale del ESPEJO, no de una llamada GR nueva

**Decisión.** El resolver (molde `ClienteSaldoResolver`):
1. `RefreshClientBalanceIfStale.execute({grClienteId, lastBalanceAt, status})` — el MISMO
   colaborador (single-flight, TTL por carril) que ya usa `cliente.saldo`;
2. si sigue `balanceStale` ⇒ `motivoNoDisponible('facturas_no_disponibles')` — **nunca** una
   factura vieja;
3. lee el espejo por un puerto **angosto y anclado al cliente**
   `AssistantInvoicesReader.listOpenByClientId(clientId)` (proyección en el SELECT: sin
   `customerName` ni nada de identidad);
4. link "pagar todo junto": columna aditiva `Client.grPaymentUrl`, escrita en la MISMA transacción
   de `updateBalanceAndInvoices` desde `balance.paymentUrls.MercadoPago`.

**Por qué.** `RefreshClientBalanceIfStale` **ya sincroniza `cuentas.invoices[]` del mismo payload**
(verificado: `fetchAndStore` → `mirror.updateBalanceAndInvoices`). Una llamada GR nueva sería un
segundo camino que puede divergir del saldo que el bot cita en el mismo mensaje. `paymentUrls` es
lo único del payload que hoy se descarta: persistirlo cuesta una columna y cero llamadas.

**Descartado.** `BillingRepository.listInvoices` — query admin, paginada, sin filtro por cliente y
arrastra PII; el ancla por cliente debe vivir en el puerto (precedente `PortalPaymentsReader`).

**Riesgo.** El espejo de facturas se reemplaza en bloque sólo con payload autoritativo (guard ya
existente) ⇒ una lista parcial no puede vaciarlo.

---

> **Enmienda 2026-09-04 (D9–D11).** El usuario agregó 5 reglas de negocio después de escritos los
> artefactos. D9 **supersede parcialmente a D7** (los recibos de hoy vuelven al alcance); D10
> generaliza D2; D11 define las intents nuevas y su orden de evaluación. Nada de D1–D6/D8 cambia,
> y **DFT-2 sigue intacto**: `cliente.saldo` sigue siendo la ÚNICA fuente para afirmar "al día".

## D9 — `cliente.recibos_hoy`: llamada GR EN VIVO anclada al cliente (revierte D7)

**Decisión.** Fuente nueva `cliente.recibos_hoy`. Método nuevo en el puerto GR, con el ancla por
cliente **OBLIGATORIA en la firma** (precedente `PortalPaymentsReader`):
`fetchClientReceipts({ grClienteId, fechaDesde, fechaHasta })` → reusa `parseReceiptsResponse` y
postea `action=recibos` + `cliente_id`. Hechos que emite el resolver
(`ClienteRecibosHoyResolver`, molde `ClienteSaldoResolver`):

```ts
{ disponible: boolean, motivo?: 'recibos_no_disponibles',
  recibos: Array<{ hora, recaudador, importe, referencias: string[] }>,   // vigentes de HOY
  matchOperacion: { operacion: string | null, encontrado: boolean, importe?: number },
  posibleDoblePago: boolean }
```

`matchOperacion` y `posibleDoblePago` los calcula **código**, no el modelo, con funciones puras en
`application/`: `extractComprobanteOperacion(filenames)` (`/comprobante[_-]?(\d{6,})\.(pdf|jpe?g|png)$/i`,
mínimo 6 dígitos para no matchear basura), `matchReceiptOperation(op, recibos)` (alguna
`referencias[i]` CONTIENE la secuencia de dígitos — GR las manda como `"MercadoPago: <op>"`) y
`detectDoublePayment(recibos)` (≥2 recibos vigentes de hoy con el MISMO importe, comparado en
centavos, R5 — caso real Bravo Eduardo, 2× $77.997,19 con 2 minutos de diferencia).

**Por qué vuelve al alcance.** D7 lo descartó con "el caso *ya pagué* se resuelve con el saldo
fresco". Es falso para el comprobante: el saldo dice CUÁNTO se debe, no si el archivo que el
cliente acaba de mandar corresponde a un pago **que nos entró**. Sin recibos no se puede distinguir
MercadoPago (imputado solo por IPN) de una transferencia bancaria (imputación manual de
Administración) — y esa distinción es exactamente la decisión que R1 pide automatizar.

**Descartado.** (a) **El espejo `FinancePaymentReceipt`/`FinanceReceiptItem`** (que sí existe y sí
guarda `numeroTransferencia`): lo alimenta `FinanceReceiptIngestScheduler` por delta, con tick de
minutos y kill-switch de config — un pago de hace 2 minutos puede no estar. Un falso "no vemos tu
pago" manda al cliente que SÍ pagó a la cola de Administración: el peor modo de falla de esta
regla. Acá la frescura no es una optimización, es la corrección. (b) `PortalPaymentsReader`: no
proyecta `numeroTransferencia`, que es justo el campo del match. (c) `fetchReceipts` con
`clienteId` opcional: un caller que se olvida el parámetro trae los recibos de TODOS los clientes
— fuga de PII por omisión; el ancla va obligatoria y en una firma propia, y la ingesta global no
se toca.

**Impacto/riesgo.** GR caído ⇒ `disponible:false, motivo:'recibos_no_disponibles'` y el bot **NUNCA**
afirma que no encontró el pago: deriva por `comprobante_transferencia`. Los hechos no llevan
identidad (hora, recaudador, importe, referencias) ⇒ `assertFactsArePiiFree`. La fuente sólo se
resuelve si la intent ganadora la declara en `dataSourceKeys` — cero llamadas GR extra en el resto
de las conversaciones.

## D10 — `labels[]` y `unassign` se aplican en CUALQUIER acción, no sólo en `handoff`

**Decisión.** (1) Campo aditivo `AssistantIntent.unassign Boolean @default(false)`. (2) El motor
aplica `intent.labels[]` y, si `intent.unassign`, `gateway.unassign(conversationId)` **después** de
ejecutar la acción, sea `whatsapp_reply`, `private_note` o `handoff`. (3) Método nuevo en el puerto:
`AssistantConversationGateway.unassign(conversationId): Promise<void>`, best-effort como los labels.

**Por qué el booleano y no "si el label es `administracion`".** Hardcodear el nombre ata el
comportamiento a una string de Chatwoot que el operador puede renombrar desde la UI y romper el
desasignado en silencio; y `soporte` NO debe desasignar. Una columna por fila es editable sin
deploy — mismo argumento de ADR 0003 que D2/D5.

**Por qué generalizar labels/unassign fuera de `handoff`.** R4 pide la única intent que **responde
Y etiqueta Y desasigna**. Modelarla como una acción compuesta `reply_and_handoff` duplicaría el
catálogo por cada combinación (`private_note_and_handoff`, …) y volvería a poner vocabulario en el
código. Etiquetar y asignar son **efectos sobre la conversación**, ortogonales a "qué le dije al
cliente": van al final del pipeline, una sola vez, para cualquier `actionKey`.

**Gotcha verificado (el que puede hundir R3).** `AssignConversation` toca `Conversation.assigneeId`,
que es **campo LOCAL del espejo: nunca llama a Chatwoot** (comentario del propio use case). Pero la
señal `assigneeName` de la guarda D4 sale de `conversation.meta.assignee` del **payload de
Chatwoot**, y los agentes trabajan en Chatwoot (D11 de `ai-assistant-multiagent`). ⇒ `unassign`
DEBE desasignar en LOS DOS lados: `AssignConversation(conversationId, null, actorId:null)` para el
inbox de Prominense **y** `POST /conversations/:id/assignments {assignee_id: 0}` en el gateway de
Chatwoot (hoy `ChatwootGateway` no tiene ningún método de asignación — verificado). Sólo local ⇒ el
agente en Chatwoot la sigue viendo suya y la regla no cumple su fin; sólo Chatwoot ⇒ el inbox local
muestra un dueño fantasma.

**Orden.** Responder/anotar → labels → unassign. Al revés, si el envío falla la conversación queda
huérfana y sin explicación. Cada paso `safely`: un fallo de label o de unassign NUNCA tumba el
mensaje ya enviado (RUN-1).

## D11 — Intents nuevas y orden de evaluación (comprobante ⇒ verificar ⇒ signo ⇒ promesa)

**Decisión.** Tres intents nuevas, más un **selector determinístico post-hechos**. Se agrega
`AssistantIntent.roleKey String?` para que el selector referencie filas por un rol estable
(`comprobante_mp`, `pago_parcial_con_promesa`, `comprobante_transferencia`, `promesa_pago`) y no por
`name`, que el operador puede renombrar desde la UI.

```
0 guardas → 1 pre-chequeo (RTR-4)* → … → 4 hechos (cliente.recibos_hoy, cliente.saldo, cliente.facturas)
                                        → 4b selectComprobanteOutcome(facts, texto) → 5 redactar → 6 SEC-4 → 6b/6c → 7 acción + labels + unassign
```

`*` **Excepción del comprobante:** si el último inbound trae un adjunto `comprobante_<op>.*`, el
pre-chequeo NO deja ganar a `promesa_pago` y fuerza `roleKey:'comprobante_mp'` (la intent que
declara `cliente.recibos_hoy`). Es una regla de CÓDIGO sobre el `filename` del adjunto, no un
`triggerPattern` ⇒ **la restricción de CFG-2 (400 si una intent que no es `handoff` guarda
`triggerPatterns`) queda intacta.**

`selectComprobanteOutcome` (función pura, `application/`) decide con hechos duros:

| Hechos | Resultado |
|---|---|
| `recibos_hoy.disponible:false` **o** `matchOperacion.encontrado:false` | `handoff` → `comprobante_transferencia` (label `administracion`) — R1 |
| match ∧ `debt > 0` ∧ promesa en el texto | `pago_parcial_con_promesa`: responde 1 mensaje + label `administracion` + `unassign` — R4 |
| match ∧ `debt > 0` | `comprobante_mp`: "recibimos tu pago de $X… te quedan $Y en N facturas" — R2 |
| match ∧ `debt ≤ 0` | `comprobante_mp`: "al día" (si `debt < 0`, mencionar el saldo A FAVOR) — R2 |
| `posibleDoblePago:true` | además: el mensaje lo menciona + label `administracion` — R5 |

**Promesa sin comprobante** ⇒ `promesa_pago` (`actionKey:'handoff'`, `labels:['administracion']`,
`unassign:true`, con `triggerPatterns` de "pago mañana / el lunes / la semana que viene / a fin de
mes / cuando cobre / no puedo ahora") — R3. `detectPaymentPromise(texto, patterns)` **reusa los
`triggerPatterns` de la fila `promesa_pago`**: una sola lista configurable, sin columna nueva y sin
relajar la regla de los 400.

**Por qué el selector corre en 4b y no en el clasificador.** Las cuatro ramas las decide un
booleano, un signo y un regex — no hay nada probabilístico que delegarle al modelo, y el peor modo
de falla (decirle "estás al día" a alguien que debe $72.589) no puede depender de que acierte.

**Riesgo.** Si la fila del `roleKey` de destino no existe o está deshabilitada, el selector NO
inventa comportamiento: cae a `handoff` con `necesita-humano` + nota privada explicando el
`roleKey` faltante. Segundo riesgo: `debt` debe ser del MISMO run que el recibo (mismo gate de
frescura que `cliente.saldo`, D8) — un saldo viejo diría "te quedan $Y" incluyendo el pago que el
cliente acaba de hacer.

---

## Diff Prisma (100% aditivo)

```prisma
model AssistantIntent {
  labels          String[] @default([])   // D2 — labels de Chatwoot que aplica `handoff`
  triggerPatterns String[] @default([])   // D5 — pre-chequeo determinístico
}

model Client {
  grPaymentUrl String?                    // D8 — payments_url_saldos.MercadoPago
}

// Migración, idempotente: INSERT INTO "AssistantAction" (key,label,riskLevel)
//   VALUES ('handoff','Derivar a un humano con etiqueta','green') ON CONFLICT (key) DO NOTHING;
//   idem AssistantDataSource ('cliente.facturas','Facturas y links de pago', true)
```

**Enmienda D9–D11 — SEGUNDA migración aditiva** (la de arriba ya está en ejecución en el Lote A;
esta va aparte, en el Lote G, y no la toca):

```prisma
model AssistantIntent {
  unassign Boolean @default(false)   // D10 — desasignar la conversación tras ejecutar la acción
  roleKey  String?                   // D11 — rol estable para el selector determinístico (4b)
}

// INSERT INTO "AssistantDataSource" (key,label,enabled)
//   VALUES ('cliente.recibos_hoy','Recibos de hoy y match de comprobante',true) ON CONFLICT DO NOTHING;
```

`roleKey` es NULLABLE y sin índice único global (dos perfiles pueden tener su propia
`comprobante_mp`); la unicidad que importa es **por perfil** y se valida en la ruta de config, no
con una constraint que obligaría a un backfill.

`ADD COLUMN` con default + `INSERT … ON CONFLICT` ⇒ segura, sin backfill, revertible dejando la
columna.

## Archivos por capa

| Capa | Archivo | Acción |
|---|---|---|
| domain | `entities/assistant.ts` (`labels`, `triggerPatterns`) | Modificar |
| domain | `ports/AssistantThreadReader.ts` (`AssistantThreadMessage`) | Modificar |
| domain | `ports/AssistantInvoicesReader.ts` | **Crear** |
| domain | `ports/ClientMirrorRepository.ts` (`paymentUrl` en params) | Modificar |
| application | `assistant/renderInvoiceBlock.ts`, `assistant/splitForWhatsapp.ts`, `assistant/assistantTriggers.ts` | **Crear** |
| application | `assistant/assistantGuards.ts` (`evaluateAgentActivity`, reason `agent_active`) | Modificar |
| application | `assistant/ReplyWithAssistant.ts` (trigger, guarda, append+split, `handoff`, `partial_send`) | Modificar |
| application | `messaging/ReceiveChatwootWebhook.ts` (`assignee` → comando) | Modificar |
| infra | `adapters/assistant/ClienteFacturasResolver.ts` | **Crear** |
| infra | `adapters/prisma/PrismaAssistantInvoicesReader.ts` | **Crear** |
| infra | `adapters/in-memory/InMemoryAssistantInvoicesReader.ts` | **Crear** |
| infra | `adapters/assistant/assistantMotivoGuia.ts` (`facturas_no_disponibles`) | Modificar |
| infra | `adapters/assistant/ChatMessageThreadReader.ts` (`generatedByAssistant`) | Modificar |
| infra | `adapters/prisma/PrismaClientMirrorRepository.ts` (`grPaymentUrl`) | Modificar |
| infra | `http/composeAssistantEngine.ts` (registro del resolver) | Modificar |
| infra | `http/app.ts` | **Sólo** pasar el reader al compose — nada más (God Object) |
| prisma | `schema.prisma` + 1 migration | Modificar |

### Archivos de la enmienda D9–D11 (Lote G — ninguno pisa Lotes A/B)

| Capa | Archivo | Acción |
|---|---|---|
| domain | `entities/assistant.ts` (`unassign`, `roleKey`) | Modificar |
| domain | `ports/GestionRealPort.ts` (`fetchClientReceipts` + `FetchClientReceiptsParams`) | Modificar |
| domain | `ports/AssistantConversationGateway.ts` (`unassign`) | Modificar |
| domain | `ports/AssistantThreadReader.ts` (`attachmentFilenames: string[]` en `AssistantThreadMessage`) | Modificar *(tras 2.2)* |
| application | `assistant/comprobantes.ts` (`extractComprobanteOperacion`, `matchReceiptOperation`, `detectDoublePayment`, `detectPaymentPromise`) | **Crear** |
| application | `assistant/selectComprobanteOutcome.ts` (selector 4b, D11) | **Crear** |
| application | `assistant/renderBalanceSignMessage.ts` (R2 — signo del saldo) | **Crear** |
| application | `assistant/ReplyWithAssistant.ts` (excepción del pre-chequeo, 4b, labels/unassign en cualquier acción) | Modificar *(tras Lote E)* |
| infra | `adapters/assistant/ClienteRecibosHoyResolver.ts` | **Crear** |
| infra | `adapters/gestion-real/GestionRealClient.ts` (`fetchClientReceipts`) | Modificar |
| infra | `adapters/in-memory/InMemoryGestionRealPort.ts` (`fetchClientReceipts`) | Modificar |
| infra | `adapters/assistant/ChatwootAssistantConversationGateway.ts` (`unassign` → `AssignConversation(null)` + Chatwoot) | Modificar |
| infra | `adapters/chatwoot/…` `ChatwootGateway.unassignConversation` | Modificar |
| infra | `adapters/assistant/ChatMessageThreadReader.ts` (filenames de adjuntos) | Modificar *(tras 4.6)* |
| infra | `adapters/assistant/assistantMotivoGuia.ts` (`recibos_no_disponibles`) | Modificar |
| infra | `http/composeAssistantEngine.ts` (registro de `cliente.recibos_hoy`) | Modificar |
| prisma | `schema.prisma` + **2da** migration (`unassign`, `roleKey`, data source) | Modificar |

## Estrategia de tests (Strict TDD — test primero)

| Nivel | Qué | Cómo |
|---|---|---|
| Puro | split (≥6 facturas, URL indivisible, cap 1.400, numeración dentro del cap), render, triggers, `evaluateAgentActivity` | Jest, sin mocks |
| Use case | STOP gana a cobranza; `handoff` aplica labels+nota y NO responde; `agent_active` ⇒ noop; bloque anexado sin pasar por SEC-4; `partial_send` deja rastro | `ReplyWithAssistant.test.ts` con dobles in-memory |
| Adapter | resolver: stale ⇒ `facturas_no_disponibles`; lista vacía ⇒ no afirma al-día; proyección sin PII (`assertFactsArePiiFree`) | in-memory reader + `RefreshClientBalanceIfStale` |
| Composición | `cliente.facturas` registrado y catálogo habilitado; misma instancia de refresh que `cliente.saldo` | `assistant-composition.test.ts` (pinea contra el bug W6) |
| Puro (D9–D11) | `extractComprobanteOperacion` (nombre válido / `<6` dígitos / otra extensión), `matchReceiptOperation` (op contenida en `"MercadoPago: <op>"`, no matchea por prefijo corto), `detectDoublePayment` (2 iguales ⇒ true; 2 distintos ⇒ false; comparación en centavos), `detectPaymentPromise`, `selectComprobanteOutcome` (las 5 filas de la tabla D11), `renderBalanceSignMessage` (debt>0 / =0 / <0) | Jest, sin mocks — casos reales del 04-09 (Vargas, Moreyra, Bravo) |
| Use case (D9–D11) | adjunto `comprobante_*` gana al pre-chequeo de `promesa_pago`; `promesa_pago` sin adjunto ⇒ handoff + `administracion` + unassign; `pago_parcial_con_promesa` responde Y etiqueta Y desasigna; unassign corre DESPUÉS del envío y su fallo no tumba el mensaje; `roleKey` faltante ⇒ `necesita-humano` + nota | `ReplyWithAssistant.test.ts` con dobles in-memory |
| Adapter (D9–D11) | resolver: GR caído ⇒ `recibos_no_disponibles` (nunca "no encontramos tu pago"); anulados excluidos; hechos sin PII; `fetchClientReceipts` manda `cliente_id` y fechas `DD-MM-AAAA`; `unassign` desasigna en el espejo Y en Chatwoot | in-memory GR port + `assertFactsArePiiFree` |

## Preguntas abiertas

- [ ] Número equivocado / auto-respondedor: intent con `handoff` silencioso (sin label de área) vs.
      `resolve_conversation`. Recomendación: `handoff`; cerrar una conversación viva es `red`.
- [ ] Copy exacto del bloque ("Detalle por factura (cada link paga solo esa)" / "Para pagar todo
      junto" / aclaración de alias) — lo fija el usuario antes de `sdd-apply`.
- [ ] (D11) Copy exacto de los 4 mensajes nuevos: pago verificado con deuda restante (R2), al día /
      saldo a favor (R2), acuse de pago parcial con promesa (R4) y aviso de doble pago (R5).
- [ ] (D9) Ventana de `cliente.recibos_hoy`: ¿estrictamente HOY (`fecha_desde = fecha_hasta = hoy`)
      o HOY−1 para el pago hecho a las 23:55? Recomendación: HOY−1, y filtrar por
      `fecha_confirmacion`/hora al armar los hechos — un comprobante de anoche no debería mandarse
      a Administración.
- [ ] (D10) ¿Con qué `actorId` queda registrado el `ConversationEvent` de `unassigned` del bot?
      Hoy `AssignConversation` acepta `actorId` opcional; `null` deja el evento sin autor. Confirmar
      si conviene un usuario técnico del asistente.

---

## D12 — Enmienda del FIX WAVE (2026-09-05, post verificación adversarial)

> La verificación adversarial devolvió **FIX FIRST**: 5 CRITICAL y 10 WARNING. Lo que sigue no
> agrega alcance — corrige decisiones de D9–D11 que la implementación dejó mal cerradas o que la
> verificación mostró incompletas. **Cinco de las reglas MUST del change estaban implementadas en
> funciones puras con test verde pero INERTES en el camino real** ("feature sin perilla",
> aplicado a ramas de código).

### D12.1 — La excepción del comprobante es ACOTADA (corrige C1)

El pre-chequeo evalúa **primero** `matchTriggerIntent` (los STOP) y sólo después deja que un
adjunto `comprobante_<op>.*` sobrescriba la intención — **únicamente si la ganadora es
`promesa_pago`**. La implementación previa dejaba que el adjunto desactivara TODOS los
`triggerPatterns`: "ya pagué, te paso el comprobante, pero hace 3 días que no tengo internet" +
un PDF terminaba en un acuse de cobranza, sin `soporte` y sin `necesita-humano`. D11 siempre dijo
"le gana a `promesa_pago`"; el orden de dos guardas en el mismo `if` chain fue donde se perdió la
precedencia.

### D12.2 — SEC-6 es una VENTANA, no un ordenamiento de turnos (corrige W1/W2)

`AssistantThreadMessage` gana `at` (ISO, del `createdAt` del espejo) y
`evaluateAgentActivity(thread, {now, windowMinutes})` frena si existe **cualquier** turno de
agente humano dentro de la ventana (default **60 min**, env `ASSISTANT_AGENT_ACTIVE_WINDOW_MIN`,
opcional, sin fail-fast). El orden no protegía: si el agente contestaba y el cliente volvía a
escribir, el índice del "último customer" se corría y la guarda pasaba.

Dos ausencias, las dos **fail-closed**: un turno de agente humano **sin `at`** cuenta como activo;
un payload **sin `conversation.meta.assignee`** (`undefined`, distinto de `assignee: null`) se
trata como ASIGNADO y se loguea.

**Forma real del payload, VERIFICADA (N4).** Chatwoot v4.13 arma el webhook en
`app/presenters/conversations/event_data_presenter.rb#push_meta` como
`{ sender, assignee: assigned_entity&.push_event_data, assignee_type, team, hmac_verified }`: una
conversación sin asignar llega con `assignee: null` **y la clave presente**, así que el mapeo de
arriba NO deja al bot inerte. (La vista jbuilder de la REST API sí omite la clave; el motor no la
consume.) Hay un test con esa forma exacta para que nadie lo "arregle" al revés. Y `assignee_type`
puede ser `'AgentBot'` — un bot asignado NO es un humano atendiendo: si contara, el asistente se
auto-silenciaría en cuanto Chatwoot le asignara la conversación. Callarse de más es recuperable; interrumpir a una persona frente
a un cliente, no.

### D12.3 — Hechos INTERNOS (`_`) para el crédito (corrige C4, preserva FW2-1)

`ClienteSaldoResolver` sigue emitiendo `saldo: 0` para todo `balanceDue <= 0` (FW2-1), y agrega
`_aFavor` (positivo) cuando hay crédito. **Convención nueva: una clave de hecho que arranca con
`_` no llega ni al prompt ni al whitelist de SEC-4** — `toPublicFacts` la filtra, y desde la
enmienda N3 también **dentro de los arrays** (un `_` en `cliente.facturas.facturas[i]` se
filtraba tal cual: hoy no hay fuga viva, pero un invariante que dice "NUNCA" no puede depender de
que nadie lo intente). Sólo la consume
el renderizado determinístico, que se anexa después del verificador. Sin esto, la rama "saldo a
favor" de RSP-1 era inalcanzable: el motor nunca podía ver un `debt < 0`.

### D12.4 — Verificador de FRASE, hermano de SEC-4 (corrige C5; corregido por N2)

`contradictsBalanceState(text, debt)`: con `debt > 0`, un texto que afirme "al día" / "no tenés
deuda" se DESCARTA; con `debt <= 0`, uno que AFIRME una deuda también. Queda sólo el bloque
determinístico; si no hay bloque, `handoff` con `reason='contradicts_balance'`.

> **Enmienda N2 (re-verificación).** La primera versión usaba `/deb[eé]s|pendiente|vencid/` contra
> `debt <= 0` y descartaba la respuesta CANÓNICA del cliente al día — *"No tenés facturas
> pendientes, estás al día"* — mandando a un humano el carril de ~2.300 clientes sin deuda que la
> fix wave F1 peleó por conservar. **La dirección del regex no alcanza: hay que mirar la POLARIDAD
> de la oración.** Hoy el guard borra primero las cláusulas negadas (cortando en `,`/`;`/`.`, para
> que una negación no tape una afirmación posterior) y recién después busca afirmaciones. Simétrico
> en la otra dirección: "todavía no estás al día" con deuda es verdad y se envía. La función tiene
> archivo de test propio (`assistantPhraseGuard.test.ts`, 20 casos): la regresión existió porque se
> testeaba sólo end-to-end, con 3 frases elegidas a mano, ninguna de ellas la respuesta correcta del
> caso más común.
SEC-4 sólo mira números y "Estás al día, no tenés facturas pendientes" no tiene un dígito: pasaba
entero, y encima se concatenaba con el bloque que decía lo contrario dos renglones abajo.

### D12.5 — `comprobante_transferencia` responde (decisión del dueño, 2026-09-05)

**Regla 4 de D9–D11 vs. INT-1: gana el dueño.** El handoff mudo dejaba al cliente sin ninguna
señal. Ahora, además de derivar (label `administracion` + `unassign` + nota privada), se envía un
acuse DETERMINÍSTICO (`renderTransferAcknowledgement`, escrito por código como todo lo que
menciona plata).

> **Enmienda N1 (re-verificación, 2026-09-05).** La redacción original afirmaba el MEDIO de pago
> ("transferencia … como fue por transferencia, no por link") y daba el saldo como final. Las dos
> cosas son falsas en el caso normal: a esta rama se llega por `selectComprobanteOutcome` fila 1
> —"sin match en los recibos de HOY"—, que cubre el pago por LINK que GR todavía no ingestó y
> (desde D12.7) **todo** pago de ayer. Le decíamos "vos transferiste" a quien pagó por link
> —justo la distinción que la regla 4 pide respetar— y presentábamos como deuda final un número
> que todavía incluye el pago que el cliente acaba de mostrar. Dos fixes correctos por separado
> mintiendo juntos: D12.7 mandó los pagos de ayer a esta rama cuando estaba MUDA, y D12.5 la hizo
> hablar sin releer aquel tradeoff.

Redacción vigente:

> Recibimos tu comprobante{, operación N}. Todavía no lo vemos impactado en el sistema:
> administración lo revisa e imputa a mano y en cuanto quede aplicado te confirmamos por acá.
> {Tu saldo a hoy, sin contar este pago, es $X. | Tu cuenta a hoy, sin contar este pago, ya
> figura al día[, con un saldo a favor de $Y].} ¡Gracias! — IPNEXT Cobranzas

Ni el medio ni el importe del pago se afirman (no se conocen), y el saldo va SIEMPRE calificado
como pre-imputación. Tres gates antes de hablar: `whatsapp_reply` habilitada en el perfil
(ACT-1/DFT-1), ventana de 24 h (SEC-3) y `safely` (un fallo del envío no puede tapar la nota ni
el label). El saldo sólo se menciona si `cliente.saldo` está disponible (DFT-2).

### D12.6 — Efectos de conversación en TODO handoff (corrige W3/W7)

`markNeedsHuman` aplica los `labels[]` y el `unassign` de la intent en **todos** sus caminos
(`out_of_scope`, `action_not_enabled`, `outside_reply_window`, `classifier/generator_unavailable`,
`rejected_numbers`, `missing_role_key`, `contradicts_balance`) — ACT-3 habla de CUALQUIER acción,
y una conversación con `necesita-humano` pero sin label de área y asignada al bot es invisible
para la cola que tenía que atenderla. `partial_send` deja `necesita-humano`, nunca `bot-respondió`:
media respuesta no es una respuesta.

### D12.7 — Fechas y conteos que no se inventan (corrige C3/W5/S2/W9)

- "en N facturas" sólo se dice con N **conocido** (`cliente.facturas.disponible`); si no, la
  cláusula se omite. Antes: "te quedan $72.589,41 pendientes en 0 facturas".
- `ReceiptFact` lleva `fecha` y `esDeAyer`. La ventana de consulta sigue siendo HOY−1 (D9), pero
  `matchOperacion` y `posibleDoblePago` se evalúan **sólo sobre los de HOY** — el mismo abono de
  ayer y de hoy disparaba un falso "pagaste dos veces". Los de ayer viajan como contexto fechado.
  *Tradeoff aceptado*: un comprobante de las 23:55 de anoche cae por `comprobante_transferencia`
  ⇒ acuse (D12.5) + Administración, en vez de verificación automática. Nunca "no vemos tu pago".
  **Enmienda N1**: por eso el acuse de D12.5 NO puede afirmar el medio de pago — el pago de ayer
  bien puede haber sido por link de MercadoPago. Si alguna vez se revierte esta ventana, releer
  D12.5 antes: es la decisión que depende de ésta.
- Sin importe de GR no se renderiza "$0,00": se reconoce el pago sin cifra.
- `invoiceBlockFrom` **pasa** el alias (`cliente.facturas.aliasPago`, de `ASSISTANT_PAY_ALIAS`) ⇒
  la aclaración de REN-1 deja de ser código muerto y se completa: "titular IPNEXT S.A., CUIT
  30-70849985-0. **Si ves otro dato, no transfieras**".

### D12.8 — `splitForWhatsapp` no cuelga ni se pasa del cap (corrige C2/W4/S1)

Una URL más larga que el cap devolvía un punto de corte `0`: chunk vacío, `rest` que no encoge,
**loop infinito síncrono en el camino del webhook** — colgaba el event loop de todo el backend.
Ahora el corte siempre avanza (`cut <= 0 ⇒ cut = cap`: partir una URL es el mal menor frente a
colgar el proceso) y el ancho del prefijo `(i/N)` se itera hasta estabilizarse, así que ningún
chunk supera el cap al cruzar de 9 a 10 trozos.
