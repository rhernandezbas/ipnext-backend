# Tasks: node-task-required-locality (#54)

## Backend
- [x] 1. Test (red): CreateTask network + blank locality rejects; valid resolves; customer null OK.
- [x] 2. Test (red): UpdateTask network blank locality rejects; omitted OK; customer blank OK.
- [x] 3. Test (red): SendTaskToIClass precedence — snapshot wins / site fallback / both null → city missing.
- [x] 4. Test (red): route POST kind=network no iclassCityCode → 422 NETWORK_TASK_LOCALITY_REQUIRED.
- [x] 5. Schema: add iclassCityCode String? to ScheduledTask.
- [x] 6. Migration 20260701000000_scheduled_task_iclass_city_code (additive ADD COLUMN, no BEGIN/COMMIT). prisma generate.
- [x] 7. Entity + port (Omit + re-declare) + DTO field.
- [x] 8. NetworkTaskLocalityRequiredError + statusMap 422 + in-route catch (POST+PUT) + normalized passthrough.
- [x] 9. CreateTask + UpdateTask guards.
- [x] 10. Dispatch precedence in SendTaskToIClass AND dispatchTaskToIClass (shared helper — both!).
- [x] 11. InMemory + Prisma scheduling repos carry iclassCityCode.
- [x] 12. Update existing network fixtures to include iclassCityCode.
- [x] 13. Green: `npx jest scheduling` (306 tests) + full suite (3699) + `npx tsc --noEmit` clean.

## Frontend
- [x] 14. Test (red): network mode Localidad dropdown required/present, enables/disables canSave, payload carries code, default-from-site, customer regression.
- [x] 15. CreateTaskModal: useIClassNodes dropdown (network only) + default-from-site + fallback option + canSave + payload.
- [x] 16. types/scheduling.ts: CreateTaskPayload + ScheduledTask iclassCityCode.
- [x] 17. Green: `npx vitest run src/__tests__/scheduling/` (636 tests) + typecheck clean.
