# Design: Scheduling Module Hardening

## Technical Approach

Apply the five fixes from `proposal.md` (auth, type relaxation, `toTask` bug, `updateTaskStatus` missing `include`, zod validation) in a single PR. Auth mirrors the `clients.routes.ts:94` per-route pattern. Validation uses `zod` (newly added, `^4.4.3`) with schemas co-located in `src/application/dto/scheduling.dto.ts`. Domain entity is relaxed to `string | null` for five fields so the adapter's existing `?? null` writes stop lying about types. Tests use TDD: failing tests first, then implement. Hexagonal boundary is preserved — schemas live in `application/dto` and import nothing from `@infrastructure/*`.

## Architecture Decisions

### Decision 1 — Zod schemas in `application/dto/scheduling.dto.ts`
- **Choice**: Co-locate zod schemas with existing DTO types (`tickets.dto.ts` precedent).
- **Alternatives**: (a) inline in route file, (b) new `src/infrastructure/http/validators/` folder.
- **Rationale**: DTOs already describe input shapes in `application/dto/`. Zod schemas are runtime DTOs — same role, same layer. Inline pollutes routes; a `validators/` folder fragments input contracts across two locations. `application/dto` is hex-safe: pure value definitions, no infrastructure imports.

### Decision 2 — Validate in route handler, NOT in use-case
- **Choice**: `safeParse` runs in the route handler immediately after `auth`. Use-case receives a validated, typed object.
- **Rationale**: Validation is an HTTP/input concern. Use-cases stay pure and reusable (a CLI or job runner could call them with already-validated data). This becomes the **project convention** for input validation going forward.

### Decision 3 — Auth middleware applied per-route
- **Choice**: `const auth = createAuthMiddleware(authProvider)` once at top of `createSchedulingRouter`, attach as second arg on every `router.METHOD('/path', auth, handler)`. Exact mirror of `clients.routes.ts:94`.
- **Alternatives**: `router.use(auth)` once.
- **Rationale**: Match existing convention across `clients.routes.ts`, `tickets.routes.ts`, `billing.routes.ts`. Per-route is more explicit and supports future public sub-routes without inverting middleware order.

### Decision 4 — Test auth via fake `JwtAuthAdapter` + `cookie-parser`
- **Choice**: `buildApp({ authed: boolean })` mounts `cookieParser()` and a fake whose `getSession(token)` returns a static `User` (or throws `AuthenticationError`). Tests send `.set('Cookie', 'auth_token=fake')` to authenticate.
- **Alternatives**: (a) Mock middleware that bypasses auth entirely; (b) real `JwtAuthAdapter` with a real signed token + `JWT_SECRET` in test env.
- **Rationale**: Fake adapter exercises the real `createAuthMiddleware` (cookie read, 401 branch, `req.user` injection) — closest to production. Bypassing the middleware skips the very code we are adding. Real JWT couples tests to `config.jwtSecret` and bcrypt cost.

### Decision 5 — Null convention in `toTask`; `?? undefined` is a bug
- **Choice**: Every nullable column uses `?? null` in `toTask`. The current `description: row.description ?? undefined` on `PrismaSchedulingRepository.ts:9` is a typed bug (entity will say `string | null`, value is `undefined`) — change to `?? null`. Domain `ScheduledTask` fields `description | assignedTo | assignedToId | address | notes` become `string | null`.
- **Rationale**: Prisma columns are `String?` (nullable). `undefined` in JSON serializes to omitted property; `null` serializes to `null`. Frontend already handles `null` (per coordination note). One consistent convention beats two.

## Data Flow

```
Request
  ├─> cookie-parser            (reads auth_token cookie)
  ├─> authMiddleware (auth)    ──[no/invalid cookie]──> 401 UNAUTHORIZED
  │     sets req.user
  ├─> zod safeParse(req.body)  ──[parse failure]──────> 400 VALIDATION_ERROR
  ├─> route handler            (typed, validated input)
  ├─> use-case (application)   (pure orchestration)
  ├─> SchedulingRepository     (domain port)
  └─> PrismaSchedulingRepository (adapter) ─> Prisma ─> Postgres
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/application/dto/scheduling.dto.ts` | Create | Zod schemas: `CreateTaskSchema`, `UpdateTaskSchema`, `UpdateStatusSchema`; inferred types |
| `src/domain/entities/scheduling.ts` | Modify | Relax `description, assignedTo, assignedToId, address, notes` to `string \| null` |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modify | Line 9 `?? undefined` → `?? null`; `updateTaskStatus` add `include: { project: true }` |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modify | Add `authProvider` param, per-route `auth`, `safeParse` on POST/PUT/PATCH |
| `src/infrastructure/http/app.ts` | Modify | Line 515 only — pass `authAdapter` to `createSchedulingRouter` |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modify | Add `cookie-parser`, fake `JwtAuthAdapter`, cookie on every existing request, new 401/400 cases |

## Interfaces / Contracts

```ts
// src/application/dto/scheduling.dto.ts
import { z } from 'zod';

export const TaskStatusSchema   = z.enum(['pending','in_progress','completed','cancelled']);
export const TaskPrioritySchema = z.enum(['low','normal','high','urgent']);
export const TaskCategorySchema = z.enum(['installation','repair','maintenance','inspection','other']);

export const CoordinatesSchema = z.object({ lat: z.number(), lng: z.number() }).nullable();

export const CreateTaskSchema = z.object({
  title:          z.string().min(1),
  description:    z.string().nullable(),
  assignedTo:     z.string().nullable(),
  assignedToId:   z.string().nullable(),
  clientId:       z.string().nullable(),
  clientName:     z.string().nullable(),
  status:         TaskStatusSchema,
  priority:       TaskPrioritySchema,
  scheduledDate:  z.string().min(1),
  scheduledTime:  z.string().min(1),
  estimatedHours: z.number().nonnegative(),
  address:        z.string().nullable(),
  coordinates:    CoordinatesSchema,
  category:       TaskCategorySchema,
  projectId:      z.string().nullable().optional(),
  completedAt:    z.string().nullable(),
  notes:          z.string().nullable(),
});

export const UpdateTaskSchema   = CreateTaskSchema.partial();
export const UpdateStatusSchema = z.object({ status: TaskStatusSchema });

export type CreateTaskInput   = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput   = z.infer<typeof UpdateTaskSchema>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;
```

Error response (standardized for this module):

```ts
{ error: string, code: 'VALIDATION_ERROR', details: z.ZodIssue[] }
```

## Testing Strategy

| Layer | Scenario | Type |
|-------|----------|------|
| Schema | Valid/invalid payloads parse correctly | Unit (zod) |
| Route | GET/POST/PUT/PATCH/DELETE without cookie → 401 | Integration (supertest) |
| Route | POST with missing `title` → 400 `VALIDATION_ERROR` | Integration |
| Route | PATCH `/:id/status` with `status: 'bogus'` → 400 | Integration |
| Route | PATCH `/:id/status` success returns body with `projectName` field | Integration |
| Route | Existing happy paths still pass (with cookie set) | Integration |

No E2E. Fake `JwtAuthAdapter` exposes only `getSession`; `cookie-parser` mounted in `buildApp`.

## Migration / Rollout

No DB migration. Single deployable PR. Frontend coordination (per proposal §"Frontend Coordination"): FE relaxes the same five fields to `string | null` before/with merge.

## Open Questions

None.
