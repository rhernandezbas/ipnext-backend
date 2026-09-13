# Proposal: Suricata bot autonomous actions — external write API

## Intent

The mirror panel proved the bot can decide; it still cannot act. Every real action (reply, close, status, note) requires a human running `atencion-suricata-ipnext` and typing "permiso ok". User decision 2026-09-13: the bot must act 100% autonomously, zero human checkpoint. This change gives the token-authenticated external API real write power over Suricata Cx.

**Superseding decision**: `suricata-tickets-mirror` explicitly listed "writing status back to Suricata" as out of scope. This proposal reverses that for close/status/note/reply. Assignment stays Prominense-only. The reversal is deliberate, not an oversight.

## Scope

### In Scope
- Four external write routes on `/api/external/v1/suricata`: reply, close, change status, internal note — each mirrored in Prominense AND executed in real Suricata.
- External read routes (list/detail) at parity with the internal session-gated ones.
- Wire `PlaywrightSuricataReply` for the **external** route only (CONFIRMED).
- New autonomous reply use case without the sha256 `confirm` mechanism (CONFIRMED — `confirm` exists to make a human re-confirm; meaningless here).
- New Playwright drivers for close / change-status / internal-note, all through `SuricataSession.withSession`.
- Append-only bot action audit: action, exact content, timestamp, machine actor — never indistinguishable from a human action (CONFIRMED, non-negotiable).
- New dark-by-default feature flags seeded `false`.

### Out of Scope
- Read-side sync pipeline (`SyncSuricataTickets`, `PlaywrightSuricataScraper`, `botpressMessages`) — in production, untouched.
- The `atencion-suricata-ipnext` skill and its "permiso ok" gate — unchanged.
- The internal `composeSuricataModule` reply route: keeps all three guards (flag / `suricata.reply` RBAC / `UnavailableSuricataReplyPort`).
- Assignment, priority, area write-back.
- Any second browser context — the shared session mutex is mandatory.

## Capabilities

### New Capabilities
- `suricata-external-actions`: token-auth external write routes for reply/close/status/note (auth, validation, flags, errors).
- `suricata-ticket-close`: close in Prominense mirror + real Suricata with an internal close reason.
- `suricata-ticket-status`: status change, both sides.
- `suricata-internal-note`: internal note posted in Suricata.
- `suricata-bot-action-audit`: append-only record of every autonomous action.
- `suricata-external-read`: external list/detail parity with internal read routes.

### Modified Capabilities
- `suricata-ticket-reply`: a second, zero-confirmation autonomous path is added; the human-supervised path is unchanged.

## Approach

Reuse the established external precedent verbatim: same router prefix, same `config.suricata.externalApiKey`, same `machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN)` — no new API key (CONFIRMED). Zod `safeParse` + `parseOr400`, per-route fail-closed flag check. Each action is a use case depending on a new domain port; Playwright adapters implement those ports and always acquire `SuricataSession.withSession`. Audit rows are written **before** the driver call ("audit the attempt, not the outcome", D10) and flipped after, outside the try. Strict TDD: use cases tested against in-memory ports; routes via supertest; no Prisma mocks.

## Decisions requiring user confirmation before spec/design

| # | Question | Recommendation | Tradeoff |
|---|---|---|---|
| 1 | Audit shape: one unified `SuricataBotActionAudit` (actionType + content) vs. per-action tables mirroring `SuricataReplyAudit` | **Unified** — "see everything the bot did" is one query, not four | Field shapes differ (body / close reason / status value / note text); needs a JSON payload column or nullable per-type columns |
| 2 | Feature-flag granularity: one flag for the whole surface vs. one per action | **Per action** — reply is irreversible and customer-facing; an internal note is not. Matches the project's narrow-flag precedent (`suricata-sync-enabled`, `suricata-reply-enabled`, `suricata-verdict-enabled`) | 4 new flags, all seeded `false` in one migration |
| 3 | Session priority for the new actions | **`high` for all four** — none should starve behind a 15-minute sync tick | Reply already justifies `high`; note/status arguably tolerate `low` |

## Known gap — blocking prerequisite

`selectors.ts` was live-verified 2026-09-13 for **login, ticket list and ticket detail only**. It has **zero** selectors for the bulk-actions modal ("Cerrar seleccionados" + close reason, "Cambiar Estado") and the internal-notes panel (`#internalNoteComentario`, "Crear"). The skill documents the manual click-path a human follows; nobody has captured the real DOM for automation. A live authenticated Playwright MCP verification pass against the real site is a **prerequisite**, not optional research — it blocks correctness exactly as the original scraper selectors did. The 60s auto-sync that redraws the table and clears checkbox selection must be handled by the driver the same way a human operator handles it.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | Bot action audit model; migration seeding 4 flags `false` |
| `src/domain/ports/suricata*` | New/Modified | Close/status/note ports; `setStatus`/`close` on `SuricataTicketRepository` |
| `src/domain/errors/suricata.ts` | Modified | Sibling errors reusing `SURICATA_UNAVAILABLE`, `SURICATA_SESSION_BUSY`, `FEATURE_DISABLED` |
| `src/application/use-cases/suricata/*` | New | Autonomous reply, close, status, note, external read |
| `src/infrastructure/adapters/suricata/*` | New/Modified | Close/status/note Playwright drivers + `selectors.ts` additions |
| `src/infrastructure/http/composeSuricataExternalModule.ts` | Modified | Four write routes + read routes |
| `src/infrastructure/http/app.ts` | Modified | Wire `PlaywrightSuricataReply` for the external composition only |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Bot sends a wrong reply to a real customer, no human to catch it | High | Per-action flags dark by default; full audit; staged rollout starting with note-only |
| Unverified DOM selectors silently no-op or click the wrong row | High | Live verification pass before implementation; assert post-conditions after each action |
| Suricata auto-sync clears selection mid-automation | Med | Driver disables/handles sync like the manual operator does |
| Session contention: four `high`-priority actions starve the sync lane | Med | Bounded timeout per action; sync tolerates a skipped tick |
| Prominense mirror and Suricata diverge on partial failure | Med | Suricata write first, mirror after; audit records the attempt regardless |

## Rollback Plan

Flip the four flags to `false` — the surface goes inert without a deploy. Next level: revert the external wiring of `PlaywrightSuricataReply` so the external path falls back to the unavailable port. Full revert = revert the branch; the audit model and flag rows are additive, no data loss. Replies, closes and notes already delivered to Suricata are irreversible — that is inherent to the autonomous design.

## Dependencies

- Live DOM verification of the close/status/note flows (blocking).
- Existing `SuricataSession` (mutex + advisory lock) and `config.suricata.externalApiKey`.
- `API_SURICATA_USER_LOGIN` machine actor row present via RBAC seed.

## Success Criteria

- [ ] A bot call with the Suricata external API key replies, closes, changes status and posts a note, each landing in real Suricata and in the mirror.
- [ ] Every action produces an audit row with action type, exact content, timestamp and machine actor.
- [ ] Each action is independently switchable via its own flag; all four ship `false`.
- [ ] The internal session-gated reply route still returns `SURICATA_UNAVAILABLE` — the human path is unchanged.
- [ ] No second Playwright context is ever created; all writes pass through `SuricataSession.withSession`.
- [ ] External list/detail return the same read model as the internal routes without a Suricata cookie.
