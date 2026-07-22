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
