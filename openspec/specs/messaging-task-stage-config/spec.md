# Spec BE — messaging-task-stage-config (NUEVA capability, change bulk-task-recipients)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify). Config → WhatsApp que
define QUÉ estados (`Stage`) de tareas son elegibles como criterio de destinatarios del 5to
dominio "Tarea" del bulk (`messaging-bulk` delta, mismo change). Molde: `NocBroadcastConfig`
(singleton) para el patrón de card, pero acá el dato es un SET (1 fila por stage), no un singleton.

---

## Capability: config de estados de tarea elegibles

### Requirement: TSC-1 — tabla `WhatsappTaskStageRecipientConfig`, integridad por FK real

El schema MUST agregar `WhatsappTaskStageRecipientConfig { id, stageId String @unique, stage
Stage @relation(fields:[stageId], references:[id], onDelete: Cascade), createdAt }` — una fila POR
stage mapeado (NO `stageIds String[]` crudo: la FK real evita ids huérfanos). La migración MUST
ser aditiva (`npm run prisma:migrate`), CERO cambio en `Campaign`/`CampaignRecipient`.

#### Scenario: borrar un Stage limpia el mapeo solo (cascade)
- GIVEN un Stage mapeado en la config
- WHEN el Stage se borra (`DELETE` vía `workflows.routes`, gate `scheduling.manage`)
- THEN la fila de config correspondiente se borra automáticamente (cascade) — sin job de limpieza

#### Scenario: mapear el mismo stage dos veces es imposible
- GIVEN un stage YA mapeado
- WHEN `replaceMappedStages` recibe un set con ese `stageId` repetido
- THEN el use case MUST deduplicar el input antes de persistir (la constraint `@unique` es la
  última línea de defensa, no la única)

### Requirement: TSC-2 — port `TaskStageRecipientConfigRepository`

El domain port MUST exponer `listMappedStageIds(): Promise<string[]>`, `getMappedStages():
Promise<MappedStage[]>` (hidratado `stageId, code, name, color, workflowId, workflowName`) y
`replaceMappedStages(stageIds: string[]): Promise<void>` con semántica REPLACE-SET (el resultado
es EXACTAMENTE el array recibido, nunca un append). Adapter Prisma +
`InMemoryTaskStageRecipientConfigRepository` (tests) MUST cumplir el mismo contrato.

#### Scenario: replace-set reemplaza, no suma
- GIVEN config mapeada `[A, B]`
- WHEN `replaceMappedStages([B, C])`
- THEN el nuevo estado es EXACTAMENTE `[B, C]` — A queda desmapeado

#### Scenario: replace-set con array vacío limpia toda la config
- GIVEN config mapeada `[A, B, C]`
- WHEN `replaceMappedStages([])`
- THEN la config queda vacía (0 filas) — válido, no error

### Requirement: TSC-3 — `GET /api/messaging/config/task-stages` (`messaging.read`)

El endpoint MUST devolver `{ stages: MappedStage[] }` gateado por `messaging.read`. Ambas
superficies (card de Ajustes, tab "Tarea" del composer) lo consumen.

**Decisión RBAC (riesgo #2 de la proposal, verificado contra el seed real):** las migraciones
`20260904000100_messaging_permissions` (otorga `read`+`send`) y `20260908000100_messaging_bulk_permissions`
(otorga `bulk`+`templates`) conceden AMBOS pares a los MISMOS DOS roles seedeados (`super_admin`,
`administrador`) — hoy NINGÚN rol seedeado tiene `messaging.bulk` sin `messaging.read`. El RBAC del
repo es sin embargo una matriz dinámica (`rbac-permission-matrix-ui`, capability existente): un
admin PUEDE crear a futuro un rol custom con `bulk` pero sin `read`. Este spec MANTIENE el gate
simple `messaging.read` (decisión ya tomada en proposal §4 — "sin acción RBAC nueva"): NO se agrega
soporte OR a `requirePermission` (hoy acepta un solo par `(module,action)`, sin variante any-of). El
caso de un rol custom mal configurado se resuelve OPERATIVAMENTE otorgándole `messaging.read` desde
el matrix UI existente — no es un bug del feature, es un gap de configuración de rol autoinflingido
y autorresoluble sin deploy.

#### Scenario: usuario con `messaging.read` ve el mapeo
- GIVEN un usuario con `messaging.read`
- WHEN `GET /api/messaging/config/task-stages`
- THEN 200 con los stages mapeados hidratados

#### Scenario: usuario con `messaging.bulk` pero SIN `messaging.read` → 403 (esperado, no bug)
- GIVEN un rol CUSTOM con `messaging.bulk` otorgado pero SIN `messaging.read` (posible solo vía
  matrix UI — ningún rol seedeado cae acá)
- WHEN ese usuario hace `GET /config/task-stages`
- THEN 403 `PERMISSION_DENIED` — el fix es otorgar `messaging.read` a ese rol desde el matrix UI,
  NO ampliar el gate del endpoint

#### Scenario: config vacía devuelve array vacío, no error
- GIVEN 0 stages mapeados
- WHEN GET
- THEN 200 `{ stages: [] }`

### Requirement: TSC-4 — `PUT /api/messaging/config/task-stages` (`messaging.manage`), replace-set fail-loud

El endpoint MUST aceptar `{ stageIds: string[] }` (Zod `safeParse` → 400 `VALIDATION_ERROR` si
falta o no es array de strings), gateado por `messaging.manage`. MUST validar que TODOS los
`stageIds` correspondan a un `Stage` EXISTENTE ANTES de reemplazar — si alguno no existe, error
tipado (fail-loud, todo-o-nada: nunca un replace parcial).

#### Scenario: replace-set exitoso
- GIVEN body `{ stageIds: ['s1','s2'] }`, ambos existentes
- WHEN PUT (usuario con `messaging.manage`)
- THEN 200, config queda `[s1, s2]` exactamente

#### Scenario: stageId inexistente → rechazado, nada se aplica
- GIVEN body `{ stageIds: ['s1', 'stage-inexistente'] }`
- WHEN PUT
- THEN error tipado ANTES de tocar la config — s1 NO se aplica solo, la config previa no cambia

#### Scenario: payload malformado → 400
- GIVEN body `{ stageIds: 'no-es-array' }`
- WHEN PUT
- THEN 400 `VALIDATION_ERROR`, config sin cambios

#### Scenario: usuario con `messaging.read` pero sin `messaging.manage` → 403
- GIVEN un usuario con solo `messaging.read`
- WHEN PUT
- THEN 403 `PERMISSION_DENIED` (manage es estrictamente más restrictivo)

---

## Sync (sdd-archive 2026-07-24, change bulk-task-stage-transition)

Los siguientes requirements se agregaron al archivar `bulk-task-stage-transition`
(`openspec/changes/archive/2026-07-24-bulk-task-stage-transition/`): el estado resultante
ÚNICO GLOBAL al que transicionan las tareas cuando el bulk las envía. Delta completo en el archive.

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
