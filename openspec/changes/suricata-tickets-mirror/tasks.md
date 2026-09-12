# Tasks: Suricata tickets mirror — bot training & audit panel

TDD convention (Strict TDD Mode): each `TDD` bullet = write the failing test first (RED), then the
minimal code to pass (GREEN). One REFACTOR pass closes each phase. No Prisma mocks — use cases
test against InMemory ports.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~3200–4500 (BE ~2600–3600 incl. tests; FE ~900–1400; infra ~40) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | BE PR1→PR6 (stacked, dark) · FE PR1→PR3 (stacked) · Infra PR isolated |
| Delivery strategy | ask-on-risk (default, not overridden by orchestrator) |
| Chain strategy | pending — recommend stacked-to-main (matches D14 dark-merge rollout) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| BE-1 | Migration + RBAC `suricata` module + `app.ts` wiring stub (501) | PR BE-1 | `npm test -- suricata-rbac external-bulk-messaging-composition` | N/A — dark, no live flags | revert 2 mount lines + migration is additive |
| BE-2 | `SuricataSession` mutex + advisory lock | PR BE-2 | `npm test -- suricata-session` | N/A — pure unit | delete new file, unused by anyone yet |
| BE-3 | Sync capability (scraper port, Prisma/InMemory repos, use case, scheduler) | PR BE-3 | `npm test -- suricata-sync suricata-content-hash` | `SURICATA_BROWSER_WS` empty ⇒ scheduler null; smoke needs D5 sidecar | flag `suricata-sync-enabled=false`, scheduler no-ops |
| BE-4 | Verdict capability + external routes | PR BE-4 | `npm test -- suricata-verdict externalV1.suricata` | curl with `SURICATA_EXTERNAL_API_KEY` against dev server | unmount external router, table stays unused |
| BE-5 | Reply capability + internal reply route | PR BE-5 | `npm test -- suricata-reply` | manual smoke only after D5 + human OK (D14 step 5) | flag `suricata-reply-enabled=false` |
| BE-6 | Panel read routes (list/detail/kpis/assignee) | PR BE-6 | `npm test -- suricata.routes` | `curl /api/suricata/tickets` with session cookie | unmount internal router |
| FE-1 | List + filters + KPI strip | PR FE-1 | `npm test -- SuricataList` | `npm run dev` against BE-6 | remove page, route unregistered |
| FE-2 | Detail view: Conversation/AI Analysis/Client Data tabs | PR FE-2 | `npm test -- SuricataDetail` | `npm run dev`, open a mirrored ticket | remove detail route |
| FE-3 | Reply action (double confirm) + assignment field | PR FE-3 | `npm test -- SuricataReply` | manual smoke only after BE-5 flag ON | hide button behind RBAC, no BE change |
| INFRA-1 | Sidecar container + `deploy.yml` step (already authorized, isolated) | PR INFRA-1 | `npm test -- suricata-playwright-version` | `docker run` sidecar + `chromium.connect(ws)` smoke | `docker rm -f ipnext-playwright`, revert step |

---

## Phase A — BE Slice 0: schema, RBAC module, wiring stub (repo: ipnext-backend)

- [ ] A.1 Edit `prisma/schema.prisma`: add 7 models per design D1 (`SuricataArea`, `SuricataTicket`, `SuricataMessage`, `SuricataAttachment`, `SuricataTicketVerdict`, `SuricataReplyAudit`, `SuricataSyncRun`).
- [ ] A.2 Edit `src/domain/entities/rbac.ts`: append `'suricata'` to `RBAC_MODULES` with the D2 justification comment; actions `read`, `manage`, `reply` (per spec RBAC-EXT-2 — see Risks: conflicts with design D2's `send` reuse, follow spec literally).
- [ ] A.3 TDD RBAC-EXT-1/EXT-2: unresolved `'ghost'` module fails `tsc --noEmit`; `RBAC_MODULES` contains `suricata` with 3 actions — `src/__tests__/domain/rbac.test.ts`.
- [ ] A.4 Generate `prisma/migrations/<ts>_suricata_tickets_mirror/migration.sql` via `prisma migrate diff --from-schema-datamodel` (no local DB, per `WORKFLOW-MULTI-REPO.md`); hand-append RBAC seed (`suricata.read/manage/reply`, `ON CONFLICT DO NOTHING`, grant `super_admin`) + 2 feature flags (`suricata-sync-enabled`, `suricata-reply-enabled`, both `false`). No `BEGIN`/`COMMIT`.
- [ ] A.5 Create `src/infrastructure/http/composeSuricataModule.ts` and `composeSuricataExternalModule.ts` returning `501` stub routers.
- [ ] A.6 Edit `src/infrastructure/http/app.ts`: add import + 2 marked mount blocks per D8 (internal after `/api/assistant`, external before the global external-v1 catch-all — order load-bearing).
- [ ] A.7 TDD composition: mount index of `/api/external/v1/suricata` `<` index of `/api/external/v1` — extend `src/__tests__/infrastructure/external-bulk-messaging-composition.test.ts` pattern in a new `suricata-composition.test.ts`.
- [ ] A.8 REFACTOR pass: confirm `tsc --noEmit` clean, `npm test` green.

## Phase B — BE session lock (repo: ipnext-backend)

- [ ] B.1 TDD `SuricataSession` (D4): `high` jumps queued `low`; FIFO within a level; timeout ⇒ `SuricataSessionBusyError`; mutex releases even if `fn` throws — `src/__tests__/infrastructure/suricata-session.test.ts`, implement `src/infrastructure/adapters/suricata/SuricataSession.ts` (in-process mutex, molde `CampaignRunner.heldInProcess`, + `PgAdvisoryLock('suricata-session')` reuse).
- [ ] B.2 TDD `ensureAuthenticated`: DOM-marker classification, single re-login + single retry, second failure ⇒ `SuricataAuthError` — same test file, mock `BrowserContext`.
- [ ] B.3 Edit `src/infrastructure/config.ts`: add `suricata.*` block (D11), not in `REQUIRED_VARS`.

## Phase C — BE sync capability (repo: ipnext-backend)

- [ ] C.1 Add domain ports `src/domain/ports/SuricataScraperPort.ts`, `SuricataTicketRepository.ts`, `SuricataMessageRepository.ts`, `SuricataAttachmentRepository.ts`, `SuricataAreaRepository.ts`, `SuricataSyncRunRepository.ts` + entities in `src/domain/entities/suricata.ts`.
- [ ] C.2 TDD `contentHash` (canonical render, order-independent) — unit test + `src/domain/entities/suricataContentHash.ts` (or colocated helper).
- [ ] C.3 Create `src/infrastructure/adapters/suricata/selectors.ts` (named selector constants, D6.d) and HTML fixtures (list/detail-with-attachment/empty-list/DOM-changed) captured from real Suricata markup — producible, not plausible.
- [ ] C.4 TDD + implement `PlaywrightSuricataScraper` (parses via `selectors.ts`) and `FakeSuricataScraper` for tests, behind `SURICATA_BROWSER_WS`.
- [ ] C.5 Implement `InMemorySuricataTicketRepository/MessageRepository/AttachmentRepository/AreaRepository/SyncRunRepository` and their `Prisma*Repository` counterparts.
- [ ] C.6 TDD `SyncSuricataTickets` use case (MIRROR-1..6, D6): first-run backfill within `SURICATA_BACKFILL_DAYS`/`SURICATA_MAX_PAGES_PER_RUN`; incremental run after watermark; idempotent re-run (same counts); one failing ticket isolated, batch continues; 0 tickets ⇒ `outcome='failed'`, zero writes; area disappearance ⇒ `active=false`, ticket keeps its `areaId`.
- [ ] C.7 TDD attachment migration (MIRROR-7): `context.request.get` → `FileStorage.save('suricata/<sha256>')`, dedup by content, `attempts` cap 5 ⇒ `status='failed'`, `SURICATA_MAX_ATTACHMENT_BYTES` ⇒ `lastError='too_large'`.
- [ ] C.8 TDD MIRROR-8 (read-only guard): assert no write/update call reaches `SuricataScraperPort` mock during a sync run.
- [ ] C.9 Create `src/infrastructure/scheduling/SuricataSyncScheduler.ts` (molde `ChatMediaDownloadScheduler`, flag `suricata-sync-enabled`, advisory lock, `setInterval` unref).
- [ ] C.10 Create `src/infrastructure/http/bootstrapSuricataSync.ts` (null if `SURICATA_BASE_URL`/`SURICATA_BROWSER_WS` unset); wire from `src/main.ts`.
- [ ] C.11 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase D — BE verdict capability (repo: ipnext-backend)

- [ ] D.1 Add `src/domain/ports/SuricataVerdictRepository.ts`; implement `InMemorySuricataVerdictRepository` + `PrismaSuricataVerdictRepository`.
- [ ] D.2 TDD `SubmitSuricataVerdict` use case (VERDICT-2..5): `resuelto=false` missing `motivo`/`respuestaSugerida` ⇒ `InvalidSuricataVerdictError`; unknown ticket ⇒ not-found error; append-only (2 submits ⇒ 2 rows); `latestByTicket` returns newest; `stale` derived when `ticketContentHash` differs from current.
- [ ] D.3 Create `src/domain/errors/suricata.ts` (`InvalidSuricataVerdictError`, `SuricataTicketNotFoundError`, `SuricataSessionBusyError`, `SuricataAuthError`).
- [ ] D.4 TDD external verdict route (VERDICT-1, RBAC-EXT-3): missing/unconfigured token ⇒ 401 before any logic; dedicated key ⇒ passes; global key ⇒ 401 (dedicated ≠ global); flag OFF ⇒ 403; malformed body via `parseOr400`/zod `safeParse` ⇒ 400 not 500; unknown ticket ⇒ 404; RBAC session alone ⇒ rejected — `src/__tests__/infrastructure/externalV1.suricata.routes.test.ts`.
- [ ] D.5 Implement route in `composeSuricataExternalModule.ts` (verdict `POST` + D7.c attachment `GET .../attachments/:id/content`, same router/flag/key).
- [ ] D.6 TDD D7.c: attachment id belonging to another ticket ⇒ 404 never 200; proxy streams via `FileStorage.get`, no signed URLs.
- [ ] D.7 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase E — BE reply capability (repo: ipnext-backend)

- [ ] E.1 Add `src/domain/ports/SuricataReplyPort.ts`, `SuricataReplyAuditRepository.ts`; implement `InMemorySuricataReplyAuditRepository` + `PrismaSuricataReplyAuditRepository`; implement `PlaywrightSuricataReply`/`FakeSuricataReply`.
- [ ] E.2 TDD `ReplyToSuricataTicket` use case (REPLY-1..6, D10): audit row written with `outcome='failed'` BEFORE `withSession`; `confirm` (sha256 of `body`) mismatch ⇒ port never invoked, no audit "sent"; port success ⇒ `markOutcome('sent', sentAt)`; port throws ⇒ audit stays `failed` with `error`, error propagates; text sent literally via `fill`/`type`, never `page.evaluate` interpolation.
- [ ] E.3 TDD internal reply route: missing `suricata.reply` permission ⇒ rejected before any Playwright action; flag OFF ⇒ 403; confirmation mismatch ⇒ 400 `REPLY_CONFIRMATION_MISMATCH`; session busy ⇒ 503 `SURICATA_SESSION_BUSY` + `Retry-After: 30`; auth failure ⇒ 502 `SURICATA_UNAVAILABLE` with `replyAuditId`.
- [ ] E.4 Implement `POST /api/suricata/tickets/:id/reply` in `composeSuricataModule.ts`.
- [ ] E.5 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase F — BE panel read routes (repo: ipnext-backend)

- [ ] F.1 TDD + implement `ListSuricataTickets`, `GetSuricataTicketDetail`, `ComputeSuricataKpis`, `SetSuricataAssignee` use cases against InMemory repos: each filter (status/priority/area/botState) independently; KPI percentages computed by hand in the test; `setAssignee` never calls any Suricata port.
- [ ] F.2 Implement `GET /api/suricata/tickets`, `GET /:id`, `GET /areas`, `GET /kpis`, `PATCH /:id/assignee` in `composeSuricataModule.ts`, gated by session + `suricata.read` (`manage` for assignee).
- [ ] F.3 TDD routes with supertest + InMemory repos seeded per scenario, including RBAC-gate 403 for missing permission — `src/__tests__/infrastructure/suricata.routes.test.ts`.
- [ ] F.4 Composition-root test: assert full `app.ts` wiring (both mounts + DI args) matches `composeSuricataModule`/`composeSuricataExternalModule` signatures — pin per repo's known "wiring is verified by hand" lesson.
- [ ] F.5 REFACTOR pass; `npm test` + `tsc --noEmit` green; delete Phase A stub 501 responses.

## Phase G — FE list + filters + KPIs (repo: ipnext-frontend)

- [ ] G.1 Read `suricata-tickets-mockup.html` (read-only) for layout reference.
- [ ] G.2 Create `ipnext-frontend/src/pages/suricata/api/suricataClient.ts` (typed client mirroring D13 DTOs field-by-field).
- [ ] G.3 TDD + implement `ipnext-frontend/src/pages/suricata/SuricataTicketList.tsx` + `.module.css`: filters (status/priority/area/botState), badges, assigned agent (UI-1).
- [ ] G.4 TDD + implement `SuricataKpiStrip.tsx`: 4 KPI values from `GET /kpis`, recompute after verdict (UI-6).
- [ ] G.5 Register route in FE router; gate visibility behind `suricata.read` permission.

## Phase H — FE detail tabs (repo: ipnext-frontend)

- [ ] H.1 TDD + implement `SuricataTicketDetail.tsx` (Conversation/AI Analysis/Client Data tabs, mirror-only, zero live Suricata calls) — UI-2.
- [ ] H.2 TDD + implement Conversation tab: ordered timeline, inline `<audio>` for audio attachments, not bare links (UI-3).
- [ ] H.3 TDD + implement AI Analysis tab: current verdict fields; explicit empty state when none (UI-4).
- [ ] H.4 TDD + implement Client Data tab: 5 sections per D13.b (history, current claim, same-root-cause flag, equipment/signal, GR debt), read-only, "sin cliente vinculado" when `clientId` is null (UI-5).

## Phase I — FE reply + assignment (repo: ipnext-frontend)

- [ ] I.1 TDD + implement double-confirm reply modal: shows final text, computes `sha256(body)` client-side, sends `{body, confirm}`; button disabled (not hidden) without `suricata.reply` (UI-8, D10).
- [ ] I.2 TDD + implement assignment field in detail view, `PATCH /assignee`, gated by `suricata.manage`.
- [ ] I.3 Handle 400/502/503 responses with visible error state, never a false-success toast (REPLY-5).

## Phase J — Infra: Playwright sidecar (ISOLATED, pre-authorized, own PR) (repo: ipnext-backend)

> Human OK already given for the sidecar approach (D5). Kept isolated because it touches shared
> CI/CD. Merge only after BE-3 exists so the sidecar has a consumer; can run in parallel otherwise.

- [ ] J.1 `package.json`: add `"playwright-core": "1.XX.Y"` pinned exact (no `^`).
- [ ] J.2 Edit `.github/workflows/deploy.yml`: add sidecar step before "Deploy container" (image `mcr.microsoft.com/playwright:v1.XX.Y-noble`, `--network ipnext-net --network-alias playwright --memory 1g --shm-size 1g --init`, port not published) + `-e SURICATA_BROWSER_WS=ws://playwright:3000/` on the BE container.
- [ ] J.3 TDD composition: `playwright-core` version in `package.json` === sidecar tag in `deploy.yml`, exact match, no `^` — `src/__tests__/infrastructure/suricata-playwright-version.test.ts`.
- [ ] J.4 Update `env.example` with `SURICATA_*` vars (D11); set real secrets via `gh secret set` (not committed).
- [ ] J.5 Manual smoke (D14 steps 2–5): flip `suricata-sync-enabled`, verify `SuricataSyncRun.outcome='ok'`; then flip `suricata-reply-enabled` and send ONE real reply to a hand-picked ticket.

## Key Open Item Surfaced (not a business decision — a spec/design conflict)

`suricata-ticket-reply` spec (REPLY-1) and `rbac-permission-catalog-extension` delta (RBAC-EXT-2)
both name a dedicated **`reply`** action code. Design D2 instead proposes reusing the existing
**`send`** action code (messaging precedent). Tasks A.2/A.4 follow the spec text literally because
its scenarios are testable contracts (`RbacModule` must expose `read/manage/reply`); flagging this
so the design gets reconciled or the spec amended before/at apply time.
