# Spec: IClass Dispatch Audit

**Capability**: `iclass-dispatch-audit` (NEW)
**Change**: `iclass-manual-node-resend`
**Summary**: Modelo `IClassDispatchAttempt` que registra cada intento de envio a IClass
(fallo y exito), tanto en el envio normal (`SendTaskToIClass`) como en el reenvio manual
(`ResendTaskToIClassWithNode`). Provee historial auditable por tarea.

RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

---

## Entities

### `IClassDispatchAttempt` (NEW)

| Campo               | Tipo               | Restricciones                                         |
| ------------------- | ------------------ | ----------------------------------------------------- |
| `id`                | string             | uuid, PK, auto-generado                               |
| `taskId`            | string             | FK -> `ScheduledTask.id`, NOT NULL, indice            |
| `status`            | enum               | `"failed"` \| `"success"`, NOT NULL                   |
| `errorCode`         | `string?`          | Codigo del error de dominio (ej. `ICLASS_NODE_NOT_FOUND`); null en exito |
| `errorMessage`      | `string?`          | Mensaje descriptivo del error; null en exito          |
| `attemptedNodeCode` | `string?`          | Nodo con el que se intento el envio; null si fallo antes de conocer el nodo |
| `resolvedNodeCode`  | `string?`          | Nodo elegido en el reenvio manual; null en envio normal |
| `actorId`           | `string?`          | FK a `RbacUser.id`; null en el fallo automatico del envio normal |
| `createdAt`         | DateTime           | timestamp de creacion, indice                         |

Notas de modelado:
- `attemptedNodeCode` y `resolvedNodeCode` son complementarios: en el envio normal
  (derivado por city) `attemptedNodeCode` puede ser null (fallo antes de resolver
  el nodo) o tener el city usado; en el reenvio manual `resolvedNodeCode` MUST
  tener el nodeCode elegido.
- El schema Prisma MUST declarar `@@index([taskId])` y `@@index([createdAt])`.
- `onDelete: Cascade` en la FK `taskId` (si se borra la tarea, se borran sus attempts).

---

## Requirements

### REQ-AUDIT-1: Schema Prisma y migration aditiva

El schema `prisma/schema.prisma` MUST agregar el modelo `IClassDispatchAttempt`
con todos los campos de la entidad. La migration MUST ser aditiva (solo CREATE TABLE,
FK, indices). MUST NOT modificar tablas existentes.

- El timestamp de la migration MUST ser posterior a `20260603000000`.
- La migration MUST poder ejecutarse con `prisma migrate deploy` (sin `migrate dev`
  en produccion).
- `ScheduledTask` MUST recibir la back-relation correspondiente en el schema.

#### Scenario: Migration aditiva no rompe tablas existentes

**Given** una base de datos con el schema actual (sin `IClassDispatchAttempt`)
**When** la migration se ejecuta
**Then** MUST crearse la tabla `IClassDispatchAttempt` con todos sus campos e indices
**And** MUST NOT alterarse ninguna tabla existente (solo CREATE TABLE + ADD FOREIGN KEY)
**And** `prisma migrate deploy` MUST completar sin errores

#### Scenario: Migration es idempotente en CI

**Given** la migration ya ejecutada en la base de datos
**When** `prisma migrate deploy` se ejecuta nuevamente
**Then** MUST detectar la migration como ya aplicada y NO volver a ejecutarla

---

### REQ-AUDIT-2: Entidad de dominio y port de persistencia

MUST existir la entidad de dominio `IClassDispatchAttempt` en
`src/domain/entities/iclass-dispatch-attempt.ts` con los campos tipados del modelo.

MUST existir el port `IClassDispatchAttemptRepository` en
`src/domain/ports/IClassDispatchAttemptRepository.ts` con:

```ts
interface IClassDispatchAttemptRepository {
  save(attempt: IClassDispatchAttempt): Promise<void>;
  listByTask(taskId: string): Promise<IClassDispatchAttempt[]>;
}
```

- `save` MUST persistir un nuevo attempt (insert, no upsert). MUST NOT actualizar
  attempts existentes.
- `listByTask` MUST retornar todos los attempts de una tarea ordenados por
  `createdAt` ASC.
- Los use cases MUST depender de este port. MUST NOT importar Prisma directamente.

#### Scenario: save persiste un attempt de fallo

**Given** un `IClassDispatchAttempt` con `status: "failed"`, `taskId`, `errorCode: "ICLASS_NODE_NOT_FOUND"`
**When** `repository.save(attempt)` se llama
**Then** el attempt MUST persistirse en la base de datos
**And** `listByTask(taskId)` MUST retornar ese attempt

#### Scenario: listByTask retorna attempts en orden cronologico

**Given** tres attempts para la misma tarea creados en tiempos t1 < t2 < t3
**When** `listByTask(taskId)` se llama
**Then** MUST retornar los tres attempts en orden `[t1, t2, t3]` (ASC por createdAt)

---

### REQ-AUDIT-3: Adapters Prisma e InMemory

MUST existir:
- `PrismaIClassDispatchAttemptRepository` en
  `src/infrastructure/adapters/prisma/PrismaIClassDispatchAttemptRepository.ts`
- `InMemoryIClassDispatchAttemptRepository` en
  `src/infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository.ts`

Ambos MUST implementar `IClassDispatchAttemptRepository`.
Los tests de use case MUST usar el adapter in-memory (MUST NOT mockear Prisma directamente).

#### Scenario: InMemory implementa el contrato del port

**Given** un `InMemoryIClassDispatchAttemptRepository` vacio
**When** `save(attempt)` y luego `listByTask(attempt.taskId)` se llaman
**Then** `listByTask` MUST retornar exactamente el attempt guardado

---

### REQ-AUDIT-4: Registro en el envio normal (`SendTaskToIClass`) SOLO en fallos

Cuando `SendTaskToIClass` falla por cualquier error de IClass (NodeNotFound,
Rejected o Unavailable), MUST persistir un `IClassDispatchAttempt`. El EXITO del
envio normal MUST NOT registrar ningun attempt.

**Fallo por nodo no encontrado** (`IClassNodeNotFoundError`):
- `taskId`: el id de la tarea
- `status: "failed"`
- `errorCode: "ICLASS_NODE_NOT_FOUND"`
- `errorMessage`: mensaje descriptivo (ej. `"No IClass node found for city: Lujan"`)
- `attemptedNodeCode: null` (no se pudo resolver el nodo desde la city)
- `resolvedNodeCode: null`
- `actorId`: el id del usuario que movio la tarea al stage `send_to_iclass`
- `createdAt`: timestamp del momento del fallo

**Fallo por rechazo de IClass** (`IClassRejectedError`):
- `status: "failed"`, `errorCode: "ICLASS_REJECTED"`, `errorMessage`: detalle
- `attemptedNodeCode`: el nodo derivado de la city (el que se resolvio)
- `resolvedNodeCode`: null (no llego a resolverse exitosamente)
- `actorId`: el actor del stage

**Fallo por IClass no disponible** (`IClassUnavailableError`):
- `status: "failed"`, `errorCode: "ICLASS_UNAVAILABLE"`
- `attemptedNodeCode`: el nodo derivado de la city (si se llego a resolver)
- `resolvedNodeCode`: null
- `actorId`: el actor del stage

En todos los casos el attempt MUST persistirse ANTES de relanzar el error.
`SendTaskToIClass` MUST recibir `IClassDispatchAttemptRepository` como dependencia
de constructor (4to argumento OPCIONAL para no romper tests existentes).
Los tests existentes de `SendTaskToIClass` MUST continuar pasando.

#### Scenario: Fallo por nodo en envio normal genera attempt

**Given** una tarea cuya city `"Lujan"` no matchea ningun nodo de `listNodes()`
**And** el actor (usuario que movio el stage) tiene `actorId: "user-abc"`
**When** `SendTaskToIClass.execute()` se llama
**Then** MUST persistirse un `IClassDispatchAttempt` con `status: "failed"`, `errorCode: "ICLASS_NODE_NOT_FOUND"`, `actorId: "user-abc"`
**And** MUST lanzarse `IClassNodeNotFoundError` (comportamiento existente intacto)

#### Scenario: Fallo por rechazo de IClass en envio normal genera attempt

**Given** una tarea con city que matchea un nodo
**And** IClass responde con errores de rechazo
**When** `SendTaskToIClass.execute()` se llama
**Then** MUST persistirse un `IClassDispatchAttempt` con `status: "failed"` y `errorCode: "ICLASS_REJECTED"`
**And** MUST relanzarse `IClassRejectedError`

#### Scenario: Exito en envio normal NO genera attempt

**Given** una tarea con city que matchea un nodo y todos los campos validos
**And** IClass responde exitosamente
**When** `SendTaskToIClass.execute()` se llama
**Then** MUST NOT persistirse ningun `IClassDispatchAttempt` (el exito del envio normal NO se audita)

> Nota: El scope de REQ-AUDIT-4 cubre TODOS los fallos del envio normal
> (NodeNotFound, Rejected, Unavailable). El exito del envio normal NUNCA
> se audita — ese es el contraste con el reenvio manual (REQ-AUDIT-5), que
> registra TODO intento (exito y fallo).

---

### REQ-AUDIT-5: Registro en el reenvio manual (`ResendTaskToIClassWithNode`)

En TODO intento de reenvio manual, MUST persistirse un `IClassDispatchAttempt`:

**En fallo por nodeCode invalido** (`IClassNodeNotFoundError` en la validacion):
- `status: "failed"`, `errorCode: "ICLASS_NODE_NOT_FOUND"`
- `attemptedNodeCode`: el nodeCode provisto por el actor
- `resolvedNodeCode: null`
- `actorId`: el id del usuario que disparo el reenvio

**En fallo por rechazo de IClass** (`IClassRejectedError`):
- `status: "failed"`, `errorCode: "ICLASS_REJECTED"`, `errorMessage`: detalle del rechazo
- `attemptedNodeCode`: el nodeCode provisto (paso la validacion pero IClass lo rechazo)
- `resolvedNodeCode`: el nodeCode provisto (el elegido explicitamente)
- `actorId`: el usuario

**En fallo por IClass no disponible** (`IClassUnavailableError`):
- `status: "failed"`, `errorCode: "ICLASS_UNAVAILABLE"`
- `attemptedNodeCode`: el nodeCode provisto
- `resolvedNodeCode`: el nodeCode provisto
- `actorId`: el usuario

**En exito**:
- `status: "success"`
- `attemptedNodeCode`: el nodeCode provisto
- `resolvedNodeCode`: el nodeCode provisto (el elegido, que resulto exitoso)
- `errorCode: null`, `errorMessage: null`
- `actorId`: el usuario

En todos los casos el attempt MUST persistirse ANTES de relanzar errores (garantia
de que el registro queda aunque el caller no lo maneje).

#### Scenario: Attempt de exito en reenvio manual

**Given** un reenvio exitoso con `nodeCode: "Mercedes"` por `actorId: "user-xyz"`
**When** `ResendTaskToIClassWithNode.execute()` completa
**Then** MUST existir un `IClassDispatchAttempt` con:
  - `status: "success"`
  - `attemptedNodeCode: "Mercedes"`
  - `resolvedNodeCode: "Mercedes"`
  - `actorId: "user-xyz"`
  - `errorCode: null`

#### Scenario: Attempt de fallo por nodeCode invalido en reenvio manual

**Given** un reenvio con `nodeCode: "CiudadInexistente"` que no existe en `listNodes()`
**When** `ResendTaskToIClassWithNode.execute()` valida el nodeCode
**Then** MUST existir un `IClassDispatchAttempt` con:
  - `status: "failed"`
  - `errorCode: "ICLASS_NODE_NOT_FOUND"`
  - `attemptedNodeCode: "CiudadInexistente"`
  - `resolvedNodeCode: null`
  - `actorId` del actor

---

### REQ-AUDIT-6: DIP — el port no conoce Prisma

Los use cases `SendTaskToIClass` y `ResendTaskToIClassWithNode` MUST depender de
`IClassDispatchAttemptRepository` (port), NUNCA del adapter Prisma concreto.

`tsc --noEmit` MUST pasar con 0 errores. Ningun archivo bajo `src/application/`
MUST importar de `@infrastructure/*` ni de `@prisma/client`.

---

## Appendix: Campos del `IClassDispatchAttempt` por escenario

| Escenario                              | status    | errorCode                 | attemptedNodeCode     | resolvedNodeCode | actorId    |
| -------------------------------------- | --------- | ------------------------- | --------------------- | ---------------- | ---------- |
| Envio normal falla — nodo no hallado   | `failed`  | `ICLASS_NODE_NOT_FOUND`   | null                  | null             | actorId    |
| Envio normal falla — IClass rechaza    | `failed`  | `ICLASS_REJECTED`         | nodo derivado de city | null             | actorId    |
| Envio normal falla — IClass no disp.   | `failed`  | `ICLASS_UNAVAILABLE`      | nodo derivado de city | null             | actorId    |
| Envio normal exitoso                   | (no se registra — fuera de scope) | — | —           | —                | —          |
| Reenvio manual — nodeCode invalido     | `failed`  | `ICLASS_NODE_NOT_FOUND`   | nodeCode              | null             | actorId    |
| Reenvio manual — IClass rechaza OS     | `failed`  | `ICLASS_REJECTED`         | nodeCode              | nodeCode         | actorId    |
| Reenvio manual — IClass no disponible  | `failed`  | `ICLASS_UNAVAILABLE`      | nodeCode              | nodeCode         | actorId    |
| Reenvio manual — exito                 | `success` | null                      | nodeCode              | nodeCode         | actorId    |
