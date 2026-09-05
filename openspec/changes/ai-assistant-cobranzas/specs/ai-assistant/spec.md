# Delta for `ai-assistant`

Contra `openspec/changes/ai-assistant-multiagent/specs/ai-assistant/spec.md` (capability NO
archivada — `sdd-archive` la mergeará a `openspec/specs/ai-assistant/spec.md` junto con este delta
cuando ambos changes se cierren).

> **Enmienda 2026-09-04** — ACT-3 pasa de ADDED a MODIFIED (los efectos sobre la conversación
> —labels y desasignación— dejan de ser exclusivos de `handoff`) y se agrega ACT-4. RTR-4, SEC-6,
> OBS-3, CFG-2, SEC-4 y OBS-2 no cambian salvo lo indicado.

## ADDED Requirements

### Requirement: ACT-3 — `handoff` (`green`) y los EFECTOS sobre la conversación

MUST existir `AssistantAction('handoff', riskLevel:'green')`. `executeAction('handoff')` MUST dejar
una nota privada `🤖 STOP: <motivo>` y MUST NOT enviar ninguna respuesta al cliente.

Los **efectos sobre la conversación** —`intent.labels[]` (configurable, D2) y `intent.unassign`
(booleano por fila, D10)— MUST aplicarse para CUALQUIER `actionKey` (`whatsapp_reply`,
`private_note` o `handoff`), no sólo para `handoff`: etiquetar y soltar la conversación es
ortogonal a qué se le dijo al cliente. En `handoff` se aplica además
`ASSISTANT_LABEL_NEEDS_HUMAN`. El motor MUST NOT derivar el desasignado del NOMBRE de un label
(p.ej. "si el label es `administracion`"): la autoridad es el campo `unassign` de la fila. El orden
MUST ser: acción → labels → `unassign`. Todo esto es best-effort (`safely`): un label mal tipeado o
un fallo de desasignación MUST NOT impedir la nota privada, `necesita-humano` ni la respuesta ya
enviada.

*(Enmienda 2026-09-04: originalmente los labels se aplicaban SÓLO en `handoff` y no existía
`unassign`.)*

#### Scenario: intención de reclamo dispara handoff
- GIVEN la intención ganadora es `reclamo_servicio` con `actionKey:'handoff'` y `labels:['soporte']`
- WHEN `executeAction` corre
- THEN se aplican los labels `soporte` y `necesita-humano`, se deja la nota privada con el motivo,
  y NO se envía nada por WhatsApp

#### Scenario: label inválido no bloquea el resto del handoff
- GIVEN `intent.labels` incluye un label que Chatwoot no acepta
- WHEN `executeAction('handoff')` corre
- THEN `necesita-humano` y la nota privada se aplican igual; el fallo del label queda logueado,
  nunca lanzado

#### Scenario: el handoff por una guarda interna también etiqueta y desasigna
- GIVEN una intent con `labels:['administracion']` y `unassign:true`
- WHEN el motor deriva por una guarda interna (fuera de la ventana de 24 h, acción no habilitada,
  cifras sin respaldo, texto que contradice el saldo, clasificador o generador caídos, `roleKey`
  faltante) en vez de por la acción `handoff`
- THEN además de `necesita-humano` se aplican los `labels[]` de la intent y se desasigna la
  conversación

#### Scenario: envío parcial no se etiqueta como respondido
- GIVEN el mensaje se partió en N chunks y falla uno del medio
- WHEN el motor registra `AssistantRun.reason='partial_send'`
- THEN la conversación queda con `necesita-humano` y NUNCA con `bot-respondió`

#### Scenario: una intent que RESPONDE también etiqueta y desasigna
- GIVEN una intent con `actionKey:'whatsapp_reply'`, `labels:['administracion']` y `unassign:true`
- WHEN `executeAction` corre
- THEN el cliente recibe la respuesta, la conversación queda etiquetada `administracion` y sin
  asignar — responder NO la saca de la cola

#### Scenario: el desasignado no depende del nombre del label
- GIVEN una intent con `labels:['administracion']` y `unassign:false`
- WHEN `executeAction` corre
- THEN la conversación se etiqueta pero NO se desasigna

### Requirement: ACT-4 — `unassign` en el gateway de la conversación

MUST existir `AssistantConversationGateway.unassign(conversationId): Promise<void>`. La
implementación MUST desasignar en LOS DOS lados donde vive la asignación: el espejo local
(`Conversation.assigneeId`, delegando en el use case humano `AssignConversation` con `assigneeId:
null` — nunca por un camino de escritura propio) **y** Chatwoot (`POST
/conversations/:id/assignments {assignee_id: 0}`), porque los agentes trabajan en Chatwoot y la
guarda SEC-6 lee la asignación del payload de Chatwoot. Desasignar sólo en uno de los dos MUST
considerarse incumplimiento. El método MUST ser best-effort (`safely`): su fallo NUNCA tumba una
respuesta ya enviada ni la nota privada, y MUST quedar logueado.

#### Scenario: la conversación vuelve a la cola en ambos lados
- GIVEN una conversación asignada a un agente, con una intent `unassign:true`
- WHEN el motor termina de ejecutar la acción
- THEN `Conversation.assigneeId` queda en `null` Y la conversación queda sin asignar en Chatwoot

#### Scenario: el unassign falla después de responder
- GIVEN la respuesta al cliente ya salió y la llamada de desasignación falla
- WHEN termina la corrida
- THEN el motor no lanza, el resultado sigue siendo `replied` y el fallo queda logueado

#### Scenario: orden — primero hablar, después soltar
- GIVEN una intent que responde y además desasigna
- WHEN corre `executeAction`
- THEN el `unassign` se ejecuta DESPUÉS del envío y de los labels, nunca antes

### Requirement: RTR-4 — pre-chequeo determinístico de `triggerPatterns` antes del clasificador

Antes de `runtime.classify`, una función pura `matchTriggerIntent(lastCustomerText, intents)` MUST
evaluar el ÚLTIMO mensaje inbound del cliente contra `triggerPatterns[]` de las intents habilitadas
con `actionKey:'handoff'`. Si matchea, esa intent se usa SIN consultar al modelo. Un patrón que no
compila como regex MUST ignorarse con warning, nunca romper la corrida. Si el mensaje mezcla
cobranza y una frase de STOP, el pre-chequeo MUST ganar sobre cualquier clasificación posterior.

#### Scenario: reclamo de servicio fuerza STOP sin invocar al modelo
- GIVEN el último inbound es "ya pagué y no tengo internet"
- AND `reclamo_servicio` tiene un `triggerPattern` que matchea "no tengo internet"
- WHEN corre el pre-chequeo
- THEN se usa `reclamo_servicio` sin invocar al clasificador; `AssistantRun.reason='trigger_pattern'`

#### Scenario: regex inválida no rompe la corrida
- GIVEN una intent con un `triggerPattern` que no compila
- WHEN corre el pre-chequeo
- THEN esa entrada se ignora con warning y las demás patterns se evalúan igual

### Requirement: SEC-6 — guarda "agente activo": no responder encima de un humano

El motor MUST NOT responder si, al evaluar, (a) `readRecentTurns` incluye CUALQUIER turno con
`role:'agent'` y `generatedByAssistant:false` cuyo `at` caiga dentro de la VENTANA de actividad
(configurable, default 60 minutos), sin importar el orden de los turnos; o (b) el comando trae
`assigneeName` no vacío (tomado de `conversation.meta.assignee` en el payload del webhook que
disparó la corrida). `generatedByAssistant` MUST NOT llegar al prompt del modelo — sólo se usa en
la guarda pura `evaluateAgentActivity(thread, options)`. Cualquiera de las dos señales MUST
producir `AssistantRun.reason='agent_active'`, nunca un fallo silencioso indistinguible de "no
matcheó nada".

Las dos ausencias de dato MUST resolverse del lado CAUTO: un turno de agente humano **sin `at`**
MUST contar como activo, y un `assigneeName` **ausente** (`undefined` — el payload no trae el
campo, distinto de `null` explícito) MUST tratarse como ASIGNADO y registrarse con un warning.

#### Scenario: un agente humano ya respondió después del último inbound
- GIVEN el hilo tiene un turno outbound `role:'agent'`, `generatedByAssistant:false`, posterior al
  último turno `customer`
- WHEN se evalúa la guarda
- THEN el motor no responde y `AssistantRun.reason='agent_active'`

#### Scenario: el agente respondió ANTES del último inbound pero hace 2 minutos
- GIVEN un turno de agente humano con `at` de hace 2 minutos y, DESPUÉS, un mensaje nuevo del
  cliente
- WHEN se evalúa la guarda con la ventana por defecto (60 min)
- THEN el motor no responde y `AssistantRun.reason='agent_active'`

#### Scenario: el agente respondió hace 3 horas
- GIVEN un turno de agente humano con `at` de hace 3 horas y ningún otro turno humano reciente
- WHEN se evalúa la guarda con la ventana por defecto
- THEN la corrida continúa normalmente

#### Scenario: turno de agente humano sin timestamp
- GIVEN un turno `role:'agent'`, `generatedByAssistant:false` y sin `at`
- WHEN se evalúa la guarda
- THEN el motor no responde (fail-closed) y `AssistantRun.reason='agent_active'`

#### Scenario: el payload no trae `assignee`
- GIVEN `ReplyWithAssistantCommand.assigneeName` es `undefined` (el webhook no encontró
  `conversation.meta.assignee`)
- WHEN se evalúa la guarda
- THEN el motor no responde, se registra un warning y `AssistantRun.reason='agent_active'`

#### Scenario: agente respondió DESPUÉS del inbound que dispara esta corrida — noop
- GIVEN llega un inbound nuevo del cliente y, tras él, ya hay un turno de agente humano no generado
  por el asistente
- WHEN corre la evaluación disparada por ese inbound
- THEN el resultado es noop con `reason='agent_active'`, sin enviar nada al cliente

#### Scenario: conversación asignada a un humano
- GIVEN `ReplyWithAssistantCommand.assigneeName` no vacío
- WHEN se evalúa la guarda
- THEN el motor no responde y `AssistantRun.reason='agent_active'`

#### Scenario: sin señales de actividad humana, la guarda no frena la corrida
- GIVEN no hay turno de agente no-bot dentro de la ventana, y `assigneeName` es `null` explícito
- WHEN se evalúa la guarda
- THEN la corrida continúa normalmente

### Requirement: OBS-3 — el audit registra los motivos nuevos de este change, sin PII

`AssistantRun.reason` MUST poder tomar, cuando aplique, los valores `agent_active` (SEC-6),
`trigger_pattern` (RTR-4) y `partial_send` (falla de un chunk del split a mitad de envío). Ninguno
de estos valores MUST contener texto del cliente ni PII — son identificadores fijos, no mensajes.

#### Scenario: los tres motivos nuevos quedan auditados sin contenido del cliente
- GIVEN cualquiera de los tres caminos nuevos (guarda de agente activo, trigger pattern, envío
  parcial)
- WHEN se cierra la corrida
- THEN `AssistantRun.reason` toma el valor correspondiente y no contiene texto del cliente

## MODIFIED Requirements

### Requirement: CFG-2 — las intenciones son FILAS, no vocabulario en código

MUST existir `AssistantIntent` (N por perfil) con `name`, `description`, `examples[]`, `enabled`,
`dataSourceKeys[]`, `responseGuide`, `actionKey`, `labels String[] @default([])` (etiquetas de
Chatwoot que la intent aplica, ACT-3), `triggerPatterns String[] @default([])` (pre-chequeo
determinístico, RTR-4), `unassign Boolean @default(false)` (desasignar tras ejecutar la acción,
ACT-4) y `roleKey String?` (rol estable para los selectores determinísticos; el operador puede
renombrar `name` sin romperlos, y MUST ser único POR PERFIL, validado en la ruta de config). El
motor MUST NOT contener ninguna intención hardcodeada:
agregar, editar, deshabilitar o borrar comportamiento MUST ser posible **sin deploy**, vía las
rutas CRUD de configuración. Guardar `triggerPatterns` no vacío en una intent cuyo `actionKey` NO
sea `handoff` MUST rechazarse con 400 — sólo las intents de STOP llevan pre-chequeo.

(Previously: sólo declaraba `name/description/examples/enabled/dataSourceKeys/responseGuide/actionKey`,
sin `labels`, `triggerPatterns`, `unassign` ni `roleKey`, y sin la restricción de 400.)

#### Scenario: alta de intención sin deploy
- GIVEN un perfil habilitado con 3 intenciones
- WHEN se crea una 4ta intención vía API con `enabled:true`
- THEN la siguiente invocación del motor la considera en la clasificación, sin reiniciar el proceso

#### Scenario: apagar una intención la saca del juego
- GIVEN una intención con `enabled:false`
- WHEN llega un mensaje que la matchearía
- THEN el clasificador NO la considera candidata y el resultado es handoff (si no matchea otra)

#### Scenario: `triggerPatterns` en una intent que no es `handoff` se rechaza
- GIVEN una intent con `actionKey:'private_note'`
- WHEN se intenta guardarla con `triggerPatterns:['algún patrón']`
- THEN la API responde 400 y no persiste

#### Scenario: `roleKey` duplicado dentro del mismo perfil se rechaza
- GIVEN un perfil que ya tiene una intent con `roleKey:'comprobante_mp'`
- WHEN se intenta crear otra intent del MISMO perfil con ese `roleKey`
- THEN la API responde 400 y no persiste; el mismo `roleKey` en OTRO perfil sí se acepta

### Requirement: SEC-4 — los números salen de la DB, el modelo sólo redacta

Todo dato duro (saldo, fecha, estado, cantidad) MUST viajar al modelo como hecho ya resuelto por el
backend. El motor MUST NOT aceptar como válido un número presente en la salida del modelo que no
provenga del contexto inyectado. Esta verificación corre EXCLUSIVAMENTE sobre `generated.text` (lo
que escribió el modelo). Un bloque determinístico anexado DESPUÉS de esta verificación por código
de aplicación (p.ej. `renderInvoiceBlock`, que nunca pasa por el modelo) MUST NOT someterse a este
verificador — no hay alucinación posible en texto que el modelo nunca vio ni escribió.

(Previously: no distinguía explícitamente el alcance de la verificación de "la salida" en general
de `generated.text` en particular; no existía el concepto de bloque determinístico anexado.)

#### Scenario: el modelo altera un monto y se descarta
- GIVEN el contexto inyecta `saldo: 45000`
- AND el modelo devuelve un texto que menciona `54000`
- THEN la salida se descarta y se hace handoff (o se re-pide), NUNCA se envía

#### Scenario: un bloque determinístico con montos y links reales no se rechaza
- GIVEN `generated.text` del modelo pasó SEC-4 limpio (sin montos)
- AND se le anexa el bloque de facturas con montos y `paymentUrl` reales, después de la verificación
- WHEN se arma el mensaje final
- THEN el bloque no se evalúa contra el whitelist de números y no dispara ningún rechazo

### Requirement: OBS-2 — el humano distingue qué escribió el agente, EN CHATWOOT

Toda intervención del agente MUST dejar rastro VISIBLE EN CHATWOOT, que es donde trabajan los
agentes humanos:

- respondió ⇒ label `bot-respondió`
- no pudo / fuera de alcance / cifra descartada / fallo interno ⇒ label `necesita-humano` **y**
  nota privada con el motivo
- ejecutó `handoff` (STOP por intención de cobranza) ⇒ la UNIÓN de `intent.labels[]` +
  `necesita-humano`, y nota privada `🤖 STOP: <motivo>` (ACT-3)

El rastro MUST ser best-effort: si Chatwoot falla después de que la respuesta salió, el motor NO
se rompe (RUN-1).

(Previously: sólo contemplaba el label fijo `necesita-humano` para "no pudo"; no distinguía labels
adicionales por intención en un STOP de `handoff`.)

#### Scenario: el agente respondió
- GIVEN el agente respondió en una conversación
- THEN la conversación queda etiquetada `bot-respondió` en Chatwoot

#### Scenario: el agente NO pudo — el humano se entera
- GIVEN cualquier camino que termine sin responder (fuera de alcance, acción no habilitada, fuera
  de ventana, el modelo se declaró incapaz, SEC-4 descartó la salida, fallo interno)
- THEN la conversación queda etiquetada `necesita-humano` y con una nota privada que explica por qué
- AND NO se le envía nada al cliente

#### Scenario: STOP de cobranza deja el label de área además de `necesita-humano`
- GIVEN la intención ganadora es `comprobante_transferencia` con `labels:['administracion']` y
  `actionKey:'handoff'`
- WHEN `executeAction` corre
- THEN la conversación queda etiquetada `administracion` Y `necesita-humano`, con nota privada
  `🤖 STOP: <motivo>`

#### Scenario: Chatwoot caído al dejar el rastro
- GIVEN la respuesta al cliente ya salió y el label falla
- THEN el motor devuelve `replied` igual y no lanza
