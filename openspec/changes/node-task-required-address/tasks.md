# Tasks: node-task-required-address (#53)

## Backend
- [x] 1. Test (red): CreateTask network + blank/whitespace address rejects; valid resolves; customer null OK.
- [x] 2. Test (red): UpdateTask network blank address rejects; omitted OK; customer blank OK.
- [x] 3. Test (red): route POST kind=network no address → 422 NETWORK_TASK_ADDRESS_REQUIRED.
- [x] 4. Add NetworkTaskAddressRequiredError (code NETWORK_TASK_ADDRESS_REQUIRED) in domain/errors/scheduling.ts.
- [x] 5. Guard in CreateTask network branch (after site existence check).
- [x] 6. Guard in UpdateTask (only when address sent blank for existing network task).
- [x] 7. Add NETWORK_TASK_ADDRESS_REQUIRED: 422 to errorHandler statusMap.
- [x] 8. In-route 422 catch in POST + PUT (mirror ProjectKindMismatchError).
- [x] 9. Green: `npx jest scheduling` (303 tests) + `npx tsc --noEmit` clean.

## Frontend
- [x] 10. Test (red): network mode node selected + blank address → Crear disabled; non-blank → enabled; asterisk visible; customer regression OK.
- [x] 11. CreateTaskModal canSave network arm requires address.trim().
- [x] 12. Conditional Dirección asterisk in network mode.
- [x] 13. Green: `npx vitest run src/__tests__/scheduling/` (630 tests) + typecheck clean.
