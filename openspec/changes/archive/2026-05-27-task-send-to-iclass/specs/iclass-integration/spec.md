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

## Post-deploy fixes (implementados y verificados en prod)

> Estos requirements se agregaron tras validar la feature contra IClass producción.

### REQ-OS-5: `customerCode` corto (no el UUID) — MODIFIED REQ-PORT-1

IClass limita la longitud de `codigoCliente`/`codigoOS` (un UUID de 36 chars da `ICLERR_0045`/`ICLERR_0050`). El `customerCode` enviado MUST ser un código corto y estable del cliente: **`grClienteId ?? splynxId ?? login`** — NUNCA el `id` (UUID) del backend. La tarea expone `customerCode` (derivado en el JOIN del Client).

### REQ-OS-6: `soCode` = número de tarea

`soCode` (y `addressCode`) MUST ser `String(task.sequenceNumber)` (ej. `"4274"`), para correlacionar la OS de IClass con la tarea del backend. (Antes era un base36 del timestamp.)

### REQ-OS-7: Rechazo de IClass se reporta como `IClassRejectedError` (no "unavailable")

#### Scenario: IClass responde con `erros`
**Given** que IClass responde con `erros` (HTTP 400 o 200 con `erros` no nulo)
**When** el adapter procesa la respuesta
**Then** MUST lanzar `IClassRejectedError` con el detalle legible de `erros` (code: description)
**And** NO MUST lanzar `IClassUnavailableError` (eso queda solo para 5xx/transporte/401 persistente)

### REQ-OS-8: Match de nodo insensible a acentos — REFINA REQ-OS-2

El match `city` vs `node.code` MUST normalizar mayúsculas Y acentos (NFD + strip de diacríticos): `Luján` ≡ `Lujan`, `Cañuelas` ≡ `Canuelas`.

### REQ-CONFIG-1: Credenciales por entorno

El adapter real se usa solo si `ICLASS_USERNAME`, `ICLASS_PASSWORD`, `ICLASS_THIRD_PARTY_ID` están configurados (GitHub Secrets → `deploy.yml`). Sin ellos, el factory MUST caer a un cliente in-memory inerte (el flag, default OFF, evita que se llame). Ver runbook: `docs/iclass-integration.md`.

---

## Appendix: New Error Codes (capa HTTP)

| Dominio | HTTP | `code` |
|---------|------|--------|
| `MissingRequiredFieldsError` | 422 | `MISSING_REQUIRED_FIELDS` (+ `missingFields[]`) |
| `IClassNodeNotFoundError` | 422 | `ICLASS_NODE_NOT_FOUND` |
| `IClassRejectedError` | 422 | `ICLASS_REJECTED` (+ `reason`) |
| `IClassUnavailableError` | 502 | `ICLASS_UNAVAILABLE` |
