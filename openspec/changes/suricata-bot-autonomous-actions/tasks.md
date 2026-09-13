# Tasks: Suricata bot autonomous actions — external write API (reply/close/status/note)

TDD convention (Strict TDD Mode): each `TDD` bullet = write the failing test first (RED), then the
minimal code to pass (GREEN). One REFACTOR pass closes each phase. No Prisma mocks — use cases
test against InMemory ports (repo rule, molde `suricata-tickets-mirror/tasks.md`).

Delivery strategy: **single-pr** (user-confirmed 2026-09-13, no chained PRs). All phases below ship
in one PR; the phase split exists for sequencing/review clarity only, not for separate PRs.

## ⛔ Non-negotiable sequencing constraint (design D6)

Zero DOM selectors exist today for Suricata's close/status bulk-actions modal or the internal-notes
panel. **Phase B is a live, authenticated Playwright MCP verification pass against the real
`ipnext.suricata.cloud`** (same method already used 2026-09-13 for login/list/detail selectors in
`suricata-tickets-mirror`) that captures the real selectors into `actionSelectors.ts` — it MUST run,
and MUST be committed, **before any close/status/note driver implementation task** (Phases D/E/F).
No placeholder selector strings may ever be committed, not even as TODOs (design D6).

Phase B requires a human with Suricata credentials to type the password into the Playwright browser
window — **per this project's established rule, Claude fills the email field, a human types the
password.** This is a hard precondition of Phase B, not something an automated `sdd-apply` run can
silently skip or fake; if no human is available to complete the live pass, Phase B — and therefore
every phase after it — is BLOCKED, full stop.

**Discovered during this tasks pass (not in design.md as written) — flagged for `sdd-verify`:**
`src/infrastructure/adapters/suricata/selectors.ts`'s own header comment states the real Suricata
conversation thread renders inside a **cross-origin iframe** (`conversation.suricata.chat`) driven
by a live websocket — "mirroring message content is a separate, unsolved problem, not a selector
fix." `PlaywrightSuricataReply.sendMessage` (design D3 table: "exists; now wired for the EXTERNAL
path only") is, as of today, a narrow **structural interface with no real implementation** — the
mirror change's Phase J explicitly scoped the real Playwright driver to the sync/read lane only and
left `SuricataReplySession` unwired (`UnavailableSuricataReplyPort` is still hardcoded in `app.ts`
unconditionally). Design D3.b's claim that reply's driver "exists" undersells this: a *fake* type
exists, a *real* one sending into that iframe does not, and it may need a materially different
actuator (e.g. a websocket-driven send call) than plain `fill`/`type` on a normal form field. This
tasks file therefore extends Phase B's capture checklist to include the reply-send actuator, and
Phase G (reply, the last/highest-risk capability) is made an explicit dependent of Phase B for this
reason too, not only for its already-scheduled last-in-rollout-order position.

**RESOLVED 2026-09-13 (Phase B.7, live-verified end to end)**: the iframe is a dead end but
irrelevant — a real, backend-reachable, HTTP-only actuator exists (Botpress Chat API, same PAT
`botpressMessages.ts` already uses). Confirmed by an actual send to a real WhatsApp number. Phase G
below has been rewritten around this; it no longer touches `PlaywrightSuricataReply` at all.

**Note on flag key naming (spec vs design — flagged for `sdd-verify`, not silently resolved):**
The six spec files write example flag keys as `suricata-external-{reply,close,status,note}-enabled`.
`design.md` D2 deliberately chose `suricata-bot-{reply,close,status,note}-enabled` — the `-bot-`
infix is called out as load-bearing, to avoid one flip coupling the NEW autonomous route to the
EXISTING human-facing `suricata-reply-enabled` flag. No spec requirement asserts the literal string
is wire-visible (callers only ever observe `403 FEATURE_DISABLED`, never the key itself), so this is
a naming inconsistency between an illustrative example and a considered decision, not a behavioral
conflict. **Tasks below use design's `-bot-` naming** as the actual literal implemented; `sdd-verify`
should confirm this reading and, ideally, the spec files get a follow-up edit to match.

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2400–3300 (incl. tests; BE-only, no FE in this change) |
| Estimated files touched | ~30–34 (11 new domain/application files, 8 new infra/adapter files, 6 modified existing files, ~10 new/extended test files) |
| 400-line budget risk | **High** (estimated total well above 400 lines) |
| Chained PRs recommended | Not applicable — `delivery_strategy: single-pr` is user-confirmed; reported here for honesty only, does not block `sdd-apply` (review budget: unlimited, per orchestrator) |
| Decision needed before apply | No — single-PR delivery already locked in |

### Focused test commands per phase

| Phase | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|
| A | `npm test -- suricata-bot-action-audit suricata-bot-action.entity` | N/A — pure unit/in-memory | delete new files, migration is additive |
| B | N/A — manual live verification, no automated test | Playwright MCP against `ipnext.suricata.cloud`, human types password | discard `actionSelectors.ts` draft if capture fails, nothing else depends on it yet |
| C | `npm test -- externalV1.suricata.read` | curl with `SURICATA_EXTERNAL_API_KEY` against dev server | unmount 3 GET routes, zero flag involvement |
| D | `npm test -- suricata.AddSuricataInternalNote externalV1.suricata.note` | manual smoke only after flag ON + Phase B captured | flag `suricata-bot-note-enabled=false` |
| E | `npm test -- suricata.ChangeSuricataTicketStatus externalV1.suricata.status` | manual smoke only after flag ON + Phase B captured | flag `suricata-bot-status-enabled=false` |
| F | `npm test -- suricata.CloseSuricataTicket externalV1.suricata.close` | manual smoke only after flag ON + Phase B captured | flag `suricata-bot-close-enabled=false` |
| G | `npm test -- suricata.SendAutonomousSuricataReply externalV1.suricata.reply` | manual smoke only after flag ON + Phase B captured reply actuator | flag `suricata-bot-reply-enabled=false` |
| H | `npm test -- suricata-composition suricata-bot-action` (full suite) | `tsc --noEmit` + `npm test` full green | revert wiring lines, ports/registry stay inert |

---

## Phase A — Foundation: schema, shared domain layer, flags, import-hygiene isolation (repo: ipnext-backend)

- [x] A.1 Edit `prisma/schema.prisma`: add `SuricataBotActionAudit` model (design D1 — `actionType`
      String, `payload Json` NOT NULL, `actorLogin` String literal, `outcome` String default
      `"failed"`, `error String?`, `attemptedAt`/`completedAt`, back-relation + `onDelete: Cascade`
      on `SuricataTicket`, two indexes per D1).
- [x] A.2 Generate `prisma/migrations/<ts>_suricata_bot_actions/migration.sql` via `prisma migrate
      diff` (no local DB, per `WORKFLOW-MULTI-REPO.md`): `CREATE TABLE` for A.1 plus four
      `INSERT INTO "FeatureFlag" (...) VALUES ('suricata-bot-{reply,close,status,note}-enabled',
      false, NOW()) ON CONFLICT DO NOTHING;` — molde verbatim
      `20261117000000_seed_suricata_verdict_flag/migration.sql`. No `BEGIN`/`COMMIT`.
- [x] A.3 Create `src/domain/entities/suricataBotAction.ts`: discriminated union of the four action
      payloads (`{ actionType: 'reply'; body: string }` / `{ actionType: 'close'; reason: string }` /
      `{ actionType: 'status'; status: string }` / `{ actionType: 'note'; text: string }`) + the
      `SuricataBotActionRecord`/`RecordSuricataBotActionInput`/`MarkSuricataBotActionOutcomeInput`
      shapes, `outcome: 'applied' | 'failed'` (D1.b — NOT `'sent'`, one vocabulary across all four).
- [x] A.4 TDD A.3: an unknown/malformed `actionType` is rejected by the union's own mapper (never the
      DB) — `src/__tests__/domain/suricataBotAction.entity.test.ts`; each of the 4 known payload
      shapes round-trips.
- [x] A.5 Create `src/domain/constants/suricataStatus.ts` with a placeholder export
      (`SURICATA_CLOSED_STATUS: string`) whose **real literal value is unknown until Phase B**;
      commit it as an explicitly-typed `TODO(Phase B)`-commented placeholder that fails loudly
      (`throw` or a value guaranteed never to match anything real, e.g. `''`) rather than a guessed
      string — this is the one exception to "no placeholders" because it names a constant that ships
      empty on purpose, not a selector that could silently misfire.
- [x] A.6 Edit `src/domain/errors/suricata.ts`: add `SuricataActionNotAppliedError`
      (`SURICATA_ACTION_NOT_APPLIED`, 502 — driver completed its click-path but the post-condition
      marker never appeared) and `SuricataBotActionFailedError(code, message, auditId)` (wraps any of
      the above so the response can carry `auditId`, reuses the wrapped error's `.code` — molde
      `SuricataReplySendFailedError`, NOT reused directly per design D3.c). Do not add more than
      these two.
- [x] A.7 Edit `src/infrastructure/http/middleware/errorHandler.ts`'s `statusMap`: add
      `SURICATA_ACTION_NOT_APPLIED: 502`.
- [x] A.8 Create `src/domain/ports/SuricataTicketClosePort.ts` (`close(externalId, reason):
      Promise<void>`), `SuricataTicketStatusPort.ts` (`changeStatus(externalId, status):
      Promise<void>`), `SuricataInternalNotePort.ts` (`addNote(externalId, note): Promise<void>`) —
      three separate ports, not one combined port (design D3.a).
- [x] A.9 Create `src/domain/ports/SuricataBotActionAuditRepository.ts`: `record(input):
      Promise<SuricataBotActionRecord>` / `markOutcome(id, input): Promise<void>` /
      `listByTicket(ticketId)` (EXTAUDIT-7 — queryable as one set, no per-type union).
- [x] A.10 Edit `src/domain/ports/SuricataTicketRepository.ts`: add `setStatus(id: string, status:
      string): Promise<void>` (design D5.a — no `close()` method; molde `setAssignee`, a plain local
      UPDATE, caller has already checked existence).
- [x] A.11 Implement `InMemorySuricataBotActionAuditRepository` + `PrismaSuricataBotActionAuditRepository`
      (field-for-field parity, `tsc`-verified, no local DB); implement `setStatus` on
      `InMemorySuricataTicketRepository` + `PrismaSuricataTicketRepository`.
- [x] A.12 TDD A.9/A.11 (EXTAUDIT-1..7): `record` always returns an `outcome:'failed'` row; a second
      `record` call for a different attempt never mutates the first (append-only, EXTAUDIT-6);
      `markOutcome` flips only `outcome`/`completedAt`/`error`, never `actionType`/`payload`/
      `actorLogin`/`attemptedAt`; `listByTicket` returns mixed action types in one call (EXTAUDIT-7)
      — `src/__tests__/infrastructure/suricata-bot-action-audit.test.ts` (both adapters, shared test
      suite function, molde the mirror's Prisma/InMemory parity pattern).
- [x] A.13 Create `src/infrastructure/adapters/suricata/suricataActionPortsRegistry.ts`: `import
      type`-only singleton holder for the 4 write ports (`SuricataReplyPort` /
      `SuricataTicketClosePort` / `SuricataTicketStatusPort` / `SuricataInternalNotePort`), each with
      its own `set*`/`get*` pair, zero runtime dependencies — molde verbatim
      `src/infrastructure/scheduling/suricataSyncSchedulerRegistry.ts`. All four getters return
      `null` until Phases D–G populate them.
- [x] A.14 Create `src/infrastructure/adapters/suricata/bootstrapSuricataActionPorts.ts`: the ONLY
      new file that imports `config` + `getSharedSuricataSession` — returns `null` for every port
      when `SURICATA_BASE_URL`/`SURICATA_BROWSER_WS` are unset (molde `bootstrapSuricataSync.ts`).
      Constructs nothing real yet (driver classes don't exist until Phases D–G); this task's scope is
      the isolation shell only.
- [x] A.15 TDD import-hygiene invariant (design D7, this project's own real incident today —
      **must be explicit, not implicit**): `composeSuricataExternalModule.ts`'s source text has ZERO
      runtime imports of `config`, `sharedSuricataSession`, or any `bootstrap*` module — extend
      `src/__tests__/infrastructure/suricata-composition.test.ts` with this static source assertion,
      molde its existing mount-order assertions.
- [x] A.16 REFACTOR pass: `tsc --noEmit` clean; `npm test` full suite green (Phase A only touches
      additive/new files plus the two shared-file edits in A.7/A.15).

## Phase B — ⛔ BLOCKING live verification pass (repo: ipnext-backend, requires a human)

> **Precondition, not skippable**: a human with valid Suricata credentials must be present to type
> the password into the Playwright MCP browser window. Claude fills the email field only, per this
> project's established rule. No automated `sdd-apply` run may fabricate, guess, or carry over a
> selector from this checklist without this session actually happening.

- [x] B.1 Live authenticated Playwright MCP session against `https://ipnext.suricata.cloud`
      (molde: the exact method already used 2026-09-13 for `selectors.ts`'s login/list/detail
      capture). Session was already authenticated from earlier the same day ("Recordarme" cookie),
      no new password entry needed for this pass.
- [x] B.2 **Answer: no per-ticket control exists.** `/ticketunico` exposes only Notas/Tareas/
      Historial tabs + the info sidebar — close/status are reachable ONLY via the list's
      bulk-selection modal. Every close/status driver must select exactly one row.
- [x] B.3 Bulk path captured. Row checkbox: plain `<input type="checkbox">` per `<tr>` inside
      `#tabladinamica` (reuse the read-side scraper's row/`data-ticket-id` addressing from
      `selectors.ts`, do not re-derive). Triggers: `button:has-text("Cerrar seleccionados")` /
      `button:has-text("Cambiar Estado")`, both open the SAME `#modalConfirmar` (differentiated by
      `#mensajeAccion`'s text). Close-only fields inside `#bloqueCierre`:
      `#motivoCierreSelect` (`value=""→"-- Sin motivo --"`, `value="1"→"SinMotivo"`) +
      `#descripcionCierre` (free text, maxlength 255, optional). Confirm:
      `button[onclick="confirmarAccion()"]`. Cancel: `button[data-bs-dismiss="modal"]`.
- [x] B.4 "Cambiar Estado" captured: `#valorSelect` (`<select size="8">`) + `#filtroValor` filter
      input, `#bloqueCierre` hidden for this action. **Captured allowlist** (`value→label`): `1=Open,
      2=Progreso, 5=Esperando Respuesta, 6=Nuevo, 7=Llamada Programada, 8=Oferta Rechazada,
      9=Oferta Aceptada, 10=Firma Contrato, 11=Ganado, 12=Perdido`. **⚠️ There is NO closed-status
      value in this catalog** — design D5.a's "close is a status transition" assumption is WRONG;
      close and status-change are two independent Suricata actions. `suricataStatus.ts` (A.5) has
      been rewritten accordingly (see the note at the top of this file and design.md's corrected
      D5.a) — it now exports `SURICATA_STATUS_VALUES`/`isSuricataStatusValue`, no closed literal.
- [x] B.5 Internal-notes panel captured on `/ticketunico?tick={id}`: textarea
      `#internalNoteComentario` (`name="comentario"`, `required`, sibling hidden inputs
      `#internalNoteLogeado`/`#internalNoteTicketId` auto-populated — read-only context, driver
      never fills them), submit button `#btnCreateNote` (class `btn btn-primary rounded-pill me-1`,
      **no inline `onclick`** — handler bound externally in the bundle). The rendered-note
      post-condition marker was NOT pinned down in this pass (the button's bound handler and where
      the new note appears afterward needs one more live check) — Phase D's D.1 must do this
      micro-verification itself before considering the driver done; it is a small residual, not a
      phase-blocking gap.
- [x] B.6 Auto-sync captured: a "Detener"/"Iniciar" toggle sits next to the sync-status badge on
      `/ticketsdinamicosv2` (same button `atencion-suricata-ipnext` already documents). Clicking
      "Detener" freezes the table so a selected checkbox survives; every close/status driver must
      Detener → select → act → Iniciar. Interval confirmed at 60s, matches the documented gotcha.
- [x] B.7 **Extended-scope finding — corrects design.md's D3/D3.b, this is the big one.** The
      customer conversation genuinely renders inside the cross-origin, websocket-driven
      `conversation.suricata.chat` iframe and is NOT reliably reachable via `fill`/`type` (confirmed
      unloadable in 20s+ in two earlier live attempts the same day) — but that iframe is irrelevant,
      because a materially better, backend-reachable actuator exists and was verified END TO END:
      `POST https://api.botpress.cloud/v1/chat/messages` (the SAME Botpress Chat API + PAT
      `botpressMessages.ts` already uses to READ history, sourced the same way — an unauthenticated
      `POST backend.suricata.chat/metadata-merchant {merchant}` leaks `token_pa`/`bot_id`; see the
      security caveat already on record for that file). Body:
      `{conversationId, userId: 'user_01JY3XV69J36PGGZ01T47QK324' (the fixed agent/system sender id
      observed on every existing outgoing message), type: 'text', tags: {} (required even when
      empty), payload: {text}}`. Response is `201` with `tags['whatsapp:id']` populated by Botpress
      itself. **Verified live**: sent to the operator's own test ticket #18923, received on the
      operator's real WhatsApp, confirmed by the operator. This means Phase G needs **NO Playwright
      driver, NO `SuricataSession`, NO `high`-priority queue slot at all** — it is a plain HTTP call,
      structurally simpler than D/E/F, not harder. `PlaywrightSuricataReply.ts`/`SuricataReplySession`
      stay exactly as unimplemented as they are today; do not fill them in. See design.md's corrected
      D3.b for the full writeup.
- [x] B.8 Selectors written into `src/infrastructure/adapters/suricata/actionSelectors.ts` — **still
      needs to be created as an actual file by Phase D/E/F's first implementation task**; the values
      above are the authoritative source, this checkbox tracks that the CAPTURE happened, not that
      the file exists yet (avoids one agent creating a half-empty file another then has to merge
      into). `suricataStatus.ts` (A.5) already rewritten with the real catalog, no placeholder left.
- [x] B.9 No automated test for this phase (nothing to assert against live third-party HTML) — the
      deliverable is this checklist's captured values (to be materialized into `actionSelectors.ts`
      by D.1/E.1/F.1) plus B.7's answer, which already reshaped Phase G below.

## Phase C — External read parity: list/detail/kpis (repo: ipnext-backend)

> Independent of Phase B (no driver, no selector — reuses already-mirrored data only, design D8).
> Sequenced here because it has zero dependencies and de-risks the shared file edits in
> `composeSuricataExternalModule.ts`/`app.ts` before the four write phases pile onto the same files.

- [x] C.1 Verify (already done in design D8, re-confirm at apply time) that `ListSuricataTickets`,
      `GetSuricataTicketDetail`, `ComputeSuricataKpis` constructors depend on domain ports only — zero
      changes to those three files (EXTREAD-2/3/4).
- [x] C.2 Edit `composeSuricataExternalModule.ts`: add `GET /tickets`, `GET /tickets/:externalId`,
      `GET /kpis`, reusing the three use cases above; detail route resolves `ticketRepo.findByExternalId`
      → `execute(ticket.id)` → 404 on a miss (D8 — same two-step the D7.c attachment proxy already
      performs at lines 101-109). None of the three routes checks any of the 4 write flags (EXTREAD-5).
      Extend `ComposeSuricataExternalModuleDeps` with the 3 read use cases + message/attachment/area/
      verdict repos already constructed in `app.ts`'s external block (reuse the SAME Prisma instances
      `app.ts` already builds for the internal panel — no new repo instances).
- [x] C.3 TDD EXTREAD-1..5: missing/wrong key ⇒ 401 before any read logic (×3 routes); list/detail/
      kpis parity — same filters/pagination/result shape and same computed KPI values as the internal
      routes, called against the SAME seeded InMemory/Prisma state; unknown externalId ⇒ 404 on
      detail; all 3 succeed while all 4 write flags are `false` — new
      `src/__tests__/infrastructure/externalV1.suricata.read.routes.test.ts`.
- [x] C.4 Edit `app.ts`'s existing external Suricata mount block (~4084-4101): add the 3 new use-case
      constructions + deps to the `composeSuricataExternalModule({...})` call. No new mount, no new
      middleware — same key, same `machineActorMiddleware`.
- [x] C.5 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase D — Note capability (lowest risk, first in rollout order) (repo: ipnext-backend)

> BLOCKED on Phase B (B.5 selectors) per the non-negotiable sequencing constraint.

- [x] D.1 Implement `PlaywrightSuricataInternalNote` (implements `SuricataInternalNotePort`, D3.b
      molde: narrow `SuricataAuthSession`-extending session interface, `sessionTimeoutMs` config,
      single `this.session.withSession({ priority: 'high', timeoutMs }, ...)` call) using
      `actionSelectors.ts`'s B.5 capture. Handle B.6's auto-sync behavior per NOTE-7. Implement a
      test double (`FakeSuricataInternalNote` or an in-memory spy) alongside it.
- [x] D.2 TDD `AddSuricataInternalNote` use case (design D4/D5): audit row written BEFORE the port
      call with `outcome:'failed'`; success ⇒ `markOutcome('applied')` outside the send try; port
      throws ⇒ row stays `'failed'` with `.error`, wrapped in `SuricataBotActionFailedError` carrying
      `auditId`; unknown `externalId` ⇒ `SuricataTicketNotFoundError` 404 BEFORE any audit row exists
      (NOTE-3); empty/missing text ⇒ rejected before any side effect (NOTE-2); a note action never
      touches status/priority/area/assignment/conversation (NOTE-5, asserted via spy — no other repo
      method called) — `src/__tests__/application/suricata.AddSuricataInternalNote.test.ts`.
- [x] D.3 TDD external note route (NOTE-1..7 route-level): flag `suricata-bot-note-enabled` OFF ⇒ 403
      `FEATURE_DISABLED` before any driver call; missing/wrong key ⇒ 401; empty text ⇒ 400; unknown
      ticket ⇒ 404; success ⇒ 2xx with `auditId` — new
      `src/__tests__/infrastructure/externalV1.suricata.note.routes.test.ts`, molde
      `externalV1.suricata.routes.test.ts`'s flag/key/validation test shape.
- [x] D.4 Edit `composeSuricataExternalModule.ts`: add `POST /tickets/:externalId/notes` (own flag
      check inline, `parseOr400` for the body, `AddSuricataInternalNote` from deps). Edit
      `bootstrapSuricataActionPorts.ts` to construct the real `PlaywrightSuricataInternalNote` when
      envs are set, registered via `suricataActionPortsRegistry.ts`. Edit `app.ts`'s external block to
      wire the use case + its port + `suricataInternalFeatureFlagRepo`-style flag repo (reuse the
      existing `PrismaFeatureFlagRepository` instance already constructed for the verdict flag).
- [x] D.5 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase E — Status capability (repo: ipnext-backend)

> BLOCKED on Phase B (B.4 selectors + allowed-status catalog + closed-status literal).

- [x] E.1 Implement `PlaywrightSuricataStatus` (implements `SuricataTicketStatusPort`, same D3.b
      molde) using `actionSelectors.ts`'s B.4 capture; implements B.6's auto-sync handling per
      STATUS-7. Test double alongside it.
- [x] E.2 Create a status-value allowlist validator against B.4's captured catalog (Threat Matrix:
      selector injection — a caller-supplied status string MUST be matched against the captured
      allowlist and rejected 400 BEFORE reaching the driver; it is never concatenated into a
      selector/locator string).
- [x] E.3 TDD E.2: a status string containing selector syntax (e.g. `"] ; DROP"`-shaped or any
      value outside the captured allowlist) ⇒ 400, driver never invoked (spy assertion) — colocated
      with D5's use-case test or its own `src/__tests__/domain/suricataStatusAllowlist.test.ts`.
- [x] E.4 TDD `ChangeSuricataTicketStatus` use case (design D4/D5): audit row before port call;
      ordering spy — audit → port → `ticketRepo.setStatus`, a port failure ⇒ `setStatus` NEVER called
      (STATUS-5); success ⇒ mirror `status` updated only AFTER the real Suricata call succeeds;
      Suricata failure ⇒ mirror unchanged, non-success response; invalid/empty status ⇒ 400 before
      any side effect (STATUS-2, ties into E.3); unknown `externalId` ⇒ 404 before any audit row
      (STATUS-3) — `src/__tests__/application/suricata.ChangeSuricataTicketStatus.test.ts`.
- [x] E.5 TDD external status route: flag `suricata-bot-status-enabled` OFF ⇒ 403 before driver call;
      independent of note/close/reply flags' state (STATUS-1); missing/wrong key ⇒ 401; invalid
      status ⇒ 400; unknown ticket ⇒ 404; success ⇒ 2xx with `auditId` and updated mirror status —
      new `src/__tests__/infrastructure/externalV1.suricata.status.routes.test.ts`.
- [x] E.6 Edit `composeSuricataExternalModule.ts` (`POST /tickets/:externalId/status`),
      `bootstrapSuricataActionPorts.ts`, `suricataActionPortsRegistry.ts` usage, and `app.ts`'s
      external block — same pattern as D.4.
- [x] E.7 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase F — Close capability (repo: ipnext-backend)

> BLOCKED on Phase B (B.2/B.3 — DONE, see above). **Corrected 2026-09-13**: close is its OWN
> Suricata action, NOT a status transition — B.4's live capture found no closed value in the
> "Cambiar Estado" catalog. This phase does NOT depend on Phase E's `setStatus` at all; it uses its
> own bulk-modal path (`#motivoCierreSelect`/`#descripcionCierre`, B.3) and does not touch
> `SuricataTicket.status`.

- [x] F.1 Implement `PlaywrightSuricataClose` (implements `SuricataTicketClosePort`, same D3.b molde)
      using B.3's captured bulk-modal control (Detener → select the one row via `data-ticket-id` →
      click "Cerrar seleccionados" → fill `#motivoCierreSelect`/`#descripcionCierre` → click
      `button[onclick="confirmarAccion()"]` → Iniciar). Test double alongside it.
- [x] F.2 TDD `CloseSuricataTicket` use case (design D4/D5, corrected D5.a): audit row before port
      call with the close reason as payload; ordering spy — audit → `port.close(reason)`, a port
      failure leaves the audit row `'failed'`; **no local `ticketRepo` write on success** — there is
      no closed-status value to set locally (design D5.a's correction), the mirror's own `status`/
      close-adjacent fields catch up on the next 15-min sync tick per the existing "mirror write is a
      latency optimization" philosophy; missing/empty reason ⇒ 400 before any side effect (CLOSE-2);
      unknown `externalId` ⇒ 404 before any audit row (CLOSE-3) —
      `src/__tests__/application/suricata.CloseSuricataTicket.test.ts`.
- [x] F.3 TDD external close route: flag `suricata-bot-close-enabled` OFF ⇒ 403 before driver call,
      independent of the other 3 flags (CLOSE-1); missing/wrong key ⇒ 401; missing reason ⇒ 400;
      unknown ticket ⇒ 404; success ⇒ 2xx with `auditId` (no mirror `status` assertion — close does
      not write one, see F.2) — new
      `src/__tests__/infrastructure/externalV1.suricata.close.routes.test.ts`.
- [x] F.4 Edit `composeSuricataExternalModule.ts` (`POST /tickets/:externalId/close`),
      `bootstrapSuricataActionPorts.ts`, `suricataActionPortsRegistry.ts`, `app.ts`'s external block —
      same pattern as D.4/E.6.
- [x] F.5 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase G — Reply capability (external, zero-checkpoint, last/highest risk) (repo: ipnext-backend)

> **UNBLOCKED and REDESIGNED 2026-09-13 per B.7's live-verified finding.** Reply is NOT a Playwright
> driver. `PlaywrightSuricataReply.ts`/`SuricataReplySession` stay exactly as unimplemented as they
> are today — do NOT fill them in, do NOT give reply a `SuricataSession`/`high`-priority slot. The
> real actuator is a plain HTTP POST to the Botpress Chat API using the same PAT/lookup
> `botpressMessages.ts` already uses to read. This makes reply structurally SIMPLER than D/E/F, not
> harder: no browser, no selectors, no auto-sync interaction. The Threat Matrix concern still applies
> but to a different vector — never interpolate the reply body into a URL/query string; it goes
> exclusively into the JSON POST body, which is injection-safe by construction (verify this with a
> test, don't just assert it in a comment).

- [ ] G.1 Create `BotpressReplyPort` (`src/domain/ports/`) — `sendReply(conversationId, body):
      Promise<void>` (or `Promise<{whatsappId: string}>` if surfacing the returned `wamid` is useful
      for the audit payload — recommend yes, it is real proof of dispatch, molde
      `SuricataReplyAudit`'s existing "capture real evidence, not just an attempt flag" philosophy).
      Prod adapter `BotpressReplyAdapter` — a plain `fetch`/axios client, NO `SuricataAuthSession`,
      NO `SuricataSession.withSession` call, NO Playwright import. Factor the shared
      `{tokenPa, botId}` merchant lookup (currently duplicated conceptually with
      `fetchLastBotpressMessages` in `botpressMessages.ts`) into one function both modules import —
      do not copy-paste the `metadata-merchant`/`metadata-ticket` fetch logic a second time. Request
      shape verified live: `POST https://api.botpress.cloud/v1/chat/messages` with headers
      `Authorization: Bearer {tokenPa}` + `x-bot-id: {botId}`, body `{conversationId, userId:
      'user_01JY3XV69J36PGGZ01T47QK324', type: 'text', tags: {}, payload: {text: body}}`. A non-201
      response or a missing `message.id` in the body is a failure (`SuricataActionNotAppliedError`).
- [ ] G.2 TDD G.1: the reply body reaches the JSON request body verbatim (no mutation, no
      interpolation into any URL/header) — assert against a mocked `fetch`/axios call, molde the
      existing SSRF-adjacent tests' "assert the exact call args" style (`PlaywrightBrowserSession.test.ts`).
      A non-201/malformed response throws `SuricataActionNotAppliedError`, never resolves silently.
- [ ] G.3 Create `SendAutonomousSuricataReply` use case (design D4.a — a NEW class, distinct from
      `ReplyToSuricataTicket`: no `confirm`, no `actorId`, addressed by `externalId`). It must itself
      resolve `externalId → conversationId` via the SAME `metadata-ticket` lookup `botpressMessages.ts`
      makes (reuse, do not duplicate) before calling `BotpressReplyPort`. Audit row before the port
      call; success ⇒ `markOutcome('applied')` outside the try, payload includes the returned
      `whatsappId` if G.1 surfaces it; port throws ⇒ row stays `'failed'` wrapped in
      `SuricataBotActionFailedError` with `auditId`; empty/missing `body` ⇒ 400 before any side effect
      (EXTREPLY-3); unknown `externalId` ⇒ 404 before any audit row; a ticket with no
      `conversation_id` (metadata-ticket returns none) ⇒ a distinct 502/`SuricataActionNotAppliedError`,
      not a generic crash.
- [ ] G.4 TDD G.3 — `src/__tests__/application/suricata.SendAutonomousSuricataReply.test.ts`, same
      shape as D.2/E.4/F.2's use-case tests, molde `ReplyToSuricataTicket.test.ts` for the
      audit-ordering assertions specifically (EXTREPLY-5). Use an in-memory/fake `BotpressReplyPort`,
      never a real network call in tests.
- [ ] G.5 TDD external reply route: flag `suricata-bot-reply-enabled` OFF ⇒ 403, independent of the
      other 3 flags (EXTREPLY-2); missing/wrong key ⇒ 401 (EXTREPLY-1); no `confirm` field is ever
      read/required/validated (EXTREPLY-3); unknown ticket ⇒ 404; success ⇒ 2xx with `auditId` — new
      `src/__tests__/infrastructure/externalV1.suricata.reply.routes.test.ts`. Include one test
      proving this external route is structurally independent of the internal `suricata-reply-enabled`
      flag and `suricata.reply` RBAC permission (EXTREPLY-2's independence + the non-goal that the
      internal route is untouched — the internal route's `UnavailableSuricataReplyPort` in `app.ts`'s
      INTERNAL block is not touched by this phase at all, there is nothing to wire there since this
      path never uses that port).
- [ ] G.6 Edit `composeSuricataExternalModule.ts` (`POST /tickets/:externalId/reply`, wired to
      `SendAutonomousSuricataReply` + the real `BotpressReplyAdapter`), `app.ts`'s EXTERNAL block only
      — same pattern as D.4/E.6/F.4, but note `BotpressReplyAdapter` needs NO entry in
      `suricataActionPortsRegistry.ts`/`bootstrapSuricataActionPorts.ts` (those exist specifically to
      avoid dragging `config.ts` into route composition for the PLAYWRIGHT-backed singletons — a
      plain HTTP adapter has no such hazard and can be constructed directly in `app.ts` like any other
      stateless adapter, molde how simple `axios`-based clients are already wired elsewhere in this
      file). Add one composition test asserting the EXTERNAL module gets `BotpressReplyAdapter`/
      `SendAutonomousSuricataReply` while the INTERNAL module's `UnavailableSuricataReplyPort` wiring
      is byte-for-byte unchanged (molde the mirror's own precedent test of this shape).
- [ ] G.7 REFACTOR pass; `npm test` + `tsc --noEmit` green.

## Phase H — Final composition hardening, full-suite verification, rollout doc (repo: ipnext-backend)

- [ ] H.1 Composition-root test: assert full `app.ts` external-block wiring matches
      `composeSuricataExternalModule`'s final `ComposeSuricataExternalModuleDeps` signature (7 write
      deps + 3 read deps) — extend `suricata-composition.test.ts`, pin per this repo's known "wiring
      is verified by hand" lesson (molde mirror Phase F.4).
- [ ] H.2 Re-run A.15's import-hygiene assertion against the FINAL file (not just the Phase A stub) —
      confirm it still holds after D/E/F/G's edits added real driver construction to
      `bootstrapSuricataActionPorts.ts`, never to `composeSuricataExternalModule.ts`.
- [ ] H.3 Full `npm test` + `tsc --noEmit` green across the whole change (not just per-phase).
- [ ] H.4 Update `env.example` if any new env vars were introduced by Phase B's capture (unlikely —
      `config.suricata.*` already exists per the mirror change's B.3); otherwise confirm no new vars
      are needed.
- [ ] H.5 Document the D11 rollout order in a short operator note (or PR description): flip
      `suricata-bot-note-enabled` → verify on one real ticket + its audit row (`outcome:'applied'`,
      payload exact) → `suricata-bot-status-enabled` → same verification → `suricata-bot-close-enabled`
      → same verification → `suricata-bot-reply-enabled` last, same verification. Rollback: flip the
      four flags `false` (inert, no deploy); reply/close/note actions already sent are irreversible —
      inherent to an autonomous design, which is why reply is flipped last (design D11/D12).

---

## Key Open Items Surfaced (require `sdd-verify` attention, not silently resolved here)

1. **Flag key naming** (spec vs design) — see the callout at the top of this file. Tasks use design's
   `suricata-bot-*-enabled` naming; spec's `suricata-external-*-enabled` examples should be reconciled
   post-verify.
2. **Reply's real driver does not exist yet**, contrary to design D3's table phrasing ("exists; now
   wired for the EXTERNAL path only") — see the discovery note at the top of this file and Phase
   B.7/Phase G's dependency on it. This is the single biggest risk in this change: it is possible the
   conversation iframe has NO backend-reachable send actuator at all, in which case `EXTREPLY-4`
   cannot be implemented as specified and must return to the proposal/design stage.
3. **Per-ticket vs bulk-modal** for close/status (design's own Open Question) is resolved by Phase
   B.2, which changes Phase E/F's driver internals but never the Phase A.8 port contracts.
