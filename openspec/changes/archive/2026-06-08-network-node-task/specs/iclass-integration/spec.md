# Delta for IClass Integration

**Change**: `network-node-task`
**Capabilities modified**: `iclass-integration`

---

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

### Requirement: REQ-PORT-1 — `IClassPort` and `CreateServiceOrderInput` contract

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
