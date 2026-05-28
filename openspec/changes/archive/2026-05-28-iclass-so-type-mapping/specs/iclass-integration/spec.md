# Spec: IClass Integration (Delta)

**Capability**: `iclass-integration` (MODIFIED)
**Change**: `iclass-so-type-mapping`
**Summary**: Rework `IClassPort` so that `soType` is an explicit per-call parameter instead of a fixed config default. Remove `defaultSoType` from `IClassClient` and `ICLASS_DEFAULT_SO_TYPE` from config/env. Add `listServiceOrderTypes()` to the port and the client so the catalog-sync use case can fetch the type list from IClass.

---

## Modified Requirements

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

**Note**: `listServiceOrderTypes()` takes NO `thirdPartyId` parameter. The thirdPartyId is configured in the `IClassClient` at construction time (see AD-2). The adapter internally uses its configured `thirdPartyId` to call the IClass endpoint and returns the trimmed results.

#### Scenario: listServiceOrderTypes returns trimmed codes

**Given** the IClass API returns a type entry with `codigo: "VISITA TECNICA "` (trailing space) and `descricao: " Visita Técnica Wireless "`
**When** the adapter calls `listServiceOrderTypes(thirdPartyId)`
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

## Error Contracts

Transport and rejection errors remain unchanged from the base `iclass-integration` spec (REQ-OS-3, REQ-OS-7). No new error codes are introduced in this delta.

---

## Appendix: IClass SO Types API shape

IClass endpoint: `GET /thirdparties/{thirdPartyId}/serviceorders/types`

Response shape (relevant fields):
```json
{
  "objects": [
    { "codigo": "VISITA TECNICA WIRELESS", "descricao": "Visita Técnica Wireless" },
    { "codigo": "INSTALACION FIBRA",       "descricao": "Instalación Fibra Óptica" }
  ]
}
```

The adapter MUST apply `.trim()` to both `codigo` and `descricao` before returning them as `IClassSoTypeDescriptor`. Empty strings after trimming MUST be filtered out (not included in the returned array) as a defensive data-quality check. See S-2 in verify-report for rationale (IClass API data quality).
