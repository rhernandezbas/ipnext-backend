# Tasks: Red/FO Switch (#66)

## Implementation Checklist

- [x] Migration: `20260708000000_scheduled_task_network_type/migration.sql` — ADD COLUMN networkType TEXT, ADD COLUMN networkSiteName TEXT, backfill red tasks.
- [x] Schema: `prisma/schema.prisma` — add `networkType String?` and `networkSiteName String?` to `ScheduledTask` model.
- [x] Domain entity: `src/domain/entities/scheduling.ts` — add `networkType: 'red' | 'fibra' | null`.
- [x] Domain error: `src/domain/errors/scheduling.ts` — add `NetworkTaskNodeNameRequiredError` (NETWORK_TASK_NODE_NAME_REQUIRED).
- [x] Port: `src/domain/ports/SchedulingRepository.ts` — add `networkType?`, `networkSiteName?` to `CreateTaskInput`; un-omit `networkSiteName` as input.
- [x] CreateTask guard: `src/application/use-cases/CreateTask.ts` — branch on red/fibra; locality optional for red; node-name + locality required for fibra.
- [x] UpdateTask guard: `src/application/use-cases/UpdateTask.ts` — locality guard scoped to fibra; add node-name guard for fibra.
- [x] DTO: `src/application/dto/scheduling.dto.ts` — add networkType (enum), networkSiteName (nullable) to NetworkTask + UpdateTaskSchema. Red requires networkSiteId (refine).
- [x] Route: `src/infrastructure/http/routes/scheduling.routes.ts` — pass networkType + networkSiteName through normalized create payload; handle NetworkTaskNodeNameRequiredError → 422.
- [x] Prisma adapter: `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` — toTask mapper (JOIN wins for red, stored for fibra), _buildCreateData, _buildUpdateData.
- [x] InMemory adapter: `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` — NEW_FIELDS_DEFAULTS, createTask, updateTask.
- [x] Dispatch: `src/application/use-cases/dispatchTaskToIClass.ts` — fibra branch for customerCode/customerName/address/city.
- [x] SendTaskToIClass: `src/application/use-cases/SendTaskToIClass.ts` — fibra: skip site lookup; validation + nodeCode from iclassCityCode.

## Tests (all passing — 55 total)

- [x] `CreateTask.networkType-fibra.test.ts` — 13 tests (fibra create guard)
- [x] `CreateTask.locality-guard.test.ts` — updated: red relaxed, fibra strict
- [x] `UpdateTask.locality-guard.test.ts` — updated: red relaxed, fibra strict
- [x] `SendTaskToIClass.fibra.test.ts` — 8 tests (fibra dispatch seam)
- [x] `SendTaskToIClass.network.test.ts` — red tests unchanged/passing
- [x] `SendTaskToIClass.locality-precedence.test.ts` — red tests unchanged/passing
- [x] `scheduling.network.routes.test.ts` — extended with 4 fibra route tests
- [x] `PrismaSchedulingRepository.networkNodeTask.test.ts` — extended with fibra mapper tests
