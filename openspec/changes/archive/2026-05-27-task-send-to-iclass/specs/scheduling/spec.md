# Spec Delta: Scheduling — Enviar a IClass

**Capability**: `scheduling`
**Type**: Delta — modifica el comportamiento de `MoveTaskToStage` (`PATCH /api/scheduling/:id/stage`).
**Change**: `task-send-to-iclass`
**Routes touched**: `PATCH /api/scheduling/:id/stage` (sin cambios de URL).

---

## Modified Requirements

### REQ-MOVE-STAGE-1: Mover al stage "Enviar a IClass" dispara el alta de OS (MODIFIED)

Cuando una tarea se mueve a un stage cuyo nombre es **"Enviar a IClass"**, el comportamiento depende del flag `iclass-integration`:

- Flag **OFF** → la tarea se mueve al stage normalmente (200), SIN llamar a IClass.
- Flag **ON** → antes de mover, se valida y se crea la OS (ver REQ-MOVE-VAL-1, REQ-MOVE-OS-1).

Mover a cualquier OTRO stage MUST conservar el comportamiento actual (sin cambios).

Se agrega un campo opcional `iclassOrderCode: string | null` a la respuesta de `ScheduledTask` (poblado tras un alta exitosa; `null` en cualquier otro caso).

---

## Added Requirements

### REQ-MOVE-VAL-1: Validación de campos requeridos (para el modal del front)

Los campos requeridos para enviar a IClass son: **`customerName`, `phone`, `address`, `city`, `description`**.
Origen: `customerName`/`phone`/`city` desde el `Client` referenciado por `customerId`; `address`/`description` desde la tarea.

#### Scenario: Falta uno o más requeridos → 422 con missingFields

**Given** un `PATCH /api/scheduling/:id/stage` al stage "Enviar a IClass"
**And** el flag `iclass-integration` está ON
**And** la tarea no tiene `phone` ni `description`
**When** se procesa
**Then** MUST responder 422 con `{ code: "MISSING_REQUIRED_FIELDS", missingFields: ["phone", "description"] }`
**And** la tarea NO MUST cambiar de stage
**And** NO MUST crearse ninguna OS en IClass

#### Scenario: La tarea sin `customerId` reporta customerName/phone/city faltantes

**Given** una tarea con `customerId: null`
**When** se intenta mover a "Enviar a IClass" con el flag ON
**Then** MUST responder 422 con `missingFields` incluyendo `customerName`, `phone`, `city`

#### Scenario: Ciudad sin nodo válido en IClass → 422

**Given** todos los requeridos presentes
**And** `city` no matchea ningún nodo de IClass (REQ-OS-2)
**When** se procesa
**Then** MUST responder 422 con `{ code: "ICLASS_NODE_NOT_FOUND" }`
**And** la tarea NO MUST cambiar de stage

### REQ-MOVE-OS-1: Alta exitosa mueve a "Registrado en IClass"

#### Scenario: Datos válidos crean la OS y avanzan el stage

**Given** un `PATCH /api/scheduling/:id/stage` al stage "Enviar a IClass"
**And** el flag está ON y todos los requeridos son válidos (incluida ciudad con nodo)
**When** se procesa
**Then** MUST crearse la OS vía `IClassPort.createServiceOrder` (sin fecha)
**And** la tarea MUST quedar en el stage **"Registrado en IClass"** (NO en "Enviar a IClass")
**And** la respuesta MUST incluir `iclassOrderCode` con el código devuelto por IClass
**And** la respuesta MUST ser 200

#### Scenario: IClass no disponible no avanza el stage

**Given** los requeridos válidos pero IClass falla (REQ-OS-3)
**When** se procesa
**Then** MUST responder 502 con `{ code: "ICLASS_UNAVAILABLE" }`
**And** la tarea NO MUST cambiar de stage
**And** `iclassOrderCode` MUST permanecer `null`

### REQ-MOVE-FLAG-OFF-1: Con el flag apagado el alta se omite

#### Scenario: Flag OFF mueve sin tocar IClass

**Given** el flag `iclass-integration` en OFF
**And** un `PATCH /api/scheduling/:id/stage` al stage "Enviar a IClass" (aunque falten requeridos)
**When** se procesa
**Then** MUST responder 200 y la tarea MUST quedar en "Enviar a IClass"
**And** NO MUST llamarse a IClass ni validarse requeridos

---

## Appendix: New Error Codes

| Scenario | HTTP | `code` |
|----------|------|--------|
| Faltan requeridos | 422 | `MISSING_REQUIRED_FIELDS` (+ `missingFields[]`) |
| Ciudad sin nodo IClass | 422 | `ICLASS_NODE_NOT_FOUND` |
| IClass no disponible | 502 | `ICLASS_UNAVAILABLE` |
