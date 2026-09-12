# Proposal: Suricata tickets mirror — bot training & audit panel

## Intent

Customer-care tickets live in Suricata Cx, which has no REST API, so today the bot (a human running the `atencion-suricata-ipnext` skill by hand) leaves no measurable trace. We need a Prominense panel that mirrors those tickets locally and captures a structured bot verdict per ticket, producing the dataset that answers: how many tickets can the bot close alone vs. how many need a human.

## Scope

### In Scope
- Background sync job: headless Playwright session scrapes Suricata tickets, messages, attachments and the area catalog into Postgres via Prisma.
- Attachment migration to own storage during sync (external API consumers have no Suricata cookie).
- New domain entities/ports for Suricata ticket, message, attachment, verdict.
- Token-authenticated external API to submit a verdict: `{resuelto, analisis, motivo?, respuestaSugerida?}` (`motivo`/`respuestaSugerida` required when `resuelto=false`). Same endpoint for today's manual caller and a future autonomous bot.
- "Reply to customer" action driven by the server-side Playwright session, behind explicit double confirmation in the UI.
- Prominense-internal ticket assignment field.
- Panel UI: ticket list + filters (status, priority, area, bot state), detail with Conversation / AI Analysis / Client Data tabs, KPI strip.
- RBAC module/permissions for the panel and the external endpoint.

### Out of Scope
- Bot autonomy or any iteration of the `atencion-suricata-ipnext` skill.
- Writing status, assignment, priority or area back to Suricata (assignment is Prominense-only, confirmed).
- Live on-demand fetch when opening the panel (sync-only).
- Reusing or extending the internal `Ticket` entity — different domain.
- Any new Splynx dependency (none is added).

## Capabilities

### New Capabilities
- `suricata-ticket-mirror`: scheduled scrape + persistence of tickets, messages, attachments, area catalog.
- `suricata-bot-verdict`: verdict model plus token-authenticated external submission endpoint.
- `suricata-ticket-reply`: guarded Playwright-driven reply into a Suricata conversation.
- `suricata-tickets-ui`: panel list, filters, detail tabs and KPI strip.

### Modified Capabilities
- `rbac-permission-catalog-extension`: `RbacModuleCode` is a closed domain union; a Suricata module code must be added in domain code, not only seeded.

## Approach

Mirror-then-act. A scheduler lane (same pattern as existing cron/sync lanes) owns one authenticated Playwright session; a lock/queue serializes it between sync and reply so we never log in twice. Persistence and DTO mapping follow the existing hexagonal conventions; the external verdict route follows the `external-bulk-messaging` token-auth precedent. The frontend consumes read models only — the reply and verdict paths are explicit, auditable actions.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | New Suricata ticket/message/attachment/verdict models |
| `src/domain/entities`, `src/domain/ports` | New | Suricata entities + repository/scraper/storage ports |
| `src/domain/rbac` (`RbacModuleCode`) | Modified | New closed-union module code |
| `src/application/use-cases/suricata/*` | New | Sync, verdict submit, reply, list/detail |
| `src/infrastructure/adapters/suricata` (Playwright) | New | Scraper + reply automation + session lock |
| `src/infrastructure/scheduling` | Modified | Sync lane registration |
| `src/infrastructure/http/routes` | New | Internal panel routes + external verdict route |
| `src/infrastructure/http/app.ts` | Modified | ⚠️ God Object (3326 lines) — known collision risk |
| `ipnext-frontend/src/pages/suricata/*` | New | Panel, filters, detail tabs, KPIs (approved mockup) |
| `package.json` / Docker image | Modified | ⚠️ First headless browser in the backend runtime |

## Open Questions for `sdd-spec` / `sdd-design`

1. **Session lock strategy** — in-process mutex vs. DB advisory lock; behavior when a reply arrives mid-sync; login re-auth and cookie expiry handling.
2. **Area catalog sync** — full refresh per run vs. incremental; what happens to tickets referencing an area that disappeared.
3. **Backfill & pagination** — how far back the historical import goes, page traversal, idempotency key per ticket/message, retry/backoff policy.
4. **Scraping fragility** — detection and alerting when Suricata's DOM changes; does a failed run degrade silently or raise?
5. **Attachment storage** — target backend, retention, dedup, and how the external consumer authenticates to download.
6. **Verdict lifecycle** — one verdict per ticket or a revision history; what invalidates a verdict when new customer messages arrive.
7. **"Client Data" tab** — contents undefined in the approved mockup.
8. **Reply confirmation & audit** — what is recorded (actor, text, timestamp, outcome) and how a failed send surfaces.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Suricata UI change breaks scraping | High | Isolate selectors in one adapter; fail loudly with alerting; design decides detection |
| Playwright in production image (size, memory, crashes) | Med | Bounded concurrency, single session, restartable lane; evaluate image impact in design |
| Concurrent login from sync + reply locks/limits the Suricata account | Med | Explicit lock/queue design before implementation |
| Reply sent to a real customer in error | Med | Double confirmation, RBAC gate, full audit record |
| `app.ts` merge collisions with parallel sessions | Med | Keep wiring in one contiguous block; land early |
| Attachment storage growth / PII exposure | Low | Retention + authenticated download decided in design |

## Rollback Plan

Disable the sync lane flag and unmount the panel + external routes; Prisma models stay unused (additive migration, no data loss). Full revert = revert the feature branch and drop the additive migration. Suricata is never written to by the sync path, so nothing external needs undoing; only replies already sent are irreversible.

## Dependencies

- Valid Suricata Cx credentials/session reachable from the backend host.
- Playwright (new backend dependency) + browser binaries in the deploy image.
- Storage target for migrated attachments.
- `ipnext-frontend` change coordinated in the same delivery.
- Approved mockup: `suricata-tickets-mockup.html` (UX reference only).

## Success Criteria

- [ ] Sync populates tickets, messages, attachments and areas without manual intervention and is idempotent across runs.
- [ ] Attachments open from the panel and via the external API without a Suricata cookie.
- [ ] The external token-authenticated endpoint accepts a verdict and rejects `resuelto=false` without `motivo`/`respuestaSugerida`.
- [ ] A confirmed reply appears in the real Suricata conversation and is audited.
- [ ] Filters (status, priority, area, bot state) and KPIs (% bot-resolved, unreviewed, synced) reflect stored data.
- [ ] No Suricata write occurs for status, area or assignment.
