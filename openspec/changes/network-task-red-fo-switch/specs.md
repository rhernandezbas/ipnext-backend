# Specs: Red/FO Switch (#66)

## Domain Entity

- `ScheduledTask.networkType: 'red' | 'fibra' | null` — null treated as 'red' (back-compat).

## Create Guard Matrix

| kind     | networkType | networkSiteId  | networkSiteName | iclassCityCode | address    | Result     |
|----------|-------------|----------------|-----------------|----------------|------------|------------|
| customer | —           | —              | —               | optional       | optional   | ok         |
| network  | red/null    | required (FK)  | ignored         | optional       | required   | ok         |
| network  | red/null    | missing        | —               | —              | —          | ReferenceNotFoundError |
| network  | fibra       | must be null   | required        | required       | required   | ok         |
| network  | fibra       | —              | blank           | —              | —          | NetworkTaskNodeNameRequiredError |
| network  | fibra       | —              | valid           | blank          | —          | NetworkTaskLocalityRequiredError |

## Update Guard Matrix (change-not-presence)

- Address: blank incoming only rejected when clearing a non-blank existing value. Kind-agnostic.
- Locality: blank incoming only rejected for FIBRA tasks (not red). Red tasks: locality guard removed.
- NodeName: blank incoming only rejected for FIBRA tasks when existing name was non-blank.

## Dispatch Seam

| Field          | RED path                                | FIBRA path              |
|----------------|-----------------------------------------|-------------------------|
| nodeCode       | `networkSite.iclassNodeCode ?? NETWORK` | `iclassCityCode`        |
| customerCode   | `networkSite.iclassNodeCode ?? NETWORK` | `iclassCityCode`        |
| customerName   | `task.networkSiteName` (JOIN)           | `task.networkSiteName` (stored) |
| address        | `firstNonBlank(site.addr, task.addr, site.name)` | `firstNonBlank(task.addr, task.networkSiteName)` |
| city           | `iclassCityCode ?? site.city`           | `iclassCityCode`        |
| site lookup    | yes (findById)                          | NO                      |

## DTO Wire Contract

### POST /api/scheduling (create)

```json
// Red task:
{ "kind": "network", "networkType": "red", "networkSiteId": "<uuid>", "address": "...", "iclassCityCode": "..." }

// Fibra task:
{ "kind": "network", "networkType": "fibra", "networkSiteId": null, "networkSiteName": "Nodo FO-1", "address": "...", "iclassCityCode": "Mercedes" }
```

### PUT /api/scheduling/:id (update)

All fields optional. `networkType` and `networkSiteName` accepted in partial body.

### GET /api/scheduling (list/detail)

Response includes `networkType`, `networkSiteName`, `iclassCityCode`.

## Migration

File: `20260708000000_scheduled_task_network_type/migration.sql`

```sql
ALTER TABLE "ScheduledTask" ADD COLUMN "networkType" TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "networkSiteName" TEXT;
UPDATE "ScheduledTask" SET "networkType" = 'red' WHERE "kind" = 'network' AND "networkType" IS NULL;
```
