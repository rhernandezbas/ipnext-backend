# Spec: IClass Nodes Endpoint

**Capability**: `iclass-nodes-endpoint` (NEW)
**Change**: `iclass-manual-node-resend`
**Summary**: Endpoint GET que expone la lista de nodos disponibles de IClass para alimentar
el dropdown de seleccion manual. Requiere permiso `scheduling.iclass_manual_resend`.

RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

---

## Entities

### `IClassNodeDTO` (salida del endpoint)

| Campo         | Tipo   | Descripcion                                           |
| ------------- | ------ | ----------------------------------------------------- |
| `code`        | string | Codigo del nodo en IClass (valor de `IClassNode.code`) |
| `description` | string | Descripcion legible del nodo                          |

---

## Requirements

### REQ-NODES-1: Ruta y metodo del endpoint

El endpoint MUST ser `GET /api/scheduling/iclass/nodes`.

- La ruta MUST registrarse ANTES del catch-all `GET /api/scheduling/:id` en
  `scheduling.routes.ts`, para que Express no interprete `iclass` como un `:id`.
- El handler MUST estar en `scheduling.routes.ts` (el mismo router que maneja
  `POST /:id/iclass/resend`).
- El use case `ListIClassNodes` MUST envolver `iclass.listNodes()` y mapear cada
  `IClassNode` a `IClassNodeDTO`. MUST NOT devolver el tipo interno del port si
  su shape difiere del DTO.

#### Scenario: Ruta registrada antes del catch-all (orden de registro)

**Given** que `scheduling.routes.ts` tiene un handler `GET /:id`
**When** Express recibe `GET /api/scheduling/iclass/nodes`
**Then** MUST resolverse al handler de nodos (NO al handler de `/:id` con `id = "iclass"`)
**And** la respuesta MUST ser 200 (no 404 ni el body de una tarea)

---

### REQ-NODES-2: Respuesta exitosa

Con token valido y permiso `scheduling.iclass_manual_resend`, el endpoint MUST
responder 200 con la lista de nodos.

```json
{
  "nodes": [
    { "code": "Mercedes", "description": "Mercedes - Zona Norte" },
    { "code": "Lujan",    "description": "Lujan" }
  ]
}
```

- El array MUST llamarse `nodes`.
- Cada elemento MUST incluir `code` (string, no nulo) y `description` (string, no nulo).
- El orden MUST reflejar el orden devuelto por `IClassPort.listNodes()`. MUST NOT
  reordenarse en el use case ni en la ruta.
- Si `listNodes()` retorna un array vacio (sin credenciales de IClass, o IClass
  sin nodos), la respuesta MUST ser 200 `{ "nodes": [] }`. MUST NOT ser 422 ni 502.

#### Scenario: IClass configurado devuelve nodos

**Given** un usuario autenticado con permiso `scheduling.iclass_manual_resend`
**And** `IClassPort.listNodes()` retorna `[{ code: "Mercedes", description: "Mercedes" }]`
**When** `GET /api/scheduling/iclass/nodes`
**Then** la respuesta MUST ser 200
**And** el body MUST ser `{ "nodes": [{ "code": "Mercedes", "description": "Mercedes" }] }`

#### Scenario: Sin credenciales de IClass la lista es vacia

**Given** un usuario autenticado con permiso `scheduling.iclass_manual_resend`
**And** el factory cayo al `InMemoryIClassClient` (sin secrets) y `listNodes()` retorna `[]`
**When** `GET /api/scheduling/iclass/nodes`
**Then** la respuesta MUST ser 200 `{ "nodes": [] }`
**And** MUST NOT lanzarse ningun error de dominio

---

### REQ-NODES-3: Autenticacion requerida

El endpoint MUST aplicar el middleware `auth` antes del guard de permiso.

#### Scenario: Sin token recibe 401

**Given** una request sin cookie `auth_token`
**When** `GET /api/scheduling/iclass/nodes`
**Then** la respuesta MUST ser 401
**And** el body MUST contener `{ "code": "NO_USER_CONTEXT" }` (o el formato del errorHandler)

---

### REQ-NODES-4: Permiso requerido

El endpoint MUST aplicar `requirePerm('scheduling', 'iclass_manual_resend')` despues
del middleware `auth`.

#### Scenario: Sin permiso recibe 403

**Given** un usuario autenticado con token valido
**And** ese usuario NO tiene el permiso `scheduling.iclass_manual_resend` en ningun rol
**When** `GET /api/scheduling/iclass/nodes`
**Then** la respuesta MUST ser 403
**And** el body MUST contener `{ "error": "FORBIDDEN", "code": "PERMISSION_DENIED" }`

#### Scenario: super_admin pasa el guard sin permiso explicito

**Given** un usuario con rol `super_admin`
**When** `GET /api/scheduling/iclass/nodes`
**Then** la respuesta MUST ser 200 (el short-circuit de super_admin aplica)

#### Scenario: Usuario con permiso iclass_manual_resend pasa el guard

**Given** un usuario con permiso `scheduling.iclass_manual_resend` asignado via rol
**When** `GET /api/scheduling/iclass/nodes`
**Then** la respuesta MUST ser 200 con la lista de nodos

---

### REQ-NODES-5: Use case `ListIClassNodes` es parte de application layer

El use case `ListIClassNodes` MUST vivir en `src/application/use-cases/ListIClassNodes.ts`.

- MUST depender solo de `IClassPort` (port de dominio). MUST NOT importar de
  `@infrastructure/*`, Prisma, ni paths concretos de infraestructura.
- Su firma MUST ser equivalente a:

```ts
class ListIClassNodes {
  constructor(private iclass: IClassPort) {}
  async execute(): Promise<{ nodes: IClassNodeDTO[] }>
}
```

- El mapeo de `IClassNode` a `IClassNodeDTO` MUST ocurrir dentro del use case,
  NO en la ruta.

#### Scenario: tsc --noEmit pasa con 0 errores

**Given** `ListIClassNodes.ts` implementado segun este requisito
**When** `tsc --noEmit` se ejecuta
**Then** MUST emitir 0 errores de compilacion

---

## Appendix: Codigos de error HTTP

| Condicion                                 | HTTP | `code`             |
| ----------------------------------------- | ---- | ------------------ |
| Sin token                                 | 401  | `NO_USER_CONTEXT`  |
| Sin permiso `scheduling.iclass_manual_resend` | 403  | `PERMISSION_DENIED` |
| IClass no disponible (5xx/transporte)     | 502  | `ICLASS_UNAVAILABLE` |
