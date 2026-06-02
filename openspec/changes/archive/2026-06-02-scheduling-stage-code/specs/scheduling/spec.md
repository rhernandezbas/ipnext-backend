# Spec Delta: Scheduling — Stage por Code (rename-safe)

**Capability**: `scheduling` (DELTA — modifica requisitos existentes)
**Change**: `scheduling-stage-code`
**Resumen**: Reexpresa los requisitos de `MoveTaskToStage`, `SendTaskToIClass`, `BackfillClosedServiceOrders` y el bootstrap de Gestion Real en terminos de `Stage.code`. No cambia el comportamiento observable; elimina la dependencia fragil del `name` como identidad de negocio.

RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

---

## Modified Requirements

### REQ-MOVE-STAGE-1 (MODIFICA spec task-send-to-iclass): Deteccion del stage IClass por `code`

El use case `MoveTaskToStage` MUST detectar el stage "Enviar a IClass" comparando `stage.code === "send_to_iclass"`. MUST NOT comparar por `stage.name`.

El comportamiento observable (flag ON/OFF, validacion de requeridos, alta de OS, avance a "Registrado en IClass") MUST ser identico al especificado en la spec `task-send-to-iclass` (`REQ-MOVE-STAGE-1`, `REQ-MOVE-VAL-1`, `REQ-MOVE-OS-1`, `REQ-MOVE-FLAG-OFF-1`).

#### Scenario: Deteccion por code, no por name

**Given** un stage con `code: "send_to_iclass"` y `name: "Despachar a IClass"` (name renombrado)
**And** el flag `iclass-integration` esta ON
**When** `MoveTaskToStage` evalua si debe disparar la integracion IClass
**Then** MUST detectar el stage como destino IClass (compara `code`)
**And** MUST ejecutar la validacion de requeridos y el alta de OS

#### Scenario: Stage con name viejo pero code correcto funciona igual

**Given** un stage con `code: "send_to_iclass"` y `name: "Enviar a IClass"` (name original)
**When** `MoveTaskToStage` procesa el movimiento con flag ON
**Then** el comportamiento MUST ser identico al escenario anterior

---

### REQ-MOVE-OS-1 (MODIFICA spec task-send-to-iclass): Avance a stage `registered_in_iclass` por code

Tras un alta exitosa de OS en IClass, `MoveTaskToStage` MUST mover la tarea al stage resuelto por `getStageByCode("registered_in_iclass", workflowId)`. MUST NOT buscar el stage de destino por `name: "Registrado en IClass"`.

#### Scenario: Alta exitosa avanza al stage por code

**Given** todos los requeridos validos y IClass responde con `orderCode`
**When** `MoveTaskToStage` procesa el alta
**Then** la tarea MUST quedar en el stage con `code: "registered_in_iclass"` del workflow
**And** si ese stage no existe en el workflow (null), MUST lanzar un error de dominio `StageNotFoundError`

#### Scenario: Stage registered_in_iclass no existe en el workflow

**Given** un workflow que no tiene ningun stage con `code: "registered_in_iclass"`
**And** el alta de OS en IClass es exitosa
**When** `MoveTaskToStage` intenta mover la tarea
**Then** MUST lanzar `StageNotFoundError` con `code: "registered_in_iclass"`
**And** la tarea MUST permanecer en su stage actual
**And** `iclassOrderCode` MUST quedar como esta (no se revierte la llamada a IClass — el error es de configuracion del workflow)

---

### REQ-BACKFILL-STAGE-1 (MODIFICA spec scheduling-hardening si existe): BackfillClosedServiceOrders por code

El use case `BackfillClosedServiceOrders` MUST resolver el stage "en vuelo" (stage al que se mueven las OS cerradas durante el backfill) via `getStageByCode(code, workflowId)`. MUST NOT usar `getStageByName`.

El `code` concreto a resolver DEBE documentarse en la implementacion como constante nombrada (ej. `REGISTERED_IN_ICLASS_CODE = "registered_in_iclass"`).

#### Scenario: Backfill resuelve stage por code

**Given** un workflow con el stage `code: "registered_in_iclass"` (independientemente de su name)
**When** `BackfillClosedServiceOrders` se ejecuta
**Then** MUST resolver el stage via `getStageByCode("registered_in_iclass", workflowId)`
**And** las tareas del backfill MUST moverse a ese stage

---

### REQ-INGEST-STAGE-1 (MODIFICA bootstrapGestionRealIngest): Bootstrap de GR por code

El modulo `bootstrapGestionRealIngest.ts` MUST resolver el stage inicial de ingest (actualmente "Pendiente") via `getStageByCode` con el code correspondiente. MUST NOT resolver por `name`.

El code a usar MUST ser el slug del name actual: si el stage se llama "Pendiente" su code es `pendiente`; si se llama distinto, el code es su slug. La constante MUST ser nombrada (ej. `PENDING_STAGE_CODE`).

#### Scenario: Ingest de GR resuelve stage inicial por code

**Given** un workflow con el stage `code: "pendiente"` (o el code que corresponda al stage de entrada de GR)
**When** `bootstrapGestionRealIngest` se ejecuta
**Then** MUST resolver el stage via `getStageByCode`
**And** MUST NOT contener el literal `"Pendiente"` (ni ningun nombre de stage) como string hardcodeado

---

## Added Requirements

### REQ-LIST-ICLASS-1: `listTasksInIClassStage` recibe `code`, no `name`

El metodo `listTasksInIClassStage` del port `SchedulingRepository` MUST recibir un parametro `stageCode: string` en lugar del `stageName: string` anterior. Los adapters Prisma e InMemory MUST filtrar por `Stage.code`.

#### Scenario: Listado filtra por code del stage

**Given** tasks en el stage con `code: "registered_in_iclass"` y `name: "En IClass (confirmado)"` (renombrado)
**When** `listTasksInIClassStage("registered_in_iclass", workflowId)` es llamado
**Then** MUST retornar esas tasks correctamente
**And** el cambio de name MUST NOT afectar el resultado

---

## Appendix: Mapa de cambios de referencia

| Archivo | Antes (por name) | Despues (por code) |
|---------|-----------------|-------------------|
| `SendTaskToIClass.ts` | `REGISTRADO_STAGE_NAME = "Registrado en IClass"` | `REGISTERED_IN_ICLASS_CODE = "registered_in_iclass"` |
| `MoveTaskToStage.ts` | `ENVIAR_A_ICLASS_STAGE_NAME = "Enviar a IClass"` | `SEND_TO_ICLASS_CODE = "send_to_iclass"` |
| `BackfillClosedServiceOrders.ts` | `getStageByName("Registrado en IClass", wfId)` | `getStageByCode("registered_in_iclass", wfId)` |
| `bootstrapGestionRealIngest.ts` | `getStageByName("Pendiente", wfId)` | `getStageByCode("pendiente", wfId)` |
| `SchedulingRepository` port | `listTasksInIClassStage(stageName, wfId)` | `listTasksInIClassStage(stageCode, wfId)` |
