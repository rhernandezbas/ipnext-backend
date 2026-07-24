# Spec delta BE — messaging-bulk (change bulk-task-stage-transition)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify). Delta sobre la capability `messaging-bulk`
(cuyo spec main aún vive bajo los nombres de sus changes — ver la nota de sync de `bulk-task-recipients`). Este delta
**MODIFICA** el dominio "Tarea" (`TASK-3`, `TASK-6`, `TASK-8` de `bulk-task-recipients`) de client-level a **per-tarea**, y
**AGREGA** la transición de estado post-`sent` (`TRANS-1..TRANS-6`). NO toca los dominios segmento/manual/csv.

---

## MODIFIED Requirements

### Requirement: TASK-3 (MODIFIED) — resolución PER-TAREA (no client-DISTINCT)

**SUPERSEDE** la versión client-DISTINCT de `bulk-task-recipients`. El port `TaskRecipientSource` MUST exponer
`listOpenTasksByStages(stageIds): Promise<{ taskId, clientId, fromStageId }[]>` que devuelve UNA fila POR TAREA abierta
(`generalStatus = 'open'`, `customerId != null`, `stageId IN (stageIds)`) — NO `clientId` DISTINCT. Cada tarea es una
unidad de envío independiente. `countOpenTasksWithoutCustomer` (chip de red) se conserva sin cambios. Se conserva
`listClientIdsByOpenTaskStages` (lo usa el preview/count agregado). El adapter Prisma + in-memory MUST cumplir el nuevo
método.

#### Scenario: cliente con 2 tareas abiertas en un stage elegido → 2 filas (NO 1)
- GIVEN un cliente con la tarea `t10` y la tarea `t11`, ambas abiertas en `stageA` (elegido)
- WHEN se resuelve `taskStageIds: ['stageA']`
- THEN `listOpenTasksByStages` devuelve DOS filas: `{t10, cliente, stageA}` y `{t11, cliente, stageA}`

#### Scenario: tarea de red (sin cliente) → excluida, contada aparte
- GIVEN 3 tareas abiertas `customerId: null` en `stageA`
- WHEN se resuelve
- THEN `listOpenTasksByStages` NO las devuelve; `countOpenTasksWithoutCustomer(['stageA'])` = 3 (chip honesto)

#### Scenario: tarea cerrada/descartada en el stage → no participa
- GIVEN una tarea en `stageA` con `generalStatus: 'closed'` (o `'dismissed'`)
- WHEN se resuelve
- THEN esa tarea NO aparece en `listOpenTasksByStages` (predicado `generalStatus = 'open'`, nunca el legacy `isClosed`)

### Requirement: TASK-6 (MODIFIED) — dedup: por TAREA dentro del dominio task, sin colapso por teléfono

**SUPERSEDE** el dedup por `clientId`/`phoneNormalized` del dominio task. Dentro del dominio task, cada tarea genera SU
recipient — el dedup por teléfono NO aplica intra-task (dos tareas del mismo cliente → dos recipients al mismo teléfono, es
lo buscado, decisión 3). La precedencia cross-domain se MANTIENE: un cliente ya admitido por segmento/manual/csv NO genera
recipients task (esos clientes conservan su source; el dominio task solo "posee" tareas de clientes no admitidos por otra
fuente). La transición dispara SOLO para recipients con `source` final `task`.

#### Scenario: 2 tareas del mismo cliente/mismo teléfono → 2 recipients (sin colapsar)
- GIVEN un cliente con `t10` y `t11` abiertas en `stageA`, un solo teléfono
- WHEN se resuelve `taskStageIds: ['stageA']`
- THEN se materializan 2 `CampaignRecipient` `source:'task'` (`taskId: t10` y `taskId: t11`), ambos con el mismo `phoneE164`

#### Scenario: cliente en segmento Y con tarea abierta → gana segmento, su tarea NO genera recipient
- GIVEN un segmento que resuelve al cliente `c1`, y `c1` tiene `t20` abierta en `stageA` (elegido)
- WHEN se resuelve segmento + `taskStageIds: ['stageA']`
- THEN `c1` aparece UNA vez con `source:'segment'`; `t20` NO genera un recipient task (y por ende NO transiciona)

### Requirement: TASK-8 (MODIFIED) — snapshot per-tarea (taskId + origen + destino), envío nunca re-resuelve

**EXTIENDE** el snapshot inmutable a la granularidad de tarea. Cada tarea resuelta MUST materializarse como
`CampaignRecipient` con `source:'task'`, `taskId`, `taskFromStageId` (el `stageId` de la tarea AL CREATE — el origen A) y
`taskResultingStageId` (el `resultingStageId` global de la config AL CREATE, o `null` si no hay destino). El envío MUST NOT
re-resolver contra la config ni contra el estado actual de las tareas. Cambios de mapeo/config o de estado de tareas
DESPUÉS del create MUST NOT alterar los snapshots.

#### Scenario: el destino global cambia entre create y send → sin efecto
- GIVEN una campaña creada con `taskResultingStageId: 'sB'` snapshoteado
- WHEN el admin cambia el estado resultante global a `'sC'` ANTES del envío
- THEN el envío mueve la tarea a `'sB'` (el snapshot), no a `'sC'`

#### Scenario: idempotencia del dominio task por tarea
- GIVEN una resolución que materializa `t10` una vez
- WHEN se re-materializa la MISMA campaña con `t10` (retry del create)
- THEN `t10` aparece UNA sola vez (`@@unique([campaignId, taskId])` parcial)

## ADDED Requirements

### Requirement: TRANS-1 — transición POST-`sent`, aislada y best-effort

`SendCampaign` MUST, DESPUÉS de persistir `sent` para un recipient con `taskId != null` Y `taskResultingStageId != null`,
disparar la transición de la tarea vía `MoveTaskToStage` — como efecto **aislado y best-effort** (molde
`projectToInbox`/`applyChatwootLabel`). Un fallo del move MUST loguearse y tragarse: NUNCA re-marca el recipient `failed`
(re-marcarlo lo volvería re-enviable → doble envío). La transición MUST NO correr para recipients `failed`/`skipped`/
`opted_out`, ni para recipients de otros dominios (`taskId == null`).

#### Scenario: envío OK → tarea transiciona
- GIVEN un recipient `source:'task'`, `taskId: t10`, `taskFromStageId: 'sA'`, `taskResultingStageId: 'sB'`, la tarea `t10`
  en `'sA'`
- WHEN `SendCampaign` lo envía y sale `sent`
- THEN `t10` queda en `'sB'`; el feed de la tarea muestra `stage_changed` (sA→sB) con el actor sistema

#### Scenario: envío fallido → tarea NO transiciona
- GIVEN el mismo recipient, pero el proveedor rechaza el envío (`failed`)
- WHEN `SendCampaign` lo procesa
- THEN `t10` sigue en `'sA'` (la transición solo corre tras `sent`)

#### Scenario: el move falla → el `sent` queda, la campaña sigue, sin re-marca
- GIVEN un recipient que sale `sent`, pero `MoveTaskToStage` tira (DB caída / stage borrado)
- WHEN se procesa
- THEN el recipient queda `sent` (NO `failed`), el error se loguea, el resto del batch continúa

### Requirement: TRANS-2 — guard "solo mover si la tarea SIGUE en A"

Antes de mover, `SendCampaign` MUST verificar que el `stageId` ACTUAL de la tarea es igual a `taskFromStageId` (el origen
snapshoteado). Si difiere (un humano movió la tarea entre create y send), MUST NO tocar la tarea (no-op logueado, no error)
— decisión de producto 6.

#### Scenario: humano movió la tarea → no-op
- GIVEN un recipient con `taskFromStageId: 'sA'`, pero la tarea `t10` fue movida a mano a `'sZ'` antes del envío
- WHEN sale `sent`
- THEN `t10` sigue en `'sZ'` (la transición NO la pisa); se loguea el skip

#### Scenario: tarea sigue en A → se mueve
- GIVEN un recipient con `taskFromStageId: 'sA'` y la tarea `t10` todavía en `'sA'`
- WHEN sale `sent`
- THEN `t10` pasa a `taskResultingStageId`

### Requirement: TRANS-3 — guard defensivo anti-`send_to_iclass` en el envío

Si el `taskResultingStageId` snapshoteado resultara un stage con `code === 'send_to_iclass'` (config vieja o carrera),
`SendCampaign` MUST abortar el move de esa tarea (NO crear OS) y loguearlo. La defensa PRIMARIA vive al guardar la config
(TTC-3); esta es red de seguridad.

#### Scenario: destino snapshoteado es send_to_iclass → no se mueve, no se crea OS
- GIVEN un recipient cuyo `taskResultingStageId` apunta (por data vieja) a un stage `send_to_iclass`
- WHEN sale `sent`
- THEN la tarea NO se mueve, NO se crea OS en IClass, se loguea

### Requirement: TRANS-4 — sin destino configurado → mensaje sale, tarea intacta

Un recipient task con `taskResultingStageId == null` (no había estado resultante al create) MUST enviarse normalmente y NO
transicionar ninguna tarea. El dominio task sin destino se comporta EXACTO como `bulk-task-recipients` (solo filtro).

#### Scenario: config sin B → solo se envía
- GIVEN una campaña creada cuando `resultingStageId` global era `null`
- WHEN se envía
- THEN los mensajes salen; ninguna tarea cambia de estado

### Requirement: TRANS-5 — reforma del `@@unique` de `CampaignRecipient` (migración destructiva)

El schema MUST reemplazar `@@unique([campaignId, clientId])` por un unique PARCIAL `@@unique([campaignId, taskId])`
(`WHERE taskId IS NOT NULL`), permitiendo N filas por `clientId` en una campaña (una por tarea) SIN romper el dedup de los
otros dominios (que siguen con `clientId` único por otra vía — a garantizar en la resolución, no en la constraint). La
migración MUST ser transaccional, con guard + backup, y NO destruir datos de campañas existentes (las filas viejas tienen
`taskId == null`, quedan fuera del unique parcial).

#### Scenario: dos recipients task del mismo cliente coexisten
- GIVEN una campaña con `t10` y `t11` del mismo `clientId`
- WHEN se materializan
- THEN ambas filas persisten (el viejo `@@unique[campaignId,clientId]` las habría rechazado)

#### Scenario: recipients viejos (pre-migración, taskId null) no colisionan
- GIVEN campañas existentes con recipients `clientId` no nulo y `taskId` null
- WHEN corre la migración
- THEN conviven sin violar el unique parcial (`taskId IS NULL` fuera del índice)

### Requirement: TRANS-6 — preview cuenta TAREAS y anticipa las transiciones

El preview del dominio task MUST contar TAREAS (no clientes DISTINCT) y MUST exponer cuántas transicionarán (hay
`resultingStageId` configurado) vs. cuántas solo reciben el mensaje. `noCustomerCount` (tareas de red) se conserva.

#### Scenario: preview con 2 tareas de un cliente + destino configurado
- GIVEN un cliente con `t10` y `t11` en `stageA`, `resultingStageId = 'sB'`
- WHEN `POST /segment/preview` con `taskStageIds: ['stageA']`
- THEN el count de mensajes task = 2 (no 1); el preview indica que 2 tareas transicionarán a `sB`
