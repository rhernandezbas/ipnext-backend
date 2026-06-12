# Change: node-task-required-address (#53)

## Why
Node (network) tasks are dispatched to IClass, where the work address is a required OS field. Today a network task can be created without an address, surfacing the failure late (at dispatch, as MISSING_REQUIRED_FIELDS). Make address required up-front for network tasks, both in the API (422 guard) and the UI (canSave + asterisk).

## What changes
- BE: `ScheduledTask.address` already exists (String?) — no migration.
  - CREATE kind='network' + blank address → 422 `NETWORK_TASK_ADDRESS_REQUIRED`.
  - UPDATE: only when the payload SENDS a blank address for an existing network task → 422 (cannot blank out a network task's address). Customer tasks unaffected.
- FE: create-task modal network mode — Dirección required (asterisk + canSave). Autofill from the selected site already exists and stays editable.

## Scope
- Backend: domain error + guards in CreateTask/UpdateTask + errorHandler statusMap + route catch.
- Frontend: CreateTaskModal canSave + label.

## Non-goals
- No schema migration. No change to customer-task address behavior. No change to dispatch logic (#54 owns locality).
