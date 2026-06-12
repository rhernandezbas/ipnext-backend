# Change: node-task-required-locality (#54)

## Why
The IClass OS for a node task needs a locality (`city`). Today that value is derived only from `NetworkSite.city` at dispatch time, so it cannot be overridden per task and is invisible at create time. Make the locality an explicit, REQUIRED, per-task snapshot chosen when creating a network task, while keeping the site as the fallback for legacy tasks.

## What changes
- BE: additive nullable column `ScheduledTask.iclassCityCode String?` (migration, no backfill).
  - CREATE kind='network' + blank iclassCityCode → 422 `NETWORK_TASK_LOCALITY_REQUIRED`.
  - UPDATE: only when the payload blanks iclassCityCode on an existing network task → 422.
  - Dispatch precedence to IClass: `task.iclassCityCode ?? networkSite.city ?? null` (in BOTH SendTaskToIClass and the shared dispatchTaskToIClass helper).
- FE: required "Localidad" dropdown in the network create-task modal, options from the IClass node catalog (by code), default = selected site's `city`, blocks canSave when blank, sent as `iclassCityCode`.

## Scope
- Backend: schema + migration, entity, DTO, guards, dispatch precedence, in-memory + prisma repos, errorHandler, routes.
- Frontend: CreateTaskModal locality dropdown + payload + types.

## Non-goals
- No backfill of existing tasks (they use the site.city fallback). No change to customer tasks. No change to node-code (`iclassNodeCode`) resolution.
