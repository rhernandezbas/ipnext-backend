# Archive Report — task-requires-service (Backend)

**Archived: 2026-05-30** · Verdict: PASS · Shipped.

## What shipped

`serviceId` made required at the application layer for `POST /api/scheduling`. The DB column `ScheduledTask.serviceId` stays `String?` (nullable, `onDelete: SetNull`) — constraint is enforced at app layer only (DTO + use case).

Changes:
- `application/dto/scheduling.dto.ts`: `serviceId` changed from `z.string().min(1).nullable().optional()` → `z.string().min(1)` in `CreateTaskBaseSchema`.
- `application/use-cases/CreateTask.ts`: removed `if (data.serviceId != null)` guard; `serviceLookup.findById` called unconditionally.
- `__tests__/application/CreateTask.test.ts`: inverted `serviceId: null` → success test; added required-field and bad-ref scenarios.
- `__tests__/infrastructure/scheduling.routes.test.ts`: added `POST /api/scheduling` without `serviceId` → 400 test.

## Spec synced

Canonical capability spec updated → `openspec/specs/scheduling/spec.md`.

Modified requirements:
- **REQ-VAL-1**: `serviceId` added to required fields (`z.string().min(1)`).
- **REQ-VAL-2**: `serviceId` remains optional in `UpdateTaskSchema`.
- **REQ-SHAPE-2**: `serviceId` added as non-nullable field.
- **REQ-CREATE-SERVICE-1–5** (new): HTTP-level contract for required `serviceId`.
- **REQ-UC-SERVICE-1** (new): use case validates `serviceId` unconditionally.
- **REQ-REF-SERVICE-1** (new): `ReferenceKind` includes `'service'`.

## Non-Goals (explicitly excluded)

- `PUT /api/scheduling/:id` — `serviceId` optional for edits (patch semantics preserved).
- DB migration — column stays nullable.
- Backfilling existing tasks.
