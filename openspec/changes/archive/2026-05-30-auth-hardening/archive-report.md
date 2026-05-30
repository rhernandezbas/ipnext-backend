# Archive Report — auth-hardening (SDD #6a)

**Archived: 2026-05-30** · Verdict: PASS · Shipped to production.

## What shipped (first slice of SDD #6 security-hardening)
Login hardening: cookie `secure` controllable via COOKIE_SECURE env (decoupled from NODE_ENV); helmet security headers; CORS origin from env; rate limit on POST /login (express-rate-limit) behind `trust proxy`; account lockout (5 fails → 15min, AccountLockedError 423); password policy (min 10 + letter + digit) on create/change.

## Commits (ipnext-backend)
- e383b7a0 P1 (cookie secure + helmet + CORS), de168eb6 P2 (rate limit), 96d5fcb7 P3 (lockout), aea2626c P4 (password policy), 9ca626bf P5 (deploy.yml forward COOKIE_SECURE/CORS_ORIGIN + doc). Deployed run 26687911316.

## Migration (applied in prod)
- 20260530030000_rbac_user_lockout — additive ALTER RbacUser ADD failedLoginCount + lockedUntil.

## Ops
- COOKIE_SECURE GH secret = false (prod is HTTP; flip to true once HTTPS is in front). Runtime env vars are GH secrets forwarded by deploy.yml "Deploy container" — documented in WORKFLOW-MULTI-REPO.md.

## Spec synced
Canonical capability spec → openspec/specs/auth-hardening/spec.md.

## Follow-ups (deferred)
HTTPS in front of prod (then COOKIE_SECURE=true). Remaining #6 slices: #6c session-policy enforcement, #6b refresh tokens, #6e admin-legacy-drop, #6d 2FA on RbacUser.
