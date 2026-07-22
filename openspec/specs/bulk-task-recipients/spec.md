# Spec — bulk-task-recipients (delta sobre messaging-bulk)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify). Delta-sobre-delta:
`messaging-bulk` no está archivado en `openspec/specs/` todavía — este delta se apoya en
`bulk-csv-recipients/specs/messaging-bulk/spec.md` (4to dominio, `manualContacts`). Agrega el 5to
dominio de destinatarios: **Tarea** (`taskStageIds`) — clientes con ≥1 tarea ABIERTA en un estado
(`Stage`) mapeado por `messaging-task-stage-config` y tildado por campaña. NO reabre decisiones
LOCKED de SEG/MAN/CSV (send-path, opt-out, RBAC `messaging.bulk`, keyset). CERO migración en
`Campaign`/`CampaignRecipient` (un recipient de tarea SIEMPRE tiene `clientId`, camino "vinculado").

> **Nota de sync (sdd-archive, 2026-07-22)** — Este archivo es el resultado de archivar el change
> `bulk-task-recipients` (`openspec/changes/archive/2026-07-22-bulk-task-recipients/`). Contiene el
> delta completo (`openspec/changes/bulk-task-recipients/specs/messaging-bulk/spec.md`, ya movido al
> archive) para la capability `messaging-bulk`, cuyo spec main **TODAVÍA NO EXISTE** en
> `openspec/specs/messaging-bulk/` (verificado al archivar — deuda ya documentada por
> `chatwoot-hub-sendpath` en su propia nota de sync, `openspec/specs/chatwoot-hub-sendpath/spec.md`,
> y en la proposal/design de este change). Por eso, mismo patrón que `chatwoot-hub-sendpath`, este
> spec vive bajo el nombre del CHANGE (`bulk-task-recipients`) y no bajo `messaging-bulk`.
>
> **Diferencia importante con el caso `chatwoot-hub-sendpath`**: ese change tenía requirements
> **MODIFIED** que SUPERSEDÍAN a `SEND-2/3/4`/`HIST-3` de `messaging-bulk` (cambiaba comportamiento
> existente). Este change (`bulk-task-recipients`) es **puramente ADITIVO** sobre `messaging-bulk`:
> agrega el 5to dominio de destinatarios (`TASK-1`..`TASK-9`) sin modificar ni un requirement
> existente de SEG/MAN/CSV — el propio spec lo declara ("NO reabre decisiones LOCKED de SEG/MAN/CSV").
> No hay colisión de contenido a resolver entre los dos deltas: son capas independientes que se
> apilan sobre la misma capability ausente.
>
> Los 9 requirements de abajo (`TASK-1`..`TASK-9`) están en su versión **FINAL y auto-contenida**,
> incluyendo el fix de la fix-wave (F1, HIGH — ver TASK-3) que corrigió `isClosed` → `generalStatus:
> 'open'` como predicado de "tarea abierta" (el bug nunca llegó a prod ni a main, corregido en el
> mismo change antes del merge).
>
> Cuando `messaging-bulk` se archive a su vez (junto con `bulk-csv-recipients` y
> `chatwoot-hub-sendpath`), quien haga ese sync **DEBE** incorporar estos 9 requirements
> (`TASK-1`..`TASK-9`) tal cual están acá, además de los requirements MODIFIED ya sincronizados en
> `openspec/specs/chatwoot-hub-sendpath/spec.md` (`SEND-2/3/4`, `HIST-3`) — el spec main final de
> `messaging-bulk` necesita ambas capas para reflejar el estado real del código.

---

## Capability: destinatarios por tarea — `taskStageIds` (NUEVO, 5to dominio)

### Requirement: TASK-1 — wire `taskStageIds`, combinable con los otros 4 dominios

`PreviewSegmentInput`/`ListSegmentRecipientsInput`/`CreateCampaignInput` MUST ganar
`taskStageIds?: string[]`, PARALELO a `segment`/`manualClientIds`/`manualContacts`. Una campaña
MUST ser válida cuando segmento filtrado, O `manualClientIds`, O `manualContacts`, O `taskStageIds`
no vacío, o cualquier combinación (`assertHasRecipients` gana un 5to componente). El parser
`toTaskStageIds` (molde `toManualClientIds`) MUST ser fail-loud: ausente → `undefined` (no
participa, no es error); no-array o item no-string → 400 `VALIDATION_ERROR`.

#### Scenario: solo segmento/manual/csv (no-regresión)
- GIVEN una campaña sin `taskStageIds`
- WHEN se crea/previsualiza
- THEN se resuelve EXACTAMENTE igual que antes de este change (suites SEG/MAN/CSV verdes sin
  editar aserciones)

#### Scenario: payload malformado → 400
- GIVEN `taskStageIds: 'no-es-array'`
- WHEN POST /campaigns o /segment/preview o /segment/recipients
- THEN 400 `VALIDATION_ERROR`, nada persistido

#### Scenario: combinación con manual (unión)
- GIVEN `manualClientIds: ['c1']` y `taskStageIds: ['stageA']` (mapeado, con tareas abiertas de c2)
- WHEN se crea
- THEN se materializan 2 recipients (c1 por `source:'manual'`, c2 por `source:'task'`)

### Requirement: TASK-2 — validación de elegibilidad contra la config (fail-loud, 422)

`resolveCombinedRecipients` MUST validar que TODOS los ids de `taskStageIds` estén en el set de
`listMappedStageIds()` de `messaging-task-stage-config` ANTES de resolver clientes. Si algún id NO
está mapeado (incluyendo el caso config totalmente vacía) MUST lanzar `TaskStageNotEligibleError`
(`TASK_STAGE_NOT_ELIGIBLE`) → 422. El BE es la autoridad — el composer solo debería ofrecer
mapeados, pero NUNCA se confía en el cliente; NUNCA se dropea el id no-elegible en silencio.

#### Scenario: stage no mapeado → 422
- GIVEN config con `['stageA']` mapeado, request con `taskStageIds: ['stageA', 'stageB']`
- WHEN se crea/previsualiza
- THEN 422 `TASK_STAGE_NOT_ELIGIBLE`, nada persistido (se rechaza la request ENTERA, no se
  filtra `stageA` solo)

#### Scenario: config vacía + request con `taskStageIds` → 422
- GIVEN 0 stages mapeados
- WHEN request con `taskStageIds: ['cualquiera']`
- THEN 422 `TASK_STAGE_NOT_ELIGIBLE` (ningún id puede ser elegible contra un set vacío)

### Requirement: TASK-3 — resolución: tareas abiertas, cliente real, DISTINCT

El port `TaskRecipientSource.listClientIdsByOpenTaskStages(stageIds)` MUST devolver `clientId`
DISTINCT de `ScheduledTask` con `stageId IN (stageIds)`, `generalStatus = 'open'`, `customerId !=
null`. Tareas de red (`customerId` null) MUST excluirse de este set (no son error de config) y
contarse aparte vía `countOpenTasksWithoutCustomer(stageIds)` → `noCustomerCount` (chip agregado
honesto). Sin ventana temporal en v1 — solo "abierta ahora".

> **Hallazgo (fix wave, F1, HIGH)**: el predicado de "abierta" MUST usar `generalStatus = 'open'`,
> NUNCA el flag legacy `isClosed` — una tarea `generalStatus:'dismissed'` (descartada) tiene
> `isClosed === false` también (`messaging.ts:227-228`, ya documentado ahí para el mismo motivo). La
> spec original decía `isClosed = false`, un error que se propagó explore → spec → design → código →
> índice; corregido en el lugar (batch nunca llegó a prod ni a main). Único otro camino de "tareas
> abiertas" del repo, `PrismaFiberAutoProvisionTaskRepository.ts:16`, ya usaba `generalStatus`.

#### Scenario: cliente con 5 tareas abiertas en 2 stages tildados → UNA sola vez
- GIVEN un cliente con 5 `ScheduledTask` abiertas repartidas entre `stageA` y `stageB` (ambos
  tildados)
- WHEN se resuelve `taskStageIds: ['stageA','stageB']`
- THEN el `clientId` aparece UNA sola vez en el set distinct (no 5)

#### Scenario: stage mapeado pero sin tareas abiertas → 0 sin error
- GIVEN `stageC` mapeado y tildado, sin ninguna tarea abierta actualmente
- WHEN se resuelve
- THEN 0 clientes por ese stage — no es error, el preview lo muestra en `count:0` para ese origen

#### Scenario: tarea de red en un stage mapeado → excluida y contada aparte
- GIVEN 3 tareas `kind:'network'` (`customerId: null`) en un stage tildado
- WHEN se resuelve/previsualiza
- THEN esas 3 NO generan recipient; `noCustomerCount: 3` en el preview

#### Scenario: tarea cerrada en el stage → no cuenta
- GIVEN un cliente cuya ÚNICA tarea en el stage tildado tiene `generalStatus: 'closed'`
- WHEN se resuelve
- THEN ese cliente NO entra por el dominio tarea

#### Scenario: tarea DESCARTADA en el stage → tampoco cuenta (fix wave, F1, HIGH)
- GIVEN un cliente cuya ÚNICA tarea en el stage tildado tiene `generalStatus: 'dismissed'` (Y
  `isClosed: false` — el flag legacy NO refleja este estado)
- WHEN se resuelve
- THEN ese cliente NO entra por el dominio tarea (filtrar por `isClosed` en vez de `generalStatus`
  dejaba pasar este caso — bug corregido en la fix wave)

### Requirement: TASK-4 — cap defensivo `MAX_TASK_STATE_RECIPIENTS = 10000`

El SET de `clientId` distinct resuelto MUST chequearse contra `MAX_TASK_STATE_RECIPIENTS = 10000`
(el DOBLE de los caps manual/csv de 5000, porque este universo es COMPUTADO, no curado a mano). Si
excede, MUST lanzar `TooManyTaskStateRecipientsError` (`TOO_MANY_TASK_STATE_RECIPIENTS`) → 422 con
mensaje accionable ("acotá los estados seleccionados"), ANTES de hidratar/tocar más DB.

#### Scenario: más de 10000 clientes distinct → 422 accionable
- GIVEN un stage tildado cuya resolución distinct supera 10000 clientIds
- WHEN se crea/previsualiza
- THEN 422 `TOO_MANY_TASK_STATE_RECIPIENTS`, mensaje accionable, nada persistido

### Requirement: TASK-5 — hidratación reusa el candidate pipeline, `source:'task'`

Los `clientId` resueltos MUST hidratarse vía `ManualRecipientSource.findRecipientCandidatesByIds`
(MISMA instancia que el dominio manual — cero lógica de teléfono nueva, mismo derivador
`toWhatsAppE164`/`normalizePhone`). Cada candidato admitido MUST entrar a la unión con
`source:'task'` (nuevo miembro de `CombinedResolvedRecipient.source`, union
`'segment'|'manual'|'csv'|'task'`).

#### Scenario: cliente resuelto por tarea sin teléfono válido → excluido con detalle
- GIVEN un cliente con tarea abierta en stage tildado pero `phone` que normaliza a inválido
- WHEN se previsualiza
- THEN NO se materializa; `taskExcludedDetail` incluye ese cliente con motivo `telefono_invalido`

#### Scenario: cliente opt-out resuelto por tarea → excluido
- GIVEN un cliente con `whatsappOptOutAt != null` cuya tarea abierta está en un stage tildado
- WHEN se previsualiza/crea
- THEN excluido con motivo `opt_out` (mismo criterio que segmento/manual/csv), nunca enviado

### Requirement: TASK-6 — dedup y precedencia: segmento > manual > csv > task

La unión final (`admit()`) MUST deduplicar por `clientId` Y por `phoneNormalized`. La precedencia
de `source` mostrado MUST ser `segmento > manual > csv > task` — `task` APPEND al final (cero
regresión en labels existentes). Un cliente resuelto por tarea Y por otra fuente MUST incluirse UNA
sola vez, con el `source` de la fuente de MAYOR precedencia (la inclusión no cambia, solo la
provenance mostrada).

#### Scenario: cliente en segmento Y en tarea → gana el label de segmento
- GIVEN un segmento que resuelve al cliente c1, y c1 también tiene una tarea abierta en un stage
  tildado
- WHEN se resuelve
- THEN c1 aparece UNA vez con `source:'segment'` (no `'task'`)

#### Scenario: cliente resuelto ÚNICAMENTE por tarea
- GIVEN un cliente que NO entra por segmento/manual/csv, solo por tener tarea abierta en stage
  tildado
- WHEN se resuelve
- THEN aparece con `source:'task'`

### Requirement: TASK-7 — skip-counts y excluidos propios (honestidad, molde CSV)

`taskSkipped: RecipientSkipCounts` (opt-out / teléfono inválido / duplicado) y
`taskExcludedDetail` (detalle por persona) MUST calcularse SEPARADOS de los de segmento/manual/csv,
igual criterio que CSV-6/DET-2. `noCustomerCount` (tareas de red sin cliente) MUST viajar como chip
agregado, visible en el preview, NUNCA un drop silencioso.

#### Scenario: preview agrega la fuente task sin romper el shape existente
- GIVEN `taskStageIds` que resuelve 2 clientes válidos y 1 excluido por opt-out, más 3 tareas de
  red sin cliente en el mismo set de stages
- WHEN POST /segment/preview
- THEN `count` incluye los 2 válidos, `taskSkipped.optedOut: 1`, `noCustomerCount: 3`

### Requirement: TASK-8 — snapshot al create, envío nunca re-resuelve

Los clientes distinct resueltos por tarea MUST materializarse como `CampaignRecipient` al crear
(idéntico a los otros 4 dominios). El envío (`SendCampaign`) MUST NOT re-resolver contra el mapeo
ni contra el estado actual de las tareas. Cambios de mapeo o cierre de tareas DESPUÉS del create
MUST NOT tener efecto sobre una campaña ya creada.

#### Scenario: el mapeo cambia entre create y send → sin efecto
- GIVEN una campaña creada con recipients materializados por `taskStageIds: ['stageA']`
- WHEN el admin desmapea `stageA` de la config ANTES de que la campaña se envíe
- THEN el envío procesa los recipients YA materializados sin cambios (snapshot frozen)

#### Scenario: la tarea se cierra entre create y send → sin efecto
- GIVEN un recipient materializado porque su tarea estaba abierta al momento del create
- WHEN esa tarea se cierra (`isClosed:true`) antes del envío
- THEN el recipient se envía igual (el snapshot ya se congeló, SEND-5 solo re-chequea opt-out/status
  del CLIENTE, no el estado de la tarea)

### Requirement: TASK-9 — recheck de permisos granular automático

Un cliente resuelto por tarea MUST entrar AUTOMÁTICAMENTE al recheck de `bulk-granular-perms`
(`AuthorizeCampaignSend`, por `status` real del candidato hidratado) — sin código nuevo, mismo
mecanismo que segmento/manual/csv.

#### Scenario: operador sin permiso para el status de un cliente resuelto por tarea
- GIVEN un cliente `status:'blocked'` resuelto ÚNICAMENTE por `taskStageIds`, operador sin
  `messaging.bulk_blocked`
- WHEN se crea la campaña
- THEN `BulkRecipientsNotPermittedError` (403) bloquea la campaña COMPLETA, igual que si viniera
  de segmento/manual/csv
