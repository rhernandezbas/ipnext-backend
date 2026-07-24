# Spec delta BE — messaging-task-stage-config (change bulk-task-stage-transition)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify). Delta ADITIVO sobre la capability
`messaging-task-stage-config` (change `bulk-task-recipients`, en prod): agrega el **estado resultante ÚNICO GLOBAL** al que
transicionan las tareas cuando el bulk las envía. NO modifica los requirements TSC-1..TSC-4 (el set de stages elegibles
sigue igual); agrega TTC-1..TTC-4.

---

## ADDED Requirements

### Requirement: TTC-1 — config singleton `resultingStageId` (un solo destino global)

El estado resultante MUST ser **uno solo** para toda la config (decisión de producto 5 — NO una matriz A→B por estado).
El schema MUST agregar un singleton `WhatsappTaskStageTransitionConfig { id (singleton), resultingStageId String?,
resultingStage Stage? @relation(fields:[resultingStageId], references:[id], onDelete: SetNull), updatedAt }` — molde
`NocBroadcastConfig`. `resultingStageId` nullable MUST significar "sin transición" (el bulk task sigue funcionando como
filtro puro, comportamiento actual). La migración MUST ser aditiva (CERO cambio en `WhatsappTaskStageRecipientConfig`,
`Campaign`, `CampaignRecipient`).

#### Scenario: sin config → sin transición (default)
- GIVEN un sistema recién migrado (nunca se seteó un estado resultante)
- WHEN se lee la config de transición
- THEN `resultingStageId` es `null` — ninguna tarea transiciona al enviar

#### Scenario: borrar el Stage destino limpia el destino (SetNull), no cae la config
- GIVEN un `resultingStageId` seteado a un Stage
- WHEN ese Stage se borra (`DELETE` vía `workflows.routes`, gate `scheduling.manage`)
- THEN `resultingStageId` queda `null` automáticamente (SetNull) — la config sobrevive, las campañas futuras no transicionan

### Requirement: TTC-2 — port `getResultingStageId` / `setResultingStageId`

El domain port MUST exponer `getResultingStageId(): Promise<string | null>` y
`getResultingStage(): Promise<MappedStage | null>` (hidratado `stageId, name, code, color, workflowId, workflowName` para
la card) y `setResultingStageId(stageId: string | null): Promise<void>` con semántica REPLACE (el resultado es EXACTAMENTE
el valor recibido). Adapter Prisma + in-memory MUST cumplir el mismo contrato.

#### Scenario: set reemplaza el valor previo
- GIVEN `resultingStageId = 'sA'`
- WHEN `setResultingStageId('sB')`
- THEN el nuevo valor es `'sB'` — `'sA'` queda desplazado

#### Scenario: set con `null` limpia el destino
- GIVEN `resultingStageId = 'sA'`
- WHEN `setResultingStageId(null)`
- THEN `resultingStageId` queda `null` — válido, no error (des-configurar la transición)

### Requirement: TTC-3 — `send_to_iclass` PROHIBIDO como destino (fail-loud al guardar)

`setResultingStageId` (y su use case/endpoint) MUST rechazar un `stageId` cuyo `Stage.code === 'send_to_iclass'` con un
error tipado (`ResultingStageNotAllowedError` / `RESULTING_STAGE_NOT_ALLOWED`) → 422, ANTES de persistir (decisión de
producto 7 — evitar creación masiva de OS en IClass). El valor previo NO cambia.

#### Scenario: intentar mapear `send_to_iclass` → rechazado, config sin cambios
- GIVEN un Stage `sX` con `code = 'send_to_iclass'`, config con `resultingStageId = 'sA'`
- WHEN `setResultingStageId('sX')`
- THEN 422 `RESULTING_STAGE_NOT_ALLOWED`, `resultingStageId` sigue en `'sA'`

#### Scenario: `stageId` inexistente → rechazado, nada se aplica
- GIVEN body con un `stageId` que no corresponde a ningún `Stage`
- WHEN `setResultingStageId`
- THEN error tipado ANTES de tocar la config (fail-loud), el valor previo no cambia

### Requirement: TTC-4 — el destino viaja en `GET` y se edita con `PUT` (`messaging.read` / `messaging.manage`)

El `GET /api/messaging/config/task-stages` (existente, gate `messaging.read`) MUST ganar `resultingStage: MappedStage | null`
en su respuesta (ADITIVO — el shape `{ stages }` previo se conserva, se agrega el campo). Un `PUT
/api/messaging/config/task-stages/resulting-stage` MUST aceptar `{ stageId: string | null }` (Zod `safeParse` → 400
`VALIDATION_ERROR`), gateado por `messaging.manage`, aplicar TTC-2/TTC-3.

#### Scenario: la card lee el destino junto con los stages elegibles
- GIVEN `resultingStageId = 'sB'` y 2 stages elegibles mapeados
- WHEN `GET /api/messaging/config/task-stages` (usuario con `messaging.read`)
- THEN 200 `{ stages: [2 hidratados], resultingStage: {stageId:'sB', ...hidratado} }`

#### Scenario: usuario con `messaging.read` pero sin `messaging.manage` → 403 al PUT
- GIVEN un usuario con solo `messaging.read`
- WHEN `PUT /api/messaging/config/task-stages/resulting-stage`
- THEN 403 `PERMISSION_DENIED`, config sin cambios

#### Scenario: payload malformado → 400
- GIVEN body `{ stageId: 123 }` (no string ni null)
- WHEN PUT
- THEN 400 `VALIDATION_ERROR`, config sin cambios
