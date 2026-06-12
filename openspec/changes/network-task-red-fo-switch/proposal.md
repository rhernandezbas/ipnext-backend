# Change Proposal: Red/FO Switch for Network Scheduling Tasks (#66)

## Intent

Add a `networkType` discriminator to network scheduling tasks that splits the existing "network" kind into two sub-variants:

- **red** (default): tasks linked to a `NetworkSite` via FK. Existing behavior preserved. Locality (iclassCityCode) now optional.
- **fibra**: tasks with a free-text node name (`networkSiteName`), no `NetworkSite` FK. Locality still required. Dispatches to IClass using `iclassCityCode` as both `nodeCode` and `customerCode`.

## Scope

- **In**: migration, schema, domain entity/error, port, CreateTask/UpdateTask guards, DTO, route, Prisma/InMemory adapters, dispatchTaskToIClass, SendTaskToIClass.
- **Out**: IClass closure loop, GR ingest, frontend changes (separate ticket).

## Approach

1. **Additive migration**: two new nullable TEXT columns (`networkType`, `networkSiteName`). Backfill existing network tasks to `networkType='red'`. No breaking changes.
2. **Domain guard restructure**: `CreateTask` reads `networkType` (defaults to 'red'), branches on red vs fibra. Red relaxes locality requirement. Fibra requires `networkSiteName` (new error `NetworkTaskNodeNameRequiredError`) and `iclassCityCode`.
3. **Dispatch**: fibra uses `iclassCityCode` for nodeCode/customerCode/city; `networkSiteName` as customerName; no site lookup.
4. **Mapper**: `networkSiteName` = JOIN-derived for red, stored column for fibra.

## Risks

- Legacy red tasks with `networkType=NULL` treated as red (back-compat, no migration data-loss).
- Fibra tasks dispatch only if `iclassCityCode` is set — enforced at create, so always valid at dispatch.
