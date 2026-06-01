# Change: session-expiration

## Why

Admin sessions never expire in the `Session` table. After login, `revokedAt`
stays `null` forever, so a session keeps showing as "active" in the admin panel
even though its JWT (8h `MAX_AGE_SECONDS`) has long since expired and the cookie
is dead. There is no notion of inactivity timeout either: a session abandoned
mid-shift is indistinguishable from a live one. This is misleading for operators
auditing who is logged in and weakens the security posture of stateful auth.

## What changes

Introduce automatic session expiration with two independent caps:

1. **Inactivity (1h):** a session dies 1 hour after its last activity
   (`lastSeenAt`). Already-tracked via the 5-min touch throttle in the middleware.
2. **Absolute (8h):** a session dies 8 hours after login, aligned to the JWT
   `MAX_AGE_SECONDS = 28800`. Materialised as a new `expiresAt` column.

A session is **alive** iff: `revokedAt IS NULL AND expiresAt > now() AND
lastSeenAt > now() - 1h`. This single predicate (`isSessionAlive`) governs the
auth middleware, the active-sessions list and the session-history list, so the
three can never drift.

### Scope

- **Schema:** add nullable `expiresAt DateTime?` to `Session` (additive migration
  + backfill `loginAt + 8h` for existing rows).
- **Domain:** new `session.policy.ts` with `isSessionAlive`, `INACTIVITY_TTL_MS`
  (1h), `ABSOLUTE_TTL_MS` (8h).
- **Repositories (Prisma + InMemory):** stamp `expiresAt = loginAt + 8h` on
  create; `findByTokenHash` and `listActive` return only alive sessions;
  `findRevoked` (history) now returns every *inactive* session (revoked OR
  expired OR idle).
- **Middleware:** reject a non-alive session with 401, same as a revoked one
  (defence in depth on top of the repo filtering).
- **DTO:** expose `expiresAt` in `SessionDto` (still no `tokenHash`).

### Out of scope

- No background reaper/cron to hard-delete expired rows (history relies on them).
- No change to JWT `MAX_AGE_SECONDS` or cookie behaviour.
- No per-role or configurable TTLs (constants are fixed for now).

## Impact

- Affected specs: `session-expiration` (new capability).
- Affected code: `prisma/schema.prisma`, new migration,
  `src/domain/entities/session.{ts,policy.ts}`, `SessionRepository` port,
  `PrismaSessionRepository`, `InMemorySessionRepository`, `authMiddleware`,
  `session.dto`.
- Behaviour change: sessions that are expired/idle disappear from the active
  list and start returning 401; they surface in session history instead.

## Rollback plan

The migration is purely additive (one nullable column + a guarded backfill).

- **Data rollback:** `ALTER TABLE "Session" DROP COLUMN "expiresAt";` — nothing
  else depends on the column.
- **Code rollback:** revert the change set; `isSessionAlive` and all references
  go away. With `expiresAt` gone, `listActive`/`findByTokenHash` fall back to the
  previous `revokedAt IS NULL` semantics.
- The backfill is idempotent (`WHERE "expiresAt" IS NULL`) and the `ADD COLUMN`
  uses `IF NOT EXISTS`, so re-running the migration is safe.
