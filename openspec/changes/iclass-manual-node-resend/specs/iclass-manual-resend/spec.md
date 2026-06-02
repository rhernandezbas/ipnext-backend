# Spec: IClass Manual Node Resend

**Capability**: `iclass-manual-node-resend` (NEW)
**Change**: `iclass-manual-node-resend`
**Summary**: Endpoint POST que permite a un super-admin reenviar una tarea fallida por
`ICLASS_NODE_NOT_FOUND` a IClass con un nodo elegido explicitamente (override de nodeCode).
Al exito avanza la tarea al stage `registered_in_iclass` y persiste el `iclassOrderCode`.

RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

---

## Entities modificadas / nuevas

### `CreateServiceOrderInput` (MODIFICADA — aditiva)

Se agrega el campo opcional `nodeCode`:

| Campo      | Tipo            | Descripcion                                                              |
| ---------- | --------------- | ------------------------------------------------------------------------ |
| `nodeCode` | `string?` (opt) | Override explicito del nodo IClass. Si viene, reemplaza la derivacion por `city`. |

- El campo es OPCIONAL. Cuando esta ausente, el comportamiento existente MUST
  permanecer intacto: el adapter deriva `address.nodeCode` de `input.city`.
- Cuando esta presente, el adapter MUST usar `input.nodeCode` como `address.nodeCode`
  en el payload IClass. MUST NOT derivar el valor de `city` en ese caso.
- El cambio es backward-compatible: ningun caller existente necesita cambios.

### `ResendTaskToIClassWithNodeInput` (DTO de entrada)

| Campo      | Tipo   | Restricciones        |
| ---------- | ------ | -------------------- |
| `taskId`   | string | uuid de la tarea     |
| `nodeCode` | string | requerido, no nulo   |
| `actorId`  | string | id del usuario autor |

---

## Requirements

### REQ-RESEND-1: Ruta y metodo del endpoint

El endpoint MUST ser `POST /api/scheduling/:id/iclass/resend`.

- La ruta MUST registrarse ANTES del catch-all `GET /api/scheduling/:id` en
  `scheduling.routes.ts` (el `:id` de esta ruta es el `taskId`).
- El body MUST aceptar `{ "nodeCode": string }`.
- El `actorId` MUST tomarse de `req.user.id` (usuario autenticado). MUST NOT
  aceptarse como campo del body.

#### Scenario: Ruta registrada en orden correcto

**Given** que `scheduling.routes.ts` tiene handlers antes y despues del catch-all
**When** Express recibe `POST /api/scheduling/abc-123/iclass/resend`
**Then** MUST resolverse al handler de reenvio (NO al handler generico de `/:id`)

---

### REQ-RESEND-2: Validacion del nodeCode contra la lista de nodos

El use case `ResendTaskToIClassWithNode` MUST validar que `nodeCode` exista en
`IClassPort.listNodes()` antes de crear la OS.

- La comparacion MUST ser exacta contra `IClassNode.code` (tal como lo devuelve
  el port, incluyendo mayusculas/minusculas tal cual).
- Si `nodeCode` NO existe en la lista, MUST lanzar `IClassNodeNotFoundError` con
  el nodeCode provisto. MUST NOT llamar a `createServiceOrder`.
- El intento fallido MUST persistirse como `IClassDispatchAttempt` con
  `status: "failed"`, `errorCode: "ICLASS_NODE_NOT_FOUND"`, `attemptedNodeCode`
  igual al nodeCode provisto, y `actorId` del actor (ver REQ-AUDIT-2).

#### Scenario: nodeCode valido pasa la validacion

**Given** que `listNodes()` retorna `[{ code: "Mercedes", description: "Mercedes" }]`
**And** el body del request contiene `{ "nodeCode": "Mercedes" }`
**When** el use case valida el nodeCode
**Then** MUST continuar hacia la creacion de la OS

#### Scenario: nodeCode invalido es rechazado antes de crear la OS

**Given** que `listNodes()` retorna `[{ code: "Mercedes", description: "Mercedes" }]`
**And** el body del request contiene `{ "nodeCode": "Lujan" }`
**When** el use case valida el nodeCode
**Then** MUST lanzar `IClassNodeNotFoundError`
**And** `createServiceOrder` MUST NOT ser llamado
**And** MUST persistirse un `IClassDispatchAttempt` de fallo (REQ-AUDIT-2)
**And** la respuesta HTTP MUST ser 422 `{ "code": "ICLASS_NODE_NOT_FOUND" }`

---

### REQ-RESEND-3: Override del nodeCode en la creacion de la OS

Cuando el nodeCode es valido, el use case MUST llamar a `createServiceOrder` con
`input.nodeCode` igual al nodeCode provisto.

- El resto de los campos de `CreateServiceOrderInput` MUST derivarse de la tarea
  y su proyecto/mapping, identico a como lo hace `SendTaskToIClass`. MUST NOT
  permitirse override de ningun otro campo de la OS via este endpoint.
- El adapter MUST usar `input.nodeCode` como `address.nodeCode` en el payload
  (DEBE ignorar `input.city` para el nodeCode en este caso). Ver modificacion
  aditiva de `CreateServiceOrderInput`.

#### Scenario: Override de nodeCode viaja al adapter

**Given** un `CreateServiceOrderInput` con `city: "Mercedes"` y `nodeCode: "Lujan"`
**When** el adapter construye el payload IClass
**Then** `address.nodeCode` MUST ser `"Lujan"` (el override)
**And** MUST NOT ser `"Mercedes"` (la city)

#### Scenario: Sin override el comportamiento existente es intacto

**Given** un `CreateServiceOrderInput` con `city: "Mercedes"` y sin `nodeCode`
**When** el adapter construye el payload IClass
**Then** `address.nodeCode` MUST ser `"Mercedes"` (derivado de city, sin cambios)

---

### REQ-RESEND-4: Exito — avance de stage y persistencia del orderCode

Cuando `createServiceOrder` retorna exitosamente, el use case MUST:

1. Llamar a `setIClassOrderCode(taskId, orderCode)` para persistir el codigo de OS.
2. Mover la tarea al stage resuelto por `getStageByCode("registered_in_iclass", workflowId)`.
3. Persistir un `IClassDispatchAttempt` con `status: "success"` (ver REQ-AUDIT-2).

- Si `getStageByCode("registered_in_iclass", workflowId)` retorna `null`, MUST
  lanzar `StageNotFoundError`. El `iclassOrderCode` ya fue persistido (no se
  revierte — mismo comportamiento que `SendTaskToIClass`).
- La respuesta HTTP al caller MUST ser 200 con el DTO de la tarea actualizada.

#### Scenario: Envio exitoso avanza la tarea al stage registered_in_iclass

**Given** un usuario con permiso `scheduling.iclass_manual_resend`
**And** una tarea `taskId` en stage `send_to_iclass`, sin `iclassOrderCode`
**And** `nodeCode: "Mercedes"` existe en `listNodes()`
**And** IClass responde con `{ orderCode: "OS-9999" }`
**When** `POST /api/scheduling/:id/iclass/resend` con `{ "nodeCode": "Mercedes" }`
**Then** la respuesta MUST ser 200
**And** la tarea MUST tener `iclassOrderCode: "OS-9999"`
**And** la tarea MUST estar en el stage con `code: "registered_in_iclass"`
**And** MUST existir un `IClassDispatchAttempt` con `status: "success"` para esta tarea

---

### REQ-RESEND-5: Idempotencia — tarea que ya tiene iclassOrderCode

Si la tarea ya tiene un `iclassOrderCode` no nulo, el use case MUST retornar la
tarea tal como esta (DTO) sin llamar a `createServiceOrder`, sin crear un nuevo
`IClassDispatchAttempt`, y sin mover el stage.

- La respuesta HTTP MUST ser 200 con el DTO de la tarea (sin cambios).
- MUST NOT crearse una OS duplicada en IClass.

#### Scenario: Reenvio idempotente cuando ya tiene orderCode

**Given** una tarea con `iclassOrderCode: "OS-8888"` ya asignado
**When** `POST /api/scheduling/:id/iclass/resend` con `{ "nodeCode": "Mercedes" }`
**Then** la respuesta MUST ser 200 con la tarea en su estado actual
**And** `createServiceOrder` MUST NOT ser llamado
**And** `iclassOrderCode` MUST seguir siendo `"OS-8888"` (sin cambios)
**And** MUST NOT crearse ningun `IClassDispatchAttempt` nuevo

---

### REQ-RESEND-6: Errores de IClass durante el reenvio

Si `createServiceOrder` falla por rechazo o indisponibilidad de IClass:

- `IClassRejectedError` (IClass responde con `erros`): MUST persistirse un
  `IClassDispatchAttempt` con `status: "failed"`, `errorCode: "ICLASS_REJECTED"`,
  `errorMessage` con el detalle de `erros`. MUST relanzarse el error para que
  el `errorHandler` lo mapee a 422 `ICLASS_REJECTED`.
- `IClassUnavailableError` (5xx/transporte): MUST persistirse un
  `IClassDispatchAttempt` con `status: "failed"`, `errorCode: "ICLASS_UNAVAILABLE"`.
  MUST relanzarse para que el `errorHandler` lo mapee a 502 `ICLASS_UNAVAILABLE`.

En ambos casos el `actorId` MUST estar en el attempt (usuario que disparo el reenvio).

#### Scenario: IClass rechaza la OS durante el reenvio

**Given** un nodeCode valido y todos los campos de la OS correctos
**And** IClass responde con `erros: [{ code: "ICLERR_0010", description: "..." }]`
**When** `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 422 con `{ "code": "ICLASS_REJECTED", "reason": "..." }`
**And** MUST existir un `IClassDispatchAttempt` con `status: "failed"` y `errorCode: "ICLASS_REJECTED"`
**And** la tarea MUST permanecer en su stage actual sin cambios en `iclassOrderCode`

#### Scenario: IClass no disponible durante el reenvio

**Given** un nodeCode valido
**And** IClass responde 5xx o falla la conexion
**When** `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 502 con `{ "code": "ICLASS_UNAVAILABLE" }`
**And** MUST existir un `IClassDispatchAttempt` con `status: "failed"` y `errorCode: "ICLASS_UNAVAILABLE"`

---

### REQ-RESEND-7: Tarea no encontrada

Si el `taskId` no existe en el repositorio, el use case MUST lanzar `TaskNotFoundError`.
La respuesta HTTP MUST ser 404.

#### Scenario: Task inexistente retorna 404

**Given** un `taskId` que no existe en el repositorio
**When** `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 404

---

### REQ-RESEND-8: Validacion de requeridos y mapping del proyecto

El use case MUST reusar la misma logica de validacion de campos requeridos y
mapping de proyecto que usa `SendTaskToIClass`.

- Si la tarea no tiene proyecto asignado (`projectId` nulo), MUST lanzar el error
  de dominio correspondiente (mismo que en `SendTaskToIClass`).
- Si el proyecto no tiene mapping IClass configurado, MUST lanzar
  `MissingIClassMappingError` (o el error equivalente del dominio).
- Estos errores MUST burbujear al `errorHandler` y mapearse a 422.
- MUST NOT duplicar la logica de validacion: extraer a un colaborador o funcion
  compartida si no existe ya.

#### Scenario: Tarea sin proyecto retorna 422

**Given** una tarea sin `projectId`
**When** `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 422 (el errorHandler mapea el error de dominio)

#### Scenario: Proyecto sin mapping IClass retorna 422

**Given** una tarea con proyecto pero sin mapping de IClass configurado
**When** `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 422

---

### REQ-RESEND-9: Autenticacion y permiso requeridos

El endpoint MUST aplicar `auth` y `requirePerm('scheduling', 'iclass_manual_resend')`
en ese orden.

#### Scenario: Sin token recibe 401

**Given** una request sin cookie `auth_token`
**When** `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 401

#### Scenario: Sin permiso recibe 403

**Given** un usuario autenticado sin permiso `scheduling.iclass_manual_resend`
**When** `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 403

---

### REQ-RESEND-10: Use case `ResendTaskToIClassWithNode` es parte de application layer

El use case MUST vivir en `src/application/use-cases/ResendTaskToIClassWithNode.ts`.

- MUST depender solo de ports de dominio: `SchedulingRepository`, `IClassPort`,
  `IClassDispatchAttemptRepository`. MUST NOT importar de `@infrastructure/*`
  ni de Prisma.
- Su firma MUST ser equivalente a:

```ts
class ResendTaskToIClassWithNode {
  constructor(
    private tasks: SchedulingRepository,
    private iclass: IClassPort,
    private attempts: IClassDispatchAttemptRepository,
  ) {}
  async execute(input: ResendTaskToIClassWithNodeInput): Promise<TaskDTO>
}
```

#### Scenario: tsc --noEmit pasa con 0 errores

**Given** el use case implementado segun este requisito
**When** `tsc --noEmit` se ejecuta
**Then** MUST emitir 0 errores de compilacion

---

## Appendix: Codigos de error HTTP

| Condicion                                      | HTTP | `code`                    |
| ---------------------------------------------- | ---- | ------------------------- |
| Sin token                                      | 401  | `NO_USER_CONTEXT`         |
| Sin permiso `scheduling.iclass_manual_resend`  | 403  | `PERMISSION_DENIED`       |
| Tarea no encontrada                            | 404  | `TASK_NOT_FOUND`          |
| nodeCode invalido (no en listNodes)            | 422  | `ICLASS_NODE_NOT_FOUND`   |
| Campos requeridos faltantes (mapping/proyecto) | 422  | `MISSING_REQUIRED_FIELDS` |
| IClass rechaza la OS                           | 422  | `ICLASS_REJECTED`         |
| IClass no disponible                           | 502  | `ICLASS_UNAVAILABLE`      |
