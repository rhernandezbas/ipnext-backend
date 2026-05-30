# Verify Report — auth-hardening (SDD #6a)

**Verdict: PASS** · Verified 2026-05-30 · Deployed to production.

## Against spec (specs/auth-hardening/spec.md)
- REQ-AH-COOKIE-1 ✅ JwtAuthAdapter cookie `secure` from config.cookieSecure (COOKIE_SECURE env), decoupled from NODE_ENV. **PROD = HTTP → COOKIE_SECURE=false** (true would drop the cookie over HTTP and break login). Set to true only once HTTPS is in front. Unit-tested true/false.
- REQ-AH-CORS-1 ✅ cors origin from config.corsOrigin (CORS_ORIGIN env, `||` fallback to localhost:5173).
- REQ-AH-HEADERS-1 ✅ helmet() mounted in app.ts.
- REQ-AH-RATELIMIT-1 ✅ express-rate-limit on POST /login (15min/10/IP → 429 RATE_LIMITED) + app.set('trust proxy', 1). Unit-tested.
- REQ-AH-LOCKOUT-1 ✅ RbacUser failedLoginCount/lockedUntil; 5 fails→lock 15min; locked→AccountLockedError(423) before pw check; success resets; unknown→generic. Unit-tested (4).
- REQ-AH-PWPOLICY-1 ✅ validatePassword (min10+letter+digit) in CreateRbacUser+ChangeRbacUserPassword → PasswordPolicyError(400). Unit-tested.

## Tests
- Backend: `npx jest` → 1694 passed / 86 skipped. tsc --noEmit clean.

## Deploy
- Backend run 26687911316 SUCCESS (1m36s) — migration 20260530030000_rbac_user_lockout (additive) applied. COOKIE_SECURE=false forwarded to the prod container via deploy.yml (GH secret).
- env wiring: deploy.yml "Deploy container" forwards COOKIE_SECURE + CORS_ORIGIN from GH secrets (documented in WORKFLOW-MULTI-REPO.md). COOKIE_SECURE secret set to false (HTTP prod).
- Playwright smoke (prod): login still works (COOKIE_SECURE=false did NOT break it over HTTP). Lockout/rate-limit NOT exercised destructively in prod (unit-tested; locking a real account is risky).

## Warnings / follow-ups
- **COOKIE_SECURE stays false until prod is behind HTTPS.** That's the real remaining hardening (infra: TLS/reverse proxy). Then flip the GH secret to true.
- Rate limit window/limit (15min/10) + lockout (5/15min) are conservative defaults; tune if needed.
- CORS_ORIGIN secret unset → defaults to localhost:5173 (current behavior; set to the real prod origin if the API ever serves cross-origin).
- Deferred #6 slices: #6c session-policy, #6b refresh-tokens, #6e admin-legacy-drop, #6d 2FA-on-RbacUser.
