# Design — sessions-history (Backend)

**Change**: `sessions-history`
**Repo**: `ipnext-backend`
**Architecture**: Hexagonal (domain ← application ← infrastructure). Ports first, DTOs at the boundary, use-cases depend ONLY on ports — never on `@infrastructure/*`.
**Invariant**: `ListSessionHistory` MUST NOT import from `@infrastructure/*`. `tokenHash` MUST NOT appear in any DTO.

---

## 1. Endpoint shape — DECISION: dedicated `/history` vs. query param `?includeRevoked`

**Two approaches considered:**

### Option A — Query param `?includeRevoked=true` on existing `GET /api/admin/sessions`
- Single endpoint, single router, backward compat trivially visible.
- **Problem**: violates "single responsibility" at the HTTP surface — the endpoint now has two modes with very different result shapes (`lastSeenAt` vs. `revokedAt`). The `where` logic in the port becomes conditional, the DTO union becomes leaky. Consumers must check `?includeRevoked` state to know what they get.
- **Problem**: every future consumer of active sessions would see the `revokedAt` field even when not needed. DTO bloat.

### Option B (CHOSEN) — Dedicated `GET /api/admin/sessions/history`
- Separate concern, separate resource. Active sessions and revoked sessions are semantically orthogonal reads — they should be separate endpoints.
- `SessionRepository` gets a narrow `findRevoked(page, pageSize)` method that is PURPOSE-BUILT: `WHERE revokedAt IS NOT NULL ORDER BY revokedAt DESC`. No conditionals in the port.
- `ListActiveSessions` is UNTOUCHED. No risk of regression.
- The DTO shape for history (`revokedAt` populated, `lastSeenAt` present but semantically irrelevant) reuses `SessionDto` — no new DTO needed (the field was already `revokedAt: string | null` in the existing type; for revoked sessions it is always non-null).
- Response envelope: `{ data: SessionDto[], total, page, pageSize }` (uses `data` key to align with the spec; internally the use-case produces `SessionPageDto` with `items` key — the route handler remaps `items → data`).

**Rationale**: dedicated endpoint is cheaper to test, cheaper to rollback independently, and doesn't entangle the semantics of two different session states.

---

## 2. Port extension — `SessionRepository.findRevoked`

**New method on the port interface** (`src/domain/ports/SessionRepository.ts`):

```ts
findRevoked(page: number, pageSize: number): Promise<SessionPage>;
```

`SessionPage` is already defined in the port (`{ items: Session[], total, page, pageSize }`). Reusing it avoids a new interface. Sorting (`revokedAt DESC`) is the REPOSITORY's responsibility per invariant I-3.

**No new query type** — `findRevoked` takes primitive params directly; the clamp to max 100 is owned by the use-case (same pattern as `ListActiveSessions` clamping to `MAX_PAGE_SIZE`).

---

## 3. Use case — `ListSessionHistory`

File: `src/application/use-cases/sessions/ListSessionHistory.ts`

Pattern mirrors `ListActiveSessions` exactly:

```
DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 20   ← differs from ListActiveSessions (20 vs 50 per spec)
MAX_PAGE_SIZE = 100       ← spec hard limit
```

- Validates and clamps `page` and `pageSize` before delegating to `repo.findRevoked`.
- Returns `SessionPageDto` — no new DTO type; `toSessionDto` already strips `tokenHash`.
- Throws `VALIDATION_ERROR` for `pageSize > 100` (400 is enforced at the HTTP layer via the route handler checking the raw query param before calling the use case, or the use case can throw — see section 4).

**DECISION: pageSize > 100 validation lives in the route handler** (not the use case). Rationale: `ListActiveSessions` clamps silently; the spec says 400 for `pageSize > 100`. A 400 is an HTTP concern. The route reads the raw query, checks `pageSize > 100`, and returns 400 immediately — consistent with how Zod-based routes handle validation errors in this codebase.

---

## 4. HTTP route — `GET /api/admin/sessions/history`

**CRITICAL: mount order.** The sessions router currently has `/:id/revoke` catch-all patterns. If `GET /history` is added as a sub-route INSIDE the existing router, Express matches top-to-bottom — `/history` must be declared BEFORE `/:id/*` patterns to avoid Express treating `"history"` as an `:id`.

**Solution**: add `GET /history` at the TOP of `createSessionsRouter`, before the `/:id/revoke` and `/user/:userId/revoke-all` routes. Since `GET` ≠ `POST`, there is no actual conflict with the existing `POST /:id/revoke`, but placing it first is defensive and documents intent.

**Updated router signature:**

```ts
export function createSessionsRouter(
  listActive: ListActiveSessions,
  listHistory: ListSessionHistory,   // NEW
  revokeSession: RevokeSession,
  revokeAll: RevokeAllSessionsForUser,
  requireView: RequestHandler,
  requireRevoke: RequestHandler,
): Router
```

**Handler logic:**

```
GET /history
  1. requireView guard
  2. parse page (default 1), pageSize (default 20)
  3. if pageSize > 100 → 400 { code: 'VALIDATION_ERROR', message: 'pageSize máximo es 100' }
  4. const result = await listHistory.execute({ page, pageSize })
  5. res.json({ data: result.items, total: result.total, page: result.page, pageSize: result.pageSize })
```

Response key is `data` (not `items`) to match the spec scenario shape. The use-case returns `SessionPageDto` (with `items`); the route handler does the trivial rename at the boundary.

---

## 5. DTO — no new type needed

`SessionDto` already has `revokedAt: string | null`. For history items, `revokedAt` is always non-null. The `toSessionDto` mapper already explicitly enumerates fields and EXCLUDES `tokenHash`. No changes to `session.dto.ts`.

The response envelope for the history endpoint (`{ data, total, page, pageSize }`) is assembled inline in the route handler from the existing `SessionPageDto` shape. No new DTO file.

---

## 6. InMemory adapter implementation

`InMemorySessionRepository.findRevoked(page, pageSize)`:

```ts
async findRevoked(page: number, pageSize: number): Promise<SessionPage> {
  const rows = this.store
    .filter(s => s.revokedAt !== null)
    .sort((a, b) => (a.revokedAt! < b.revokedAt! ? 1 : a.revokedAt! > b.revokedAt! ? -1 : b.__seq - a.__seq));
  const total = rows.length;
  const start = (page - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize).map(s => this.clean(s)), total, page, pageSize };
}
```

Tie-break by `__seq DESC` (same pattern as `listActive`) for deterministic ordering when multiple sessions share the same `revokedAt` timestamp.

---

## 7. Prisma adapter implementation

`PrismaSessionRepository.findRevoked(page, pageSize)`:

```ts
async findRevoked(page: number, pageSize: number): Promise<SessionPage> {
  const where = { revokedAt: { not: null } };
  const [rows, total] = await Promise.all([
    (this.db as any).session.findMany({
      where,
      orderBy: { revokedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    (this.db as any).session.count({ where }),
  ]);
  return { items: rows.map(mapRow), total, page, pageSize };
}
```

Uses `{ not: null }` Prisma filter — functionally `WHERE revokedAt IS NOT NULL`. Consistent with how `listActive` uses `{ revokedAt: null }` for the inverse.

**No migration required.** The `revokedAt` column already exists. An index on `revokedAt` is a performance optimization deferred to a separate migration (acknowledged in proposal).

---

## 8. App.ts wiring

In `createApp()`, after existing session use-case instantiation:

```ts
import { ListSessionHistory } from '@application/use-cases/sessions/ListSessionHistory';
// ...
const listSessionHistory = new ListSessionHistory(sessionRepo);
// ...
app.use('/api/admin/sessions', createSessionsRouter(
  listActive,
  listSessionHistory,   // NEW param
  revokeSession,
  revokeAll,
  requirePerm('sessions', 'view'),
  requirePerm('sessions', 'revoke'),
));
```

The `sessionRepo` singleton is already declared at module level — `listSessionHistory` reuses it, no new repo instance needed.

---

## 9. Test strategy

### Unit (in-memory, TDD)
- `ListSessionHistory.test.ts`: 6+ scenarios covering REQ-SH-1 through REQ-SH-4. Uses `InMemorySessionRepository.seed()` to set up revoked/active sessions with explicit `revokedAt` timestamps.

### Integration (supertest)
- `sessions.history.integration.test.ts`: 4+ scenarios. Mirrors the pattern of existing session integration tests (inject InMemory repo into `createSessionsRouter`, wrap with minimal Express app).

Test scenarios (mandatory):
1. Returns only revoked sessions, ordered `revokedAt DESC`, with correct envelope keys.
2. Returns `{ data: [], total: 0 }` when no revoked sessions exist.
3. Active sessions are excluded (`revokedAt: null` records absent from response).
4. Second page returns correct slice when `total > pageSize`.
5. `pageSize > 100` returns 400 `VALIDATION_ERROR`.
6. `tokenHash` is absent from all items.
7. 401 when no auth token.
8. `GET /api/admin/sessions` still returns only active sessions (non-regression).
