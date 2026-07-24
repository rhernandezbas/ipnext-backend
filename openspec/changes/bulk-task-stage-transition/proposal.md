# Proposal — bulk-task-stage-transition (EPIC Mensajería WhatsApp · transición de estado de tarea al enviar)

## 1. Why / Intent

El Bulk WhatsApp ya tiene un 5to dominio de destinatarios, **Tarea** (`bulk-task-recipients`, en prod 2026-07-22): el operador
mapea estados (`Stage`) elegibles en la Config y el composer selecciona los clientes con ≥1 tarea ABIERTA en esos estados.
Hoy el `Stage` es **SOLO un filtro de a quién se le manda** — el envío es un snapshot inmutable (spec `bulk-task-recipients`
TASK-8) y `SendCampaign` NUNCA toca la tarea (verificado: solo muta `CampaignRecipient.status` y `Campaign.status`).

**Falta el cierre del ciclo: cuando el aviso SALE, la tarea debería AVANZAR de estado.** El operador manda "avisamos que
tenés turno" y quiere que la tarea pase de `Pendiente de aviso` → `Avisado`, sin entrar tarea por tarea a moverla a mano.
Es el patrón "acción de mensajería que promueve la gestión" — el estado de la tarea refleja que el contacto ya se hizo.

**Decisiones de producto YA tomadas** (usuario, 2026-07-24, engram `messaging/bulk-task-stage-transition` — NO re-abrir):

- **(1) Momento — POR DESTINATARIO, al salir `sent`.** La transición ocurre en el instante en que el mensaje de ESE
  destinatario se acepta (`sent`), no al `done` de la campaña ni por un botón manual. Un envío `failed`/`skipped`/`opted_out`
  **NO** mueve la tarea (se queda en el estado de origen).
- **(2) Granularidad — POR TAREA, no por cliente.** El modelo mental del operador es "envío por la tarea 10", no "por el
  cliente". Hoy el dominio task resuelve `clientId` DISTINCT (colapsa las tareas del cliente en un destinatario). Este change
  **reforma el dominio task a per-tarea**: cada tarea abierta en un estado elegido genera SU destinatario.
- **(3) Una tarea = un mensaje = una transición.** Un cliente con la tarea 10 y la tarea 11, ambas en un estado elegido de
  la MISMA campaña, recibe **2 WhatsApp** y sus 2 tareas transicionan por separado. **El usuario aceptó explícitamente**
  varios mensajes al mismo cliente (incluso el mismo template al mismo número).
- **(4) Aislamiento.** Solo la tarea por la que salió el mensaje cambia de estado; el resto de las tareas del cliente
  quedan intactas.
- **(5) Estado resultante — UNO SOLO GLOBAL en la Config.** NO es una matriz A→B por par. En Config→WhatsApp hay **un único
  estado resultante B**; toda tarea que sale `sent`, venga del estado elegible que venga, transiciona a ESE único B.
  Patrón singleton (molde `NocBroadcastConfig`), no un destino por origen.
- **(6) Guard — solo mover si la tarea SIGUE en su estado de origen A.** Si entre el create y el send un humano movió la
  tarea a otro estado, la transición **NO** la toca (respeta la intervención manual). Requiere snapshotear el estado de
  origen `fromStageId` POR TAREA para poder comparar al enviar.
- **(7) `send_to_iclass` BLOQUEADO como destino.** El estado resultante NO puede ser el stage `send_to_iclass` (crearía una
  Orden de Servicio en IClass por cada tarea enviada). Se valida al guardar la Config Y defensivamente al enviar.

## 2. Scope IN

### BE

1. **Config singleton `resultingStageId`** — el estado resultante B es **uno solo** (decisión 5). Patrón singleton molde
   `NocBroadcastConfig`: una fila con `resultingStageId String?` (FK a `Stage`, `onDelete: SetNull` — si se borra el stage
   destino, la config sobrevive sin transición). `null` = no hay B configurado → **ninguna** tarea transiciona (el bulk
   task sigue funcionando como hoy, solo filtro). **Validación al guardar:** rechazar si el `resultingStageId` apunta a un
   stage con `code = 'send_to_iclass'` (decisión 7) → typed error → 422. A decidir en design: tabla singleton nueva
   `WhatsappTaskStageTransitionConfig` vs. extender el CRUD existente de `WhatsappTaskStageRecipientConfig`. El port
   `TaskStageRecipientConfigRepository` (o uno nuevo `TaskStageTransitionConfigRepository`) expone
   `getResultingStageId()` / `setResultingStageId(stageId | null)`. Adapter Prisma + in-memory.

2. **Método per-tarea en `TaskRecipientSource`** — nuevo
   `listOpenTasksByStages(stageIds: string[]): Promise<{ taskId, clientId, fromStageId }[]>` que devuelve UNA fila POR TAREA
   abierta (`generalStatus = 'open'`, `customerId != null`) en los stages pedidos — NO `clientId` DISTINCT. Se **conserva**
   `listClientIdsByOpenTaskStages` (lo usa el preview/count actual, ver §6 preview) y `countOpenTasksWithoutCustomer`
   (chip de red). Adapter Prisma + in-memory. Índice a evaluar en design: `(stageId, generalStatus, customerId)`.

3. **`taskId` + snapshots en `CampaignRecipient`** — columnas nuevas (SOLO pobladas en filas `source:'task'`):
   - `taskId String?` (FK a `ScheduledTask`, `onDelete: SetNull`) — la tarea por la que salió el mensaje.
   - `taskFromStageId String?` — **snapshot del estado de origen A** al create (para el guard de la decisión 6:
     "¿la tarea SIGUE en A al enviar?").
   - `taskResultingStageId String?` — **snapshot del destino B** al create (congela el mapeo; si la config cambia entre
     create y send, el envío usa el snapshot — consistente con TASK-8). `null` = no había B configurado → no transiciona.
   - Migración: **romper `@@unique([campaignId, clientId])`**. Un cliente ahora puede aparecer N veces (una por tarea). La
     nueva idempotencia del dominio task = `@@unique([campaignId, taskId])` **PARCIAL** (`WHERE taskId IS NOT NULL`), sin
     tocar el dedup por cliente de los otros dominios. **Change destructivo → migración escrita a mano, transaccional, con
     guard + backup, revisada con el usuario ANTES del push** (regla del workflow).

4. **Branch task per-tarea en `resolveCombinedRecipients`** — reemplaza la resolución `clientId` DISTINCT del dominio task
   por la per-tarea: cada `{taskId, clientId, fromStageId}` se hidrata (reusa `findRecipientCandidatesByIds` por el
   `clientId`) y se materializa como un recipient con `source:'task'` + `taskId` + `taskFromStageId` +
   `taskResultingStageId` (snapshot del B global, `null` si no hay B). **El dedup por teléfono se DESACTIVA dentro del
   dominio task** (si no, la 2da tarea del mismo cliente/mismo teléfono se colapsaría — contradice la decisión 3). El
   overlap con los otros 4 dominios se mantiene: si el cliente ya fue admitido por segmento/manual/csv, sus tareas **no**
   generan mensajes task (precedencia segmento > manual > csv > task intacta → cero regresión). La transición dispara SOLO
   para recipients cuyo `source` final es `task`.

5. **Efecto post-`sent` en `SendCampaign`** — tras `persistRecipientSent`, un tercer efecto **aislado y best-effort** (molde
   EXACTO de `projectToInbox`/`applyChatwootLabel`): si `recipient.taskId != null` Y `recipient.taskResultingStageId != null`:
   - **Guard decisión 6:** leer la tarea; si su `stageId` actual **≠** `recipient.taskFromStageId` (un humano la movió) →
     **no-op** (se loguea, no es error).
   - Si sigue en A → `MoveTaskToStage.execute(taskId, taskResultingStageId, SYSTEM_ACTOR)`.
   - **Guard defensivo decisión 7:** si el stage destino resultara `send_to_iclass` (config vieja / carrera), **abortar el
     move** (no crear OS) y loguear. La validación primaria está al guardar la config.
   - **Un fallo se loguea y se traga — JAMÁS re-marca `failed`** (re-marcar volvería re-enviable al destinatario ya `sent`).
     `MoveTaskToStage` ya registra `stage_changed` en el feed con el actor → rastro auditable ("movida por el envío bulk").

6. **Preview honesto** — el preview del composer refleja la nueva granularidad: cuenta TAREAS (no clientes) del dominio
   task, y muestra cuántas transicionarán (hay B configurado y la tarea está en A) vs. cuántas solo reciben el mensaje.

### FE

7. **Card "Estados de tarea para envíos" (Config→WhatsApp) extendida** — un selector ÚNICO de "estado resultante" (un
   `Select` propio del design system, agrupado por workflow), OPCIONAL (se puede dejar sin B → no transiciona). El picker
   **excluye** el stage `send_to_iclass` (decisión 7). Confirm danger al cambiar/quitar el destino. Gate `messaging.manage`
   para editar, `messaging.read`+`scheduling.read` para ver el catálogo.

8. **Composer / PreviewModal** — el tab "Tarea" y el preview muestran el conteo por TAREA + el hint de cuántas avanzan de
   estado. Sin rediseño estructural — extiende lo que ya paginó `bulk-csv-recipients`.

## 3. Scope OUT

- **Matriz A→B por par** (un destino por origen) — descartada por la decisión 5 (un único B global).
- **Transición al `done` de la campaña o manual** — descartada por la decisión 1 (por-destinatario al `sent`).
- **Mover TODAS las tareas del cliente con un solo mensaje** — descartada por la decisión 3 (per-tarea explícito).
- **Forzar el destino aunque la tarea ya no esté en A** — descartada por la decisión 6 (guard still-in-A).
- **`send_to_iclass` como destino** — descartado por la decisión 7.
- **Ventana temporal / tareas cerradas** — se mantiene `generalStatus = 'open'` (Scope OUT de `bulk-task-recipients`).
- **Transición para recipients de segmento/manual/csv** — NO: solo `source:'task'` transiciona.
- **Rediseño del composer / de la card de Config** — corre en otro change; acá solo se extiende con el campo destino.

## 4. Approach (resumen — detalle en design.md)

- **Datos**: config singleton `resultingStageId` (aditivo, FK SetNull, valida no-`send_to_iclass`). `CampaignRecipient` +
  `taskId`/`taskFromStageId`/`taskResultingStageId` + reforma del `@@unique` a parcial por `taskId` (destructivo, migración
  a mano revisada con el usuario).
- **Resolución**: `resolveCombinedRecipients` — el branch task pasa de `clientId` DISTINCT a per-tarea, sin dedup de
  teléfono interno, con snapshot de A (origen) y B (destino global). Los otros 4 dominios byte-idénticos.
- **Envío**: `SendCampaign` gana un efecto aislado post-`sent` que, con guard still-in-A + guard anti-`send_to_iclass`,
  reusa `MoveTaskToStage`. Idempotente/resumible.
- **Reuso**: `MoveTaskToStage` (existente, con `stage_changed`), `findRecipientCandidatesByIds` (hidratación), el patrón de
  efectos aislados de `SendCampaign`, el patrón singleton de `NocBroadcastConfig`.
- **RBAC**: sin permiso nuevo — editar el destino B = `messaging.manage`; mover la tarea lo hace el sistema (SYSTEM_ACTOR).

## 5. Validaciones cruzadas y decisiones de borde

| Caso | Resolución |
|---|---|
| Cliente con tarea 10 y 11, ambas en un estado elegido de la misma campaña | 2 recipients `source:'task'` (uno por tarea), 2 WhatsApp, 2 transiciones independientes (decisión 3). |
| Solo la tarea 10 califica (la 11 está en otro estado no elegido) | 1 recipient por la tarea 10; la 11 ni se toca. |
| No hay `resultingStageId` (B) configurado | El mensaje SALE igual, ninguna tarea transiciona (config sin B = solo filtro, comportamiento actual). |
| El B configurado cambia entre create y send | **Sin efecto** — B se congela en `taskResultingStageId` al create (snapshot, consistente con TASK-8). |
| Un humano mueve la tarea de A a otro estado entre create y send | **No-op** — el guard compara el `stageId` actual vs. `taskFromStageId`; si difiere, no se toca (decisión 6). |
| El envío falla (`failed`/`skipped`/`opted_out`) | La tarea NO transiciona (efecto solo tras `sent`). |
| `MoveTaskToStage` falla (DB, stage borrado) | Best-effort aislado: se loguea, el `sent` queda, la campaña sigue. Nunca re-marca `failed`. |
| Intentar mapear B = `send_to_iclass` en la Config | Rechazado al guardar (422); guard defensivo también en el send (decisión 7). |
| Cliente resuelto por segmento QUE ADEMÁS tiene tareas abiertas en un estado elegido | Gana segmento (precedencia); sus tareas NO transicionan (no hay recipient `source:'task'` para él). |

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Migración destructiva** del `@@unique([campaignId, clientId])` sobre datos de campañas en prod | Migración a mano, transaccional, con guard + backup, **revisada con el usuario ANTES del push**. Unique PARCIAL `WHERE taskId IS NOT NULL` para no tocar el dedup de los otros dominios. Dry-run rolled-back vs. prod. |
| Spam real: 2+ WhatsApp idénticos al mismo número si el cliente tiene varias tareas | Decisión explícita del usuario (aceptada). El preview muestra el conteo REAL de mensajes antes de crear. |
| Efecto post-`sent` que muta scheduling desde messaging (acoplamiento de dominios) | Se hace por `MoveTaskToStage` (puerto de scheduling), aislado y best-effort — messaging NO conoce el modelo de scheduling, solo invoca el use case ya existente. |
| Reforma per-tarea rompe la cobertura de `bulk-task-recipients` | Los tests de los otros 4 dominios NO se tocan (cero regresión); el suite del dominio task se reescribe a per-tarea. Review adversarial con foco en snapshot/idempotencia/guard. |
| Guard still-in-A: leer la tarea al send agrega una query por recipient task | Aceptable (el envío es serial y domina el rate-limit de Twilio, no las queries). A optimizar solo si mide. |
| Resume: una corrida interrumpida re-procesa recipients `failed`/`queued` — ¿re-dispara la transición? | La transición va atada al `sent` (terminal); un `sent` no se re-procesa (SEND-6). Un `failed` reintentado que sale `sent` transiciona una vez. `MoveTaskToStage` idempotente + guard still-in-A como red de seguridad. |

## 7. Success criteria

- Campaña solo-tarea con B configurado: cada tarea que sale `sent` (y sigue en A) queda en B; el feed muestra
  `stage_changed` con el actor sistema. Un envío `failed` deja la tarea en A. Una tarea movida a mano a otro estado queda
  donde el humano la puso.
- Cliente con 2 tareas en el estado elegido → 2 recipients, 2 mensajes, 2 transiciones independientes (test de use case
  in-memory + seam supertest).
- Sin B configurado → mensajes salen, ninguna tarea se mueve.
- B cambia después del create → el envío usa el snapshot (sin efecto).
- Intentar B = `send_to_iclass` → rechazado al guardar.
- Cero regresión: segmento / manual / csv se comportan EXACTO igual; sus recipients NUNCA transicionan tareas.
- Migración destructiva del `@@unique` aplicada con dry-run rolled-back vs. prod ANTES del deploy.

## 8. Impacted specs

- `messaging-task-stage-config` (BE) — delta: config singleton `resultingStageId` (validada no-`send_to_iclass`) + su CRUD.
- `messaging-bulk` (BE) — delta: dominio task per-tarea, `taskId`/`taskFromStageId`/`taskResultingStageId` en el recipient,
  efecto de transición post-`sent` con guard still-in-A, reforma del `@@unique`.
- `messaging-bulk-fe` (FE) — delta: selector único de estado resultante en la card de Config (excluye `send_to_iclass`) +
  conteo por-tarea en el preview.
