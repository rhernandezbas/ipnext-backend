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

### REQ-PORT-2: `CreateServiceOrderInput` carries `soType` explicitly (MODIFIES REQ-PORT-1)

The `CreateServiceOrderInput` interface MUST add a required field `soType: string`.

```ts
interface CreateServiceOrderInput {
  soCode: string;
  customerCode: string;
  customerName: string;
  phone: string;
  address: string;
  city: string;
  description: string;
  soType: string;          // NEW — the IClass typeSOSummary code; caller MUST supply it
}
```

The adapter MUST use `input.soType` as the value for `typeSOSummary` in the IClass payload. There MUST be no internal fallback or default value.

#### Scenario: soType is passed through to IClass payload

**Given** a `CreateServiceOrderInput` with `soType: "INSTALACION FIBRA"`
**When** the adapter builds the `ServiceOrderV1In` payload
**Then** the `serviceOrder.typeSOSummary` field MUST equal `"INSTALACION FIBRA"`
**And** the adapter MUST NOT read `this.defaultSoType` (field MUST NOT exist)

### REQ-PORT-3: `IClassPort` exposes `listServiceOrderTypes()`

The `IClassPort` interface MUST add:

```ts
interface IClassSoTypeDescriptor {
  code: string;        // trimmed value of IClass `codigo` field
  description: string; // trimmed value of IClass `descricao` field
}

interface IClassPort {
  listNodes(): Promise<IClassNode[]>;
  listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]>;
  createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }>;
}
```

**Note**: `listServiceOrderTypes()` takes NO `thirdPartyId` parameter. The thirdPartyId is configured in the `IClassClient` at construction time. The adapter internally uses its configured `thirdPartyId` to call the IClass endpoint and returns the trimmed results.

#### Scenario: listServiceOrderTypes returns trimmed codes

**Given** the IClass API returns a type entry with `codigo: "VISITA TECNICA "` (trailing space) and `descricao: " Visita Técnica Wireless "`
**When** the adapter calls `listServiceOrderTypes()`
**Then** the returned entry MUST have `code: "VISITA TECNICA"` (trimmed)
**And** `description: "Visita Técnica Wireless"` (trimmed)
**And** the raw `codigo`/`descricao` values from IClass MUST NOT cross the adapter boundary

#### Scenario: listServiceOrderTypes calls the correct IClass endpoint

**Given** a `IClassClient` initialized with `thirdPartyId: "6808841"` in the constructor options
**When** the adapter executes `listServiceOrderTypes()`
**Then** it MUST call `GET /thirdparties/6808841/serviceorders/types` using the stored thirdPartyId
**And** it MUST return all entries from the `objects` array of the response

### REQ-CONFIG-2: `defaultSoType` is removed from `IClassClient` and config

The `IClassClientOptions` interface MUST NOT contain a `defaultSoType` field.
`src/infrastructure/config.ts` MUST NOT read or export `iclassDefaultSoType`.
`env.example` and `.github/workflows/deploy.yml` MUST NOT contain `ICLASS_DEFAULT_SO_TYPE`.
`src/infrastructure/http/iclass.factory.ts` MUST NOT pass `defaultSoType` when constructing `IClassClient`.

#### Scenario: TypeScript compilation rejects a call without soType

**Given** a call to `IClassPort.createServiceOrder` that omits `soType`
**When** `tsc --noEmit` runs
**Then** it MUST emit a type error (the field is required, not optional)

---

## Modified Requirements — SO Type per-call Resolution (iclass-so-type-mapping change)

The changes above (REQ-PORT-2, REQ-PORT-3, REQ-CONFIG-2) replace the previous pattern where `IClassClient` had a fixed `defaultSoType` config. Going forward, every call to `createServiceOrder` must supply `soType` explicitly. This enables Project-based mapping of SO types in the application layer.

---

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

---

# Delta absorbido: network-node-task (2026-06-08)

Extends IClass integration to support network-mode tasks dispatched with network-site-derived fields and direct node code (bypassing city-node lookup).

## ADDED Requirements

### Requirement: REQ-NODE-DISPATCH-1 — Network task sends substituted fields to IClass

When `SendTaskToIClass` processes a task with `kind: 'network'`, it MUST substitute customer-derived fields with values from the associated `NetworkSite` and MUST skip the city-node lookup step (REQ-OS-2).

| Field in IClass payload | Source for `kind='network'` | Source for `kind='customer'` (unchanged) |
|-------------------------|-----------------------------|------------------------------------------|
| `customerName` | `task.networkSiteName` | `task.customerName` |
| `customerCode` | `site.iclassNodeCode ?? 'NETWORK'` | `task.customerCode` |
| `phone` | `'0000000000'` (constant) | `task.customerPhone` |
| `address` | `site.address ?? task.networkSiteName` | `task.address` |
| `city` | `site.city ?? ''` | `task.customerCity` |
| `nodeCode` | `site.iclassNodeCode` (direct, no city lookup) | resolved via `listNodes()` city match |
| `soType` | from linked Project (unchanged) | from linked Project (unchanged) |

#### Scenario: Network task dispatched with node-derived fields

- GIVEN a task with `kind: 'network'`, `networkSiteId: 'site-1'`
- AND `site-1` has `name: 'Torre Norte'`, `iclassNodeCode: 'TN-001'`, `address: 'Ruta 7 km 5'`, `city: 'Mercedes'`
- AND the task is linked to a project with `iclassSoType.code: 'MANTENIMIENTO'`
- WHEN `SendTaskToIClass.execute` is called
- THEN `IClassPort.createServiceOrder` MUST be called with `customerName: 'Torre Norte'`, `customerCode: 'TN-001'`, `phone: '0000000000'`, `address: 'Ruta 7 km 5'`, `city: 'Mercedes'`, `nodeCode: 'TN-001'`, `soType: 'MANTENIMIENTO'`
- AND `listNodes()` MUST NOT be called (city-node lookup skipped)

#### Scenario: Customer task dispatch unchanged

- GIVEN a task with `kind: 'customer'`, `customerId: 'c-1'`
- WHEN `SendTaskToIClass.execute` is called
- THEN the dispatch behavior MUST be byte-identical to the pre-change path
- AND `listNodes()` city-match MUST still run
- AND `networkSiteId` / `networkSiteName` play no role in the dispatch

---

### Requirement: REQ-NODE-DISPATCH-2 — Required-field validation passes for a network task using substituted values

The `MissingRequiredFieldsError` check (REQ-MOVE-VAL-1) MUST run against substituted values for network tasks, NOT against the (null) customer fields. A network task with a fully-populated NetworkSite MUST pass required-field validation.

#### Scenario: Network task with complete site data passes validation

- GIVEN a task with `kind: 'network'` and a linked NetworkSite with `name`, `iclassNodeCode`, `address`, `city` all set
- AND the task has a non-empty `description`
- WHEN the required-field check runs
- THEN validation MUST pass (no `MISSING_REQUIRED_FIELDS` error)
- AND `missingFields` MUST be empty

#### Scenario: Network task with null customerName still passes because substitution runs first

- GIVEN a task with `kind: 'network'`, `customerId: null`, `customerName: null`
- AND the linked NetworkSite has `name: 'Nodo Sur'`
- WHEN the required-field check runs
- THEN `customerName` check MUST use `'Nodo Sur'` (substituted), not `null`
- AND validation MUST NOT report `customerName` as missing

---

### Requirement: REQ-NODE-DISPATCH-3 — `iclassNodeCode` null fallback uses 'NETWORK'

When `site.iclassNodeCode` is null (operator has not yet configured the IClass code for this site), `customerCode` MUST fall back to the string `'NETWORK'` and `nodeCode` MUST also fall back to `'NETWORK'` (constant) to avoid an empty-string rejection by IClass.

#### Scenario: Site without iclassNodeCode uses fallback

- GIVEN a task with `kind: 'network'`
- AND the linked NetworkSite has `iclassNodeCode: null`
- WHEN `SendTaskToIClass.execute` is called
- THEN `createServiceOrder` MUST be called with `customerCode: 'NETWORK'` and `nodeCode: 'NETWORK'`
- AND no exception MUST be thrown due to the null code

---

## MODIFIED Requirements

### Requirement: REQ-PORT-1 — `IClassPort` and `CreateServiceOrderInput` contract (MODIFIED)

(Previously: `CreateServiceOrderInput` had no `nodeCode` override field; node was resolved only via city-name match)

The `CreateServiceOrderInput` interface MUST include an optional `nodeCode?: string` field that, when provided, overrides the city-derived node resolution:

```ts
interface CreateServiceOrderInput {
  soCode: string;
  customerCode: string;
  customerName: string;
  phone: string;
  address: string;
  city: string;
  description: string;
  soType: string;
  nodeCode?: string;  // NEW — when set, overrides the city-node lookup
}
```

When `nodeCode` is present and non-empty, the adapter MUST use it directly as `address.nodeCode` in the IClass payload and MUST skip the `listNodes()` lookup. When absent, the existing city-match behavior applies unchanged.

#### Scenario: soType is passed through to IClass payload (unchanged from REQ-PORT-2)

- GIVEN a `CreateServiceOrderInput` with `soType: 'INSTALACION FIBRA'`
- WHEN the adapter builds the `ServiceOrderV1In` payload
- THEN `serviceOrder.typeSOSummary` MUST equal `'INSTALACION FIBRA'`

#### Scenario: nodeCode override bypasses listNodes lookup

- GIVEN a `CreateServiceOrderInput` with `nodeCode: 'TN-001'`
- WHEN the adapter builds the IClass payload
- THEN `address.nodeCode` MUST equal `'TN-001'`
- AND `listNodes()` MUST NOT be called

#### Scenario: Absent nodeCode falls through to city-match (existing behavior)

- GIVEN a `CreateServiceOrderInput` with no `nodeCode` field
- WHEN the adapter validates the node
- THEN the city-match against `listNodes()` MUST run as before
- AND behavior MUST be identical to pre-change for all customer tasks

---

## Appendix: Constant Reference

| Constant | Value | Used when |
|----------|-------|-----------|
| `NETWORK_PHONE` | `'0000000000'` | `kind='network'` phone substitute |
| `NETWORK_CUSTOMER_CODE` | `'NETWORK'` | `kind='network'` fallback when `iclassNodeCode` is null |
