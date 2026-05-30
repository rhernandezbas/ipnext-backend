# Design: sessions-management

## Architecture Decisions

### AD-1: New `Session` tied to RbacUser (do NOT repurpose AdminSession)
`AdminSession` is legacy (FK→Admin), unused in code, and Admin is being retired in SDD #6. A fresh `Session` model on `RbacUser` keeps the model aligned with the real auth subject. `AdminSession` is left untouched (drops with Admin in #6).

### AD-2: tokenHash = sha256(jwt) — never store the raw token
On login we hash the signed JWT (`crypto.createHash('sha256').update(jwt).digest('hex')`) and store the hash. A leaked Session row cannot be replayed as a token. Lookups use the same hash. `SessionDto` never exposes `tokenHash`.

### AD-3: Where the stateful check lives — the auth middleware orchestrates
- **Identity** stays in `JwtAuthAdapter.getSession(token)` (pure JWT verify → `{id,username,email}`). Unchanged.
- **Revocation** is a new concern: the `authMiddleware` gains a `SessionRepository` dependency. Flow per request:
  1. `user = await authProvider.getSession(token)` (verify JWT).
  2. `session = await sessionRepo.findByTokenHash(sha256(token))`.
  3. If `!session || session.revokedAt` → 401.
  4. Attach `req.user`; throttled `sessionRepo.touch(session.id)`.
- Rationale: keeps `JwtAuthAdapter` single-responsibility (identity) and the session/revocation policy in the middleware (which already owns request gating). The domain owns the `SessionRepository` port; infrastructure injects the Prisma impl.

### AD-4: Session CREATION happens in the login route (it has the request)
`AuthProvider.login` returns `{ user, cookieValue (=JWT), cookieOptions }` — it has no `req`. So the **login route handler** (infrastructure) calls `CreateSession.execute({ rbacUserId: user.id, tokenHash: sha256(cookieValue), ip: req.ip, userAgent: req.get('user-agent') })` BEFORE setting the cookie. If it throws, respond 500 and do NOT set the cookie (fail-safe). This avoids leaking `req` into the domain.

### AD-5: Revocation is effective on the NEXT request
The auth check runs before the route handler. Revoking a session does not abort an in-flight request; the revoked token simply fails the next time. Documented; acceptable for an admin tool.

### AD-6: lastSeenAt throttled (> 5 min)
To avoid an UPDATE per request, `touch` only writes if `now - lastSeenAt > 5min`. The repo encapsulates the threshold (or the middleware checks the in-memory value first). Write amplification stays low.

### AD-7: Logout revokes the current session
The logout route computes `sha256(cookie)`, looks up the session, and revokes it (sets `revokedAt`), then clears the cookie. Idempotent if already revoked/absent.

### AD-8: Pre-#5 JWTs → 401 once on deploy
When the stateful check goes live, tokens issued before #5 have no `Session` row → 401 → forced re-login. One-time, acceptable. (No data migration backfills sessions for live tokens.)

### AD-9: Permissions
Add `view_sessions`, `revoke_sessions` to `KNOWN_ACTIONS` (rbac.ts), module `admin`. Endpoints: GET sessions → `admin.view_sessions`; revoke + revoke-all → `admin.revoke_sessions`. super_admin short-circuits; grant to administrador via the seed migration.

### AD-10: Hexagonal shape (mirror RbacUser)
- `domain/entities/session.ts`, `domain/ports/SessionRepository.ts`.
- `application/use-cases/sessions/`: `CreateSession`, `ListActiveSessions` (paginated, returns DTO with actorLogin), `RevokeSession` (404 if not found), `RevokeAllSessionsForUser`.
- `application/dto/session.dto.ts`: `SessionDto` (no tokenHash) + mapper.
- `infrastructure/adapters/prisma/PrismaSessionRepository.ts` + `in-memory/InMemorySessionRepository.ts`.
- `infrastructure/http/routes/sessions.routes.ts` + wire in app.ts (module-level `sessionRepo`, injected into authMiddleware + routes + login/logout routes).

### AD-11: FE — SessionsBody
New `src/pages/system/admin/SessionsBody.tsx` (+ module.css), rendered by AdminPage for the 'sesiones' tab. `useActiveSessions` (TanStack Query, paginated). Row action "Forzar logout" → `POST /sessions/:id/revoke` (confirm via `useConfirm`, tone danger). Per-user "revoke-all". Remove mock + access-history + policy panel.

---

## Migration Strategy

### Migration (additive + idempotent seed) — `create_session`
1. `CREATE TABLE "Session"` (generated via `prisma migrate diff` after adding the model) + indexes + FK to RbacUser (Cascade).
2. Idempotent seed of the 2 new permissions + grant to super_admin (mirror SDD #3 Phase 2 pattern):
```sql
-- seed admin.view_sessions + admin.revoke_sessions
INSERT INTO "RbacPermission" ("id","moduleId","action")
SELECT gen_random_uuid(), m."id", v."action"
FROM "RbacModule" m
JOIN (VALUES ('admin','view_sessions'), ('admin','revoke_sessions')) AS v("module_code","action")
  ON m."code" = v."module_code"
ON CONFLICT ("moduleId","action") DO NOTHING;

-- grant all permissions to super_admin (idempotent)
INSERT INTO "RbacRolePermission" ("roleId","permissionId","createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r CROSS JOIN "RbacPermission" p
WHERE r."code" = 'super_admin'
ON CONFLICT ("roleId","permissionId") DO NOTHING;
```
No drops, no data transformation → safe to deploy directly. Review SQL before push.

> Migration timestamp must be LATER than any concurrently-merged migration (check `prisma/migrations/` at apply time — there have been collisions with other agents' work).

---

## Testing Strategy (TDD)
- **Use cases** (in-memory `InMemorySessionRepository`): ListActiveSessions pagination + only-active filter; RevokeSession (404 unknown); RevokeAllSessionsForUser (count + only-active). DTO has no tokenHash.
- **Auth middleware** (supertest, in-memory): active session → 200; revoked → 401; valid JWT without session → 401; lastSeenAt throttle (no write within 5min). Mock/inject a fake authProvider + in-memory sessionRepo.
- **Login/logout routes**: login creates a session row; logout revokes it; post-logout request → 401.
- **Endpoints**: GET /admin/sessions (paginated, DTO no tokenHash, 403 without perm); revoke + revoke-all (200, 403, 404).
- **Contract tests** for SessionRepository (in-memory + Prisma skip-gated).
- **FE** (Vitest): useActiveSessions; SessionsBody renders rows + revoke triggers confirm + calls api; empty state.

## Open decision for apply
- `touch`/lastSeenAt throttle: implement threshold in the repo (compare stored lastSeenAt) vs middleware-level cache. → resolve in apply (repo-level is simpler, 1 read already done).
- Whether `getSession` stays pure and middleware does the session check (AD-3, preferred) vs folding into the adapter. → AD-3 stands unless apply reveals friction.
