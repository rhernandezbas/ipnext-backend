# Proposal — bulk-task-recipients (EPIC Mensajería WhatsApp · 5to dominio de destinatarios)

## 1. Why / Intent

El Bulk WhatsApp resuelve destinatarios por 4 dominios paralelos: **segmento** (`{statuses[], balanceMin?, balanceMax?}`),
**lista manual** (`manualClientIds`), **CSV/números crudos** (`manualContacts`) — cada uno con su port narrow,
su branch en `resolveCombinedRecipients`, su `source`, su cap defensivo y su parser fail-loud (patrón bulk-csv-recipients D1-D12).

**Falta el 5to dominio: Tarea.** El operador quiere disparar campañas a los clientes que HOY tienen una gestión abierta
en cierto estado del catálogo de scheduling (ej. "esperando turno", "pendiente de contacto", "reclamo abierto") —
sin tener que listarlos a mano. El "estado de tarea" es el `ScheduledTask.stageId` (FK a `Stage`, catálogo EDITABLE por
workflow), **no** un enum ni `generalStatus` (ese es el ciclo de vida open/closed, que SÍ usamos como filtro "abiertas").

**Decisiones de producto YA tomadas** (usuario, 2026-07-22, engram `sdd/campaign-label-y-task-recipients/decisiones` — NO re-abrir):

- **(a) Config → WhatsApp mapea QUÉ estados (Stage) son elegibles.** Una card nueva en Ajustes deja al supervisor
  seleccionar un conjunto de Stages del catálogo. Ese mapeo es el universo de estados que el bulk puede usar.
- **(b) El composer gana un tab "Tarea"** donde el operador **TILDA un SUBSET** de los estados mapeados por campaña.
  Un cliente es destinatario si tiene **≥1 tarea ABIERTA** (`isClosed = false`) con `customerId != null` en alguno de
  los estados tildados. **Sin ventana de tiempo en v1** (solo "abierta ahora").
- **(c) Honestidad de exclusiones** (heredado del bulk): tareas de red sin cliente (`customerId` null) y clientes sin
  teléfono / con opt-out son VISIBLES en el preview (chip agregado + detalle por persona donde aplica), nunca un drop silencioso.

## 2. Scope IN

### BE (primero)

1. **Tabla de config `WhatsappTaskStageRecipientConfig`** — 1 fila POR stage mapeado
   (`{ id, stageId String @unique, stage Stage @relation(onDelete: Cascade), createdAt }`), FK REAL a `Stage`.
   Migración **aditiva** (`npm run prisma:migrate`). Elegida sobre `String[]` crudo porque Postgres garantiza integridad
   (imposible mapear un stage inexistente) y **borrar un Stage limpia la config** vía cascade — coherente con el fail-loud del feature.
   **Cero migración** en `Campaign`/`CampaignRecipient` (los recipients por tarea SIEMPRE tienen `clientId`; `clientId` ya es nullable de bulk-csv-recipients pero acá nunca se usa null).

2. **Port de config `TaskStageRecipientConfigRepository`** (domain/ports): `listMappedStageIds(): Promise<string[]>`,
   `getMappedStages(): Promise<MappedStage[]>` (hidratado con code/name/color/workflow para la card y el tab),
   `replaceMappedStages(stageIds: string[]): Promise<void>` (semántica **replace-set**, no append). Adapter Prisma + in-memory (tests).

3. **Config CRUD** — router molde `nocBroadcast.routes` (factory + authProvider + perms `{read, manage}` + use cases
   `GetTaskStageRecipientConfig` / `UpdateTaskStageRecipientConfig`), montado en `/api/messaging/config/task-stages`
   (prefijo más específico que `/api/messaging`, registrado DESPUÉS → mismo fall-through que /noc-broadcast).
   - `GET /api/messaging/config/task-stages` → stages mapeados hidratados. **Gate `messaging.read`** (lo leen AMBAS
     superficies: la card de Ajustes Y el composer para pintar el tab). El baseline `messaging.read` lo tiene todo rol de
     mensajería (bulk es aditivo sobre read; verificar en el seed — ver Riesgos).
   - `PUT /api/messaging/config/task-stages` (body `{ stageIds: string[] }`, Zod `safeParse` → 400 `VALIDATION_ERROR`)
     → replace-set. **Gate `messaging.manage`** (el MISMO permiso "supervisor" que ya gobierna canned-responses / noc-broadcast / notas).
   - El **catálogo completo de Stages** para elegir NO necesita endpoint nuevo: la card usa el `GET /workflows` existente
     (gate `scheduling.read`) + `useWorkflows()` del FE.

4. **Port narrow de resolución `TaskRecipientSource`** (domain/ports, SEPARADO — no se cuelga de `CustomerRepository`):
   `listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]>` → `clientId` **DISTINCT** de tareas con
   `stageId IN (…)`, `customerId != null`, `isClosed = false`. Adapter Prisma
   (`scheduledTask.findMany({ where, select:{customerId}, distinct:['customerId'] })`) + in-memory.
   También expone `countOpenTasksWithoutCustomer(stageIds): Promise<number>` para el chip honesto de "tareas de red sin cliente".

5. **Wire `taskStageIds?: string[]`** — nuevo input top-level en `PreviewSegmentInput` / `ListSegmentRecipientsInput` /
   `CreateCampaignInput`, PARALELO a `segment` / `manualClientIds` / `manualContacts`. Parser fail-loud `toTaskStageIds`
   en `messagingBulk.routes` (molde `toManualClientIds`): ausente → `undefined`; no-array o item no-string → 400 `VALIDATION_ERROR`.
   `assertHasRecipients` gana un 5to componente (segmento ∪ manual ∪ csv ∪ **tarea** no vacío).

6. **Branch `task` en `resolveCombinedRecipients`** — dado `taskStageIds`:
   (i) **valida** que TODOS los ids estén en el set mapeado de la config; si alguno NO está → typed error
   `TASK_STAGE_NOT_ELIGIBLE` → **422** (fail-loud, NUNCA drop silencioso — el composer solo debería mandar mapeados,
   pero el BE es la autoridad); (ii) `taskSource.listClientIdsByOpenTaskStages(stageIds)` → clientIds distinct;
   (iii) **hidrata** esos ids por el camino de candidatos YA existente (`ManualRecipientSource.findRecipientCandidatesByIds`,
   misma instancia) → candidatos con `name/phone/status/balanceDue/whatsappOptOutAt`, mismo derivador E164 (`toWhatsAppE164`/`normalizePhone`)
   que segmento/manual (CERO lógica de teléfono nueva); (iv) `admit()` con **`source:'task'`** (nuevo miembro del union),
   dedup por `clientId` Y `phoneNormalized`; (v) `taskSkipped: RecipientSkipCounts` (opt-out / invalid-phone / duplicado)
   propio + `taskExcludedDetail` por persona + `noCustomerCount` (chip agregado "N tareas de red sin cliente omitidas").

7. **Snapshot materializado al create** — los clientes distinct resueltos se congelan como `CampaignRecipient` al crear
   (idéntico a todos los otros dominios). **El envío JAMÁS re-resuelve.** Si el mapeo o los estados de las tareas cambian
   entre create y send → sin efecto (snapshot ya frozen). Se declara explícito como invariante.

8. **Cap defensivo `MAX_TASK_STATE_RECIPIENTS = 10000`** — aplicado al SET de clientIds distinct DESPUÉS de resolver
   (no es input del payload, es output computado); exceso → typed error → **422** con mensaje accionable
   ("acotá los estados seleccionados"). Es una baranda de seguridad (evitar blast accidental de 20k por mapear un stage
   enorme), NO un límite de producto — tuneable. Doble de los caps manual/csv (5000) porque el universo es computado, no curado.

9. **bulk-granular-perms** — un cliente resuelto por tarea entra AUTOMÁTICO al recheck por `status` del envío
   (`AuthorizeCampaignSend`, lee el snapshot) porque el candidato hidratado trae `status` real. Sin código nuevo.

### FE (después, sobre el BE ya verde)

10. **Card "Destinatarios por estado de tarea"** en `WhatsappSettingsPage` (molde `NocBroadcastCard`): multi-select de
    Stages **agrupados por Workflow** (todos los workflows en v1, ver §5), poblado por `useWorkflows()`
    (**gate FE `scheduling.read`** para LISTAR); botón guardar → `PUT` (**gate FE `messaging.manage`**). Muestra el mapeo actual.
    Un usuario con `messaging.manage` pero sin `scheduling.read` ve la card con hint ("necesitás permiso de scheduling para elegir estados").

11. **Tab "Tarea"** en `CampaignComposer` (6to tab UI, 4to dominio de wire): checkboxes de los stages MAPEADOS
    (de `GET /config/task-stages`), el operador TILDA un subset; el preview muestra counts por-source + el chip de
    "tareas sin cliente". Payload `taskStageIds` = subset tildado. **Config vacía (sin stages mapeados) → tab DESHABILITADO
    con hint** ("Configurá estados de tarea en Ajustes → WhatsApp") — el feature nace oscuro hasta que un admin mapee ≥1 stage.

12. **PreviewModal** ya paginado (bulk-csv-recipients) suma la fuente `task` en counts/excluidos sin rediseño.

## 3. Scope OUT

- **Ventana temporal** ("tareas abiertas en los últimos N días", "creadas después de X") — v1 es solo "abierta ahora". Futuro.
- **Tareas cerradas / históricas** — explícitamente excluidas (`isClosed = false` es el filtro).
- **Persistir `taskStageIds` como criterio reproducible en `Campaign.segment`** — igual que manual/csv, el dominio Tarea
  NO se persiste como filtro; solo se materializa en `CampaignRecipient` (snapshot). (Auditar qué stages se usaron queda para un futuro campo de auditoría, no bloqueante.)
- **Filtrar el picker de config por `kind` de workflow** (customer vs network) — v1 muestra todos; mapear un stage de red es inocuo (resuelve 0 clientes por el `customerId != null`).
- **Opt-out para no-clientes** — no aplica: todo recipient por tarea es un `Client` real.
- **Rediseño del composer** — corre en otro change; los componentes nuevos (tab, card) son aislados.

## 4. Approach (resumen — detalle en design.md)

- **Datos**: `WhatsappTaskStageRecipientConfig` (tabla nueva, FK a `Stage` onDelete:Cascade). Cero cambio en `Campaign`/`CampaignRecipient`.
- **Ports**: `TaskStageRecipientConfigRepository` (config CRUD) + `TaskRecipientSource` (resolución) — DOS ports narrow nuevos,
  ambos con adapter Prisma + in-memory. Deliberadamente separados de los demás (agregar método a un port existente rompe fakes de otros use cases — disciplina D-pattern).
- **Resolución**: `resolveCombinedRecipients` gana un branch `task` (se parece al branch `manual` — siempre hay `clientId`),
  con validación de elegibilidad contra la config (422 fail-loud), hidratación reusando `findRecipientCandidatesByIds`,
  `source:'task'`, skip-counts + excludedDetail propios, y el chip `noCustomerCount`.
- **Dedup / precedencia**: `CombinedResolvedRecipient.source` gana `'task'`. Precedencia en la unión: **segmento > manual > csv > task**
  (task APPEND al final → cero regresión en el orden/labels existentes; un cliente ya resuelto por otra fuente conserva su label,
  `task` solo "posee" a los clientes resueltos ÚNICAMENTE por el criterio de tarea). La inclusión no cambia por la precedencia — solo la provenance mostrada.
- **RBAC (dos capas)**: leer el mapeo = `messaging.read` (composer + card); editar el mapeo = `messaging.manage` (supervisor);
  listar el catálogo de stages a elegir = `scheduling.read` (endpoint `/workflows` existente, gate FE). Sin acción RBAC nueva.
- **Envío**: `SendCampaign` NO cambia — los recipients por tarea son `clientId != null`, camino "vinculado" normal.

## 5. Validaciones cruzadas y decisiones de borde (lo que el usuario pidió resolver)

| Caso | Resolución |
|---|---|
| Composer manda un `stageId` NO mapeado en la config | **422** `TASK_STAGE_NOT_ELIGIBLE` (fail-loud, se rechaza la request entera — NO se dropea el id en silencio). El BE es la autoridad; el FE ya solo ofrece los mapeados, pero no confiamos en el cliente. |
| El mapeo cambia entre create y send | **Sin efecto.** El snapshot se materializa al create; el envío nunca re-resuelve. Invariante declarado. |
| Una tarea del stage seleccionado se cierra entre create y send | **Sin efecto** (mismo snapshot). Al create se evaluó `isClosed = false`; después es irrelevante. |
| Tarea de red (`customerId` null) en un stage mapeado | Excluida de la resolución por el filtro `customerId != null`; se cuenta aparte (`noCustomerCount`) y se muestra como chip honesto en el preview. No es error de config. |
| Config vacía (0 stages mapeados) | Tab "Tarea" DESHABILITADO con hint. `taskStageIds` vacío/ausente = dominio no participa (no es error). |
| Multi-workflow en el picker | v1: se muestran los stages de **TODOS** los workflows, agrupados por nombre de workflow. Sin filtrar por `kind`. Mapear un stage que solo usan tareas de red es inocuo (resuelve 0). Simplicidad sobre cross-filtering. |
| Dedup cliente presente en task + otra fuente | Incluido una sola vez; conserva el `source` de mayor precedencia (segmento > manual > csv > task). |

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Escala del `DISTINCT(customerId)` — un stage con miles de tareas históricas abiertas devuelve un set enorme sin curar | Cap defensivo `MAX_TASK_STATE_RECIPIENTS=10000` (422 accionable) + `isClosed=false` acota a lo vigente + preview muestra el count antes de crear. Índice en `(stageId, isClosed, customerId)` a evaluar en design. |
| `messaging.bulk` sin `messaging.read` en algún rol → el composer no puede leer `GET /config/task-stages` | Verificar el seed RBAC (task del spec/design): read es baseline de módulo, bulk es aditivo. Si algún rol tuviera bulk sin read, ampliar el gate del GET a `messaging.read` ∨ `messaging.bulk`. |
| Config con `String[]` crudo dejaría ids huérfanos al borrar un Stage | Descartado: tabla con FK real + `onDelete:Cascade` limpia sola. |
| Colisión de merge con `bulk-csv-recipients` y `campaign-chatwoot-label` (tocan el MISMO `resolveCombinedRecipients` + composer) | Branch/campo/source nuevos y AISLADOS (append, no reescritura); rebasar sobre esos changes si aterrizan antes. Los tests existentes de segmento/manual/csv NO se tocan (cero regresión de aserciones). |
| Card de config usable solo con `scheduling.read` + `messaging.manage` a la vez | Degradación explícita con hint por permiso faltante (no un 403 opaco). |

## 7. Success criteria

- Campaña solo-tarea, tarea+segmento y tarea+manual crean y ENVÍAN end-to-end (tests de use case in-memory + seam supertest verdes).
- Un cliente con ≥1 tarea abierta en un stage tildado entra; el mismo cliente con la tarea cerrada NO entra; una tarea de red
  del stage se cuenta en `noCustomerCount` y NO genera recipient.
- `PUT /config/task-stages` con un `stageId` inexistente → rechazado por la FK (o 400 pre-check); borrar el Stage limpia la fila (cascade).
- Composer mandando un stage no-mapeado → 422 `TASK_STAGE_NOT_ELIGIBLE`.
- Config vacía → tab deshabilitado con hint; feature invisible/inerte hasta el primer mapeo (rollout aditivo, SIN feature flag —
  patrón noc-broadcast: la config gobierna la visibilidad).
- Cero regresión: segmento / manual / csv se comportan EXACTO igual (suites existentes verdes sin editar aserciones de comportamiento).

## 8. Impacted specs

- `messaging-bulk` (BE) — delta: 5to dominio `task`, wire `taskStageIds`, branch de resolución, cap, source, validación de elegibilidad, snapshot.
- `messaging-bulk-fe` (FE) — delta: tab "Tarea" (subset de mapeados, gate config-no-vacía) + counts/excluidos por fuente `task`.
- **NUEVA capability** `messaging-task-stage-config` — la tabla + CRUD de config + card de Ajustes (RBAC read/manage) — a crear en la fase de specs.
