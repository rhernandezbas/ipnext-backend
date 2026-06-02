# Spec: Stage Stable Code

**Capability**: `stage-stable-code` (NEW)
**Change**: `scheduling-stage-code`
**Summary**: Cada Stage tiene un `code` inmutable (slug estable) que es su identidad de negocio. La logica de scheduling resuelve stages por `code`, no por `name`. Renombrar un stage desde la UI NO altera el comportamiento del sistema.

RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

---

## Entities

### `Stage` (modificada)

| Campo       | Tipo   | Restricciones                                                                                       |
| ----------- | ------ | --------------------------------------------------------------------------------------------------- |
| `id`        | string | uuid                                                                                                |
| `workflowId`| string | FK -> `Workflow.id`                                                                                 |
| `name`      | string | label editable por el usuario                                                                       |
| `code`      | string | slug inmutable; NOT NULL; `@@unique([workflowId, code])`; auto-generado al crear; nunca editable   |
| `category`  | enum   | `nuevo` \| `enProgreso` \| `hecho`                                                                 |
| `order`     | int    | posicion en el workflow                                                                             |
| `color`     | string | opcional                                                                                            |

---

## Requirements

### REQ-CODE-1: `code` es inmutable post-creacion

El campo `code` de un `Stage` MUST ser tratado como inmutable una vez creado.

- El schema de input de creacion de stage (Zod `CreateStageSchema`) MUST NOT incluir `code` como campo aceptado. Si el cliente lo envia, MUST ser ignorado silenciosamente.
- Ningun endpoint de edicion de stage MUST aceptar `code` como campo editable. Si el cliente lo envia en un PATCH/PUT, MUST ser ignorado.
- El use case `AddStageToWorkflow` MUST autogenerar el `code` a partir del `name` (regla de slug: ver REQ-CODE-2) y persistirlo. El llamador MUST NOT poder inyectar un `code` arbitrario.

#### Scenario: Creacion sin code en el body autogenera el slug

**Given** un `POST /api/workflows/:workflowId/stages` con body `{ "name": "En Revision", "category": "enProgreso" }`
**When** se procesa
**Then** el stage creado MUST tener `code: "en_revision"` (slug del name)
**And** la respuesta MUST incluir `code: "en_revision"`
**And** el cliente NO necesito enviar `code`

#### Scenario: Enviar code en el body al crear es ignorado

**Given** un `POST /api/workflows/:workflowId/stages` con body `{ "name": "En Revision", "code": "mi_code_custom", "category": "enProgreso" }`
**When** se procesa
**Then** el stage MUST quedar con `code: "en_revision"` (slug del name)
**And** el valor `"mi_code_custom"` MUST ser descartado silenciosamente

#### Scenario: Enviar code en edicion es ignorado

**Given** un stage existente con `code: "en_revision"`
**When** `PATCH /api/workflows/:workflowId/stages/:stageId` con body `{ "code": "otro_code" }`
**Then** el `code` del stage MUST permanecer `"en_revision"` sin cambios

---

### REQ-CODE-2: Generacion de slug al crear un stage

Cuando el use case `AddStageToWorkflow` crea un stage, MUST derivar `code` del campo `name` aplicando las siguientes transformaciones en orden:

1. Convertir a minusculas.
2. Reemplazar secuencias de caracteres no alfanumericos (espacios, guiones, acentos, etc.) por `_`.
3. Colapsar `__` consecutivos en `_`.
4. Quitar `_` al inicio y al final.

Los stages canonicos de logica de negocio (ver REQ-BACKFILL-1) MUST recibir su code via mapa explicito en seed/migration, NO via slug del name en espanol.

#### Scenario: Slug de nombre simple

**Given** `name: "Confirmado"`
**When** se genera el code
**Then** `code = "confirmado"`

#### Scenario: Slug de nombre compuesto

**Given** `name: "No Factible"`
**When** se genera el code
**Then** `code = "no_factible"`

#### Scenario: Slug de nombre con guion

**Given** `name: "Anulado-Cancelado"`
**When** se genera el code
**Then** `code = "anulado_cancelado"`

#### Scenario: Colision de slug en el mismo workflow se resuelve con sufijo numerico

**Given** un workflow con un stage existente `code: "revision"`
**And** se crea un nuevo stage con `name: "Revision"` en el mismo workflow
**When** se genera el code
**Then** el nuevo stage MUST recibir `code: "revision_2"` (o `"revision_3"` si `"revision_2"` tambien existe, incrementando hasta encontrar uno libre)
**And** la unicidad por `@@unique([workflowId, code])` MUST mantenerse

---

### REQ-CODE-3: Unicidad de `code` por workflow

La combinacion `(workflowId, code)` MUST ser unica en la base de datos.

- El schema Prisma MUST declarar `@@unique([workflowId, code])` en el modelo `Stage`.
- Dos stages en DISTINTOS workflows MAY tener el mismo `code` (ej. dos workflows distintos pueden tener `registered_in_iclass`).
- Dos stages en el MISMO workflow MUST NOT tener el mismo `code`.

#### Scenario: Mismo code en workflows distintos es valido

**Given** un workflow `wf-1` con un stage `code: "registered_in_iclass"`
**And** un workflow `wf-2` que tambien tiene un stage `code: "registered_in_iclass"`
**When** se consultan ambos stages
**Then** ambos MUST existir y ser resolvibles por `getStageByCode("registered_in_iclass", workflowId)`

#### Scenario: Code duplicado en el mismo workflow es rechazado

**Given** un workflow `wf-1` con un stage `code: "confirmado"`
**When** el use case intenta crear otro stage en `wf-1` y el slug resultante colisiona con `"confirmado"` sin sufijo disponible
**Then** MUST aplicarse el mecanismo de sufijo numerico (REQ-CODE-2) antes de persistir

---

### REQ-CODE-4: `getStageByCode` en los ports de dominio

El port `SchedulingRepository` (y/o `StageRepository`) MUST exponer:

```ts
getStageByCode(code: string, workflowId: string): Promise<Stage | null>
```

- El parametro `workflowId` es REQUERIDO porque `code` es unico por workflow, no globalmente.
- Si no existe un stage con esa combinacion, MUST retornar `null`.
- Los adapters Prisma e InMemory MUST implementar este metodo.

#### Scenario: Stage existente se resuelve por code

**Given** un workflow `wf-1` con un stage `{ code: "registered_in_iclass", name: "Registrado en IClass" }`
**When** `getStageByCode("registered_in_iclass", "wf-1")` es llamado
**Then** MUST retornar el stage con todos sus campos incluyendo `code`

#### Scenario: Stage inexistente retorna null

**Given** un workflow `wf-1` sin ningun stage con `code: "inexistente"`
**When** `getStageByCode("inexistente", "wf-1")` es llamado
**Then** MUST retornar `null`

---

### REQ-CODE-5: Deprecacion de `getStageByName`

El metodo `getStageByName` en `SchedulingRepository` MUST ser marcado como `@deprecated` (JSDoc) en este change. MUST NOT ser eliminado todavia.

- Ningun use case de aplicacion ni ningun bootstrap de infraestructura MUST llamar a `getStageByName` tras este change. Todos los callers MUST ser migrados a `getStageByCode`.
- `getStageByName` MUST permanecer funcional para no romper callers externos no identificados. Su eliminacion definitiva ocurrira en un change de limpieza posterior.

#### Scenario: getStageByName sigue compilando y funcionando

**Given** que `getStageByName` esta decorado con `@deprecated`
**When** `tsc --noEmit` se ejecuta
**Then** MUST compilar sin errores (deprecation es JSDoc, no error de TypeScript)

---

### REQ-LOGIC-1: La logica de negocio resuelve stages por `code`, nunca por `name`

Los siguientes archivos MUST referenciar stages exclusivamente via `code`:

| Archivo | Code usado |
|---------|-----------|
| `SendTaskToIClass.ts` | `registered_in_iclass` |
| `MoveTaskToStage.ts` | `send_to_iclass` |
| `BackfillClosedServiceOrders.ts` | `registered_in_iclass` (stage en vuelo) |
| `bootstrapGestionRealIngest.ts` | `pendiente` (o el code que corresponda al stage "Pendiente" del workflow) |

Ningun archivo bajo `src/application/` ni `src/infrastructure/scheduling/` MUST contener string literals de nombres de stages como `"Registrado en IClass"`, `"Enviar a IClass"` o similares tras este change. Verificable via `rg` de esos literales.

#### Scenario: Renombrar un stage no rompe la integracion IClass (rename-safe)

**Given** un stage con `code: "registered_in_iclass"` y `name: "Registrado en IClass"`
**When** el usuario renombra el stage a `name: "En IClass (confirmado)"` via la UI
**Then** el `code` MUST permanecer `"registered_in_iclass"` sin cambios
**And** `SendTaskToIClass` MUST continuar funcionando correctamente (resuelve por `code`)
**And** la tarea MUST seguir moviendose al stage correcto tras el alta en IClass

#### Scenario: MoveTaskToStage detecta el stage "send_to_iclass" por code

**Given** un stage con `code: "send_to_iclass"` y `name: "Enviar a IClass"` (o cualquier nombre)
**When** `MoveTaskToStage` evalua si debe disparar la integracion IClass
**Then** MUST comparar `stage.code === "send_to_iclass"` (no `stage.name`)
**And** el comportamiento MUST ser identico al actual

---

### REQ-BACKFILL-1: Backfill deterministico de stages existentes

La migration Prisma que agrega la columna `code` MUST incluir un bloque SQL idempotente que asigne `code` a todos los stages existentes antes de agregar el constraint `NOT NULL`.

El mapa canonico de los 11 stages del seed es:

| `name` (actual en prod) | `code` asignado |
|-------------------------|-----------------|
| Nuevo | `nuevo` |
| Confirmado | `confirmado` |
| Pospuesta | `pospuesta` |
| No Factible | `no_factible` |
| Enviar a IClass | `send_to_iclass` |
| Registrado en IClass | `registered_in_iclass` |
| Notificado | `notificado` |
| En progreso | `en_progreso` |
| Instalado | `instalado` |
| Hecho | `hecho` |
| Anulado-Cancelado | `anulado_cancelado` |

Para stages no presentes en el mapa canonico, MUST aplicarse el algoritmo slug de REQ-CODE-2 como fallback. En caso de colision de slug en el mismo workflow, MUST aplicarse sufijo numerico (`_2`, `_3`, etc.) de forma determinista (ej. por orden de `id`).

La migration MUST ser idempotente: si se ejecuta dos veces, NO MUST alterar codes ya asignados (usar `WHERE "code" IS NULL` en el UPDATE).

#### Scenario: Migration asigna code al stage canonical

**Given** la base de datos prod con el stage `{ name: "Registrado en IClass", code: NULL }`
**When** la migration se ejecuta
**Then** ese stage MUST quedar con `code: "registered_in_iclass"`
**And** el constraint `NOT NULL` MUST aplicarse DESPUES del UPDATE (sin romper la migration)

#### Scenario: Migration es idempotente

**Given** un stage ya tiene `code: "registered_in_iclass"` (migration ya corrida antes)
**When** la migration se re-ejecuta (simulado con el UPDATE idempotente)
**Then** el `code` MUST permanecer `"registered_in_iclass"` sin cambios

#### Scenario: Stage con nombre no canonico recibe slug como fallback

**Given** un stage con `name: "Visita Tecnica"` y `code: NULL` en el mismo workflow
**When** la migration se ejecuta
**Then** ese stage MUST quedar con `code: "visita_tecnica"` (slug del name)

---

### REQ-DTO-1: El DTO de salida de stage expone `code` como campo aditivo

El DTO de salida del stage (response de `GET /api/workflows`, `GET /api/workflows/:id`, `POST /api/workflows/:id/stages`, etc.) MUST incluir el campo `code: string`.

- Ningun campo existente del DTO de stage MUST ser eliminado ni renombrado.
- `code` se agrega ADICIONALMENTE a los campos actuales (`id`, `name`, `category`, `order`, `color`, etc.).
- El FE puede continuar usando `name` como label de display sin necesidad de cambios inmediatos.

#### Scenario: GET /api/workflows retorna stages con code

**Given** un workflow con stages que ya tienen `code` asignado
**When** `GET /api/workflows` se ejecuta con token valido
**Then** cada stage en la respuesta MUST incluir el campo `code` (string no nulo)
**And** los campos previos (`id`, `name`, `category`, `order`, `color`) MUST seguir presentes

#### Scenario: POST /api/workflows/:id/stages retorna el code autogenerado

**Given** un `POST /api/workflows/:id/stages` con body `{ "name": "En Revision", "category": "enProgreso" }`
**When** la respuesta es 201
**Then** el body MUST incluir `code: "en_revision"` ademas de los demas campos del stage

---

### REQ-RBAC-1: Rutas mutantes de workflows/stages requieren `scheduling.manage`

Las siguientes rutas MUST requerir el permiso `scheduling.manage` (ademas del middleware `auth` existente):

| Metodo | Ruta | Accion |
|--------|------|--------|
| POST | `/api/workflows` | crear workflow |
| PATCH/PUT | `/api/workflows/:id` | editar workflow |
| DELETE | `/api/workflows/:id` | borrar workflow |
| POST | `/api/workflows/:id/stages` | agregar stage |
| PATCH/PUT | `/api/workflows/:id/stages/:stageId` | editar stage |
| DELETE | `/api/workflows/:id/stages/:stageId` | borrar stage |
| PUT | `/api/workflows/:id/stages/order` | reordenar stages |

El middleware `requirePerm('scheduling', 'manage')` MUST encadenarse DESPUES de `auth` y ANTES del handler.

#### Scenario: Usuario sin permiso recibe 403

**Given** un usuario autenticado con token valido
**And** ese usuario NO tiene el permiso `scheduling.manage` en ningun rol
**When** realiza `POST /api/workflows/:id/stages`
**Then** la respuesta MUST ser 403 con body `{ "error": "FORBIDDEN", "code": "PERMISSION_DENIED" }`
**And** el stage MUST NOT ser creado

#### Scenario: Usuario con scheduling.manage puede mutar

**Given** un usuario con permiso `scheduling.manage`
**When** realiza `POST /api/workflows/:id/stages` con body valido
**Then** la respuesta MUST ser 201 con el stage creado

#### Scenario: super_admin pasa sin permiso explicito

**Given** un usuario con rol `super_admin`
**When** realiza cualquier mutacion de workflow/stage
**Then** la respuesta MUST ser 201/200/204 (segun el caso)
**And** el middleware MUST NOT consultar los permisos del usuario (short-circuit)

#### Scenario: Sin token recibe 401

**Given** una request sin cookie `auth_token`
**When** `POST /api/workflows/:id/stages` se ejecuta
**Then** la respuesta MUST ser 401
**And** el stage MUST NOT ser creado

---

### REQ-RBAC-2: Rutas de lectura de workflows/stages requieren `scheduling.read`

Las rutas GET de workflows y stages MUST requerir `scheduling.read`:

| Metodo | Ruta |
|--------|------|
| GET | `/api/workflows` |
| GET | `/api/workflows/:id` |

#### Scenario: Usuario con scheduling.read puede leer

**Given** un usuario con permiso `scheduling.read`
**When** realiza `GET /api/workflows`
**Then** la respuesta MUST ser 200 con la lista de workflows

#### Scenario: Usuario sin scheduling.read recibe 403 en GET

**Given** un usuario autenticado sin permiso `scheduling.read`
**When** realiza `GET /api/workflows`
**Then** la respuesta MUST ser 403

---

### REQ-DIP-1: Application layer no importa de infrastructure

Ningun archivo bajo `src/application/` MUST importar de `@infrastructure/*`, `@prisma/client`, ni de paths concretos de `src/infrastructure/`.

- `SendTaskToIClass`, `MoveTaskToStage`, `BackfillClosedServiceOrders`, `AddStageToWorkflow` MUST depender unicamente de ports (`@domain/ports/*`).
- `tsc --noEmit` MUST pasar con 0 errores tras el refactor.

#### Scenario: tsc --noEmit pasa con 0 errores

**Given** el refactor completo de referencias por code aplicado
**When** `tsc --noEmit` se ejecuta
**Then** MUST emitir 0 errores de compilacion

---

## Appendix: Codes canonicos de los 11 stages del seed

| Stage | Code |
|-------|------|
| Nuevo | `nuevo` |
| Confirmado | `confirmado` |
| Pospuesta | `pospuesta` |
| No Factible | `no_factible` |
| Enviar a IClass | `send_to_iclass` |
| Registrado en IClass | `registered_in_iclass` |
| Notificado | `notificado` |
| En progreso | `en_progreso` |
| Instalado | `instalado` |
| Hecho | `hecho` |
| Anulado-Cancelado | `anulado_cancelado` |

Los codes `send_to_iclass` y `registered_in_iclass` son en ingles (logica de negocio). El resto son slugs del name en espanol.

## Appendix: Codigos de error (capa HTTP)

| Condicion | HTTP | `code` |
|-----------|------|--------|
| Sin permiso `scheduling.manage` en mutacion | 403 | `PERMISSION_DENIED` |
| Sin permiso `scheduling.read` en lectura | 403 | `PERMISSION_DENIED` |
| Sin token | 401 | `NO_USER_CONTEXT` |
