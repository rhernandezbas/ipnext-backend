# Spec: IClass Integration

**Capability**: `iclass-integration` (NEW)
**Change**: `task-send-to-iclass`
**Summary**: Port + adapter para crear Órdenes de Servicio (OS) en la API externa de IClass, con resolución de nodo por ciudad y validación de campos requeridos.

---

## Added Requirements

### REQ-PORT-1: `IClassPort` define el contrato de dominio

El dominio MUST exponer un puerto `IClassPort` en `src/domain/ports/IClassPort.ts` con (al menos):

```ts
interface IClassNode { code: string; description: string; }
interface CreateServiceOrderInput {
  customerCode: string;      // id del cliente backend (upsert inline en IClass)
  customerName: string;
  phone: string;
  address: string;
  city: string;              // se usa como nodeCode (resuelve la microárea)
  description: string;
}
interface IClassPort {
  listNodes(): Promise<IClassNode[]>;
  createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }>;
}
```

El use-case `SendTaskToIClass` MUST depender de `IClassPort`, NUNCA del adapter concreto (DIP — config rule `design`).

### REQ-OS-1: La OS se crea SIN fecha

#### Scenario: createServiceOrder no envía scheduledDate

**Given** un `CreateServiceOrderInput` válido
**When** el adapter construye el payload `ServiceOrderV1In`
**Then** el bloque `serviceOrder` MUST omitir `scheduledDate` (y `openedDate` MAY ir con la fecha actual)
**And** el `address.nodeCode` MUST ser igual a `input.city`
**And** la respuesta MUST exponer `orderCode` (string) tomado de `codigoOS` de IClass

> Rationale: el técnico y la fecha los asigna una persona en IClass.

### REQ-OS-2: Resolución y validación de nodo por ciudad

#### Scenario: Ciudad que matchea un nodo se acepta

**Given** que `listNodes()` incluye un nodo con `code: "Mercedes"`
**And** un input con `city: "Mercedes"`
**When** se valida el nodo
**Then** la validación MUST pasar y la OS MUST crearse con `nodeCode: "Mercedes"`

#### Scenario: Ciudad sin nodo correspondiente es rechazada antes de crear

**Given** que ningún nodo de `listNodes()` matchea (case-insensitive) `city: "Luján"`
**When** se valida el nodo
**Then** el use-case MUST lanzar `IClassNodeNotFoundError`
**And** NO MUST llamarse a `createServiceOrder`

### REQ-OS-3: Errores de transporte se mapean a dominio

#### Scenario: IClass no disponible

**Given** que la API de IClass responde 5xx o falla la conexión
**When** el adapter ejecuta `createServiceOrder` o `listNodes`
**Then** MUST lanzar `IClassUnavailableError` (no propagar el error de axios crudo)

#### Scenario: Token expirado se reintenta una vez

**Given** que IClass responde `401`
**When** el adapter detecta el 401
**Then** MUST re-loguear (`/auth/login`) UNA vez y reintentar la llamada original
**And** si el reintento vuelve a fallar con 401 MUST lanzar `IClassUnavailableError`

### REQ-OS-4: El adapter no devuelve entidades crudas de IClass

El adapter MUST mapear la respuesta de IClass a los tipos del puerto (`{ orderCode }`, `IClassNode[]`). NUNCA devolver el JSON crudo de IClass hacia capas superiores (config rule: no Prisma/infra crudo cross-layer; mismo principio para APIs externas).

---

## Appendix: New Error Codes (capa HTTP)

| Dominio | HTTP | `code` |
|---------|------|--------|
| `IClassNodeNotFoundError` | 422 | `ICLASS_NODE_NOT_FOUND` |
| `IClassUnavailableError` | 502 | `ICLASS_UNAVAILABLE` |
