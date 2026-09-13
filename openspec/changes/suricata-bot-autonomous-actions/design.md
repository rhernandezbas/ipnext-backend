# Design — suricata-bot-autonomous-actions (external write API for the bot)

> Base: `proposal.md` (APPROVED). This design does NOT re-litigate it — it decides INSIDE it.
> Style/heading molde: `openspec/changes/suricata-tickets-mirror/design.md` (D1..Dn, citable).
> The proposal's three open decisions were **CONFIRMED by the user on 2026-09-13** and enter here
> as fixed constraints, not as options: **unified audit table** (D1), **four independent flags**
> (D2), **`high` session priority for all four actions** (D3).
>
> **Non-goals, stated once:** the internal session-gated reply route keeps its three guards
> (flag / `suricata.reply` RBAC / `UnavailableSuricataReplyPort`) untouched; the
> `atencion-suricata-ipnext` skill and its "permiso ok" gate are untouched; the read-side sync
> pipeline (`SyncSuricataTickets.ts`, `PlaywrightSuricataScraper.ts`, `botpressMessages.ts`) is
> untouched. None of these appears again below.

---

## D0 — Flow map

```
POST /api/external/v1/suricata/tickets/:externalId/{reply|close|status|notes}
  app.ts mount (UNCHANGED, app.ts:4088)
    ├─ createApiKeyMiddleware(config.suricata.externalApiKey)      401 fail-closed
    └─ machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN)
  composeSuricataExternalModule (deps-injected, D7)
    ├─ per-route flag check (fail-safe OFF)                        403 FEATURE_DISABLED
    ├─ parseOr400(zod safeParse)                                   400 VALIDATION_ERROR
    └─ use case (D4)
         1. ticketRepo.findByExternalId  → 404 if the mirror has no row
         2. auditRepo.record({ actionType, payload, outcome:'failed' })   ← BEFORE the port
         3. port.<action>()  → PlaywrightSuricata* → session.withSession({priority:'high'})
         4. auditRepo.markOutcome('applied')            (outside the send try)
         5. ticketRepo.setStatus(...) for close/status  (best-effort mirror, AFTER the remote leg)

GET /api/external/v1/suricata/tickets · /tickets/:externalId · /kpis
  SAME mount/guards → ListSuricataTickets / GetSuricataTicketDetail / ComputeSuricataKpis
  REUSED AS-IS (D8) — zero changes to those use cases.
```

---

## D1 — Unified audit: ONE table, `actionType` discriminator + `payload Json`

```prisma
model SuricataBotActionAudit {
  id          String   @id @default(uuid())
  ticketId    String
  ticket      SuricataTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  actionType  String                      // 'reply' | 'close' | 'status' | 'note'
  payload     Json                        // NOT NULL — the EXACT content that was attempted
  actorLogin  String                      // API_SURICATA_USER_LOGIN, written as a LITERAL
  outcome     String   @default("failed") // 'applied' | 'failed' — provisional until step 4
  error       String?
  attemptedAt DateTime @default(now())
  completedAt DateTime?
  @@index([ticketId, attemptedAt])
  @@index([actionType, attemptedAt])
}
```

**D1.a — `payload Json`, not four sets of nullable columns.** Chosen against this repo's own
precedent, not against a generic preference: `SuricataSyncRun.selectorMisses` is already `Json?`
for exactly this shape of "structured, type-specific, never queried by column". Four nullable
column sets would force every one of them nullable, so the DB would enforce **nothing** about
"a reply row must carry a body", and a fifth action later means an `ALTER TABLE` on an audit table
that must never be reshaped. With `payload` the DB enforces the one invariant that matters —
**content is always present** (`NOT NULL`) — and the type safety lives where this codebase already
puts it: a discriminated union in `src/domain/entities/suricataBotAction.ts`, mapped by the repo.
Rejected alternative "four tables mirroring `SuricataReplyAudit`": "show me everything the bot did"
becomes a four-way UNION, which is the query this table exists to serve.

**D1.b — `actionType`/`outcome` are `String` + a TS union, not a Prisma enum.** Exact in-repo
precedent: `SuricataReplyAudit.outcome` is a `String` column typed as `SuricataReplyOutcome` in
`domain/entities/suricata.ts:183`. Same shape here, zero new convention.
`outcome` vocabulary is `'applied' | 'failed'`, not `'sent' | 'failed'`: `sent` is reply-specific
and would read as a lie on a close or a status change. One vocabulary across four action types.

**D1.c — `actorLogin` is a literal, not `req.user`.** Molde: `SubmitSuricataVerdict.submittedBy`
is the `API_SURICATA_USER_LOGIN` constant (see the comment at `app.ts:4081`), and
`machineActorMiddleware` is defense-in-depth, not the source of the value. A bot action is
therefore **never indistinguishable from a human action** — `SuricataReplyAudit.actorId` holds an
`RbacUser` id, this table holds a machine login, and they are different tables.

**D1.d — audit written BEFORE the port call, flipped after (mandatory, molde D10).** Identical
reasoning to `ReplyToSuricataTicket`: if the row were written after, a crash mid-send would leave a
message/close in a third-party system **with no local trace**. The flip to `'applied'` happens
**outside** the send's `try` — a bookkeeping failure past an irreversible remote write must never
be reported as a failed action, because a "retry" would deliver it twice.

---

## D2 — Four flags, dark, seeded by an ADDITIVE migration

| Key | Gates |
|---|---|
| `suricata-bot-reply-enabled` | `POST .../reply` |
| `suricata-bot-close-enabled` | `POST .../close` |
| `suricata-bot-status-enabled` | `POST .../status` |
| `suricata-bot-note-enabled` | `POST .../notes` |

**The `-bot-` infix is load-bearing**: `suricata-reply-enabled` already exists and governs the
INTERNAL human route. Reusing it would make one flip move both surfaces — precisely the coupling
the non-goals forbid.

ONE migration, `prisma/migrations/<ts>_suricata_bot_actions/migration.sql`: `CREATE TABLE` for D1
plus four `INSERT INTO "FeatureFlag" ("key","enabled","updatedAt") VALUES (..., false, NOW())
ON CONFLICT DO NOTHING;`. **No `BEGIN`/`COMMIT`** (Prisma wraps each migration itself). Molde
verbatim: `20261117000000_seed_suricata_verdict_flag/migration.sql`. Seeding only in `seed.ts` is
forbidden here and the reason is mechanical, not stylistic: `SetFeatureFlag` does an `update`, never
an `upsert` — with no row, the flag card 404s forever and the switch can never be turned on.

---

## D3 — Ports and drivers: file-per-driver, port-per-capability

| Port (`src/domain/ports/`) | Signature | Prod adapter | Test adapter |
|---|---|---|---|
| `SuricataReplyPort` | `sendReply(externalId, body)` | **`BotpressReplyPort`** (NEW — plain HTTP, no browser; see D3.d) | `FakeSuricataReply` |
| `SuricataTicketClosePort` | `close(externalId, reason): Promise<void>` | `PlaywrightSuricataClose` | in-memory spy |
| `SuricataTicketStatusPort` | `changeStatus(externalId, status): Promise<void>` | `PlaywrightSuricataStatus` | in-memory spy |
| `SuricataInternalNotePort` | `addNote(externalId, note): Promise<void>` | `PlaywrightSuricataNote` | in-memory spy |
| `SuricataBotActionAuditRepository` | `record(input)` · `markOutcome(id, input)` | `PrismaSuricataBotActionAuditRepository` | `InMemory…` |
| `SuricataTicketRepository` | **+ `setStatus(id, status)`** (D5) | existing Prisma impl | existing InMemory impl |

**D3.a — three ports, not one `SuricataTicketActionPort` with three methods.** Straight application
of D3.b of the mirror design ("scraper and reply are two ports, not one"): a single port makes it
impossible to inject the *note* capability without also handing over the *close* capability. With
per-action flags AND per-action ports, a surface can be inert in two independent ways.

**D3.b — CORRECTED 2026-09-13 (live verification, D6 Step 1 partially executed early).** The three
close/status/note drivers are the `PlaywrightSuricataReply` molde, line for line: a narrow structural
session interface extending `SuricataAuthSession`, a `sessionTimeoutMs` config, and a single
`this.session.withSession({ priority: 'high', timeoutMs }, ...)` call — the exact API shape at
`PlaywrightSuricataReply.ts:46`. `high` for these three is confirmed: neither may starve behind a
15-minute `low` sync tick. The use cases never see `SuricataSession`, priority or locks (D3.c of the
mirror design: serialization is an adapter detail).

**Reply is NOT a fourth `PlaywrightSuricata*` driver and does NOT touch `SuricataSession` at all.**
`PlaywrightSuricataReply.ts` was confirmed (tasks-phase research, corroborated live) to be a
structural interface with no real send implementation — the mirror change's Phase J never wired a
real actuator, because the customer conversation renders inside a cross-origin, websocket-driven
iframe (`conversation.suricata.chat`) that a Playwright `fill`/`type` cannot reliably reach (it never
finished loading message history in two live attempts earlier the same day). Live verification found
a materially better actuator: Suricata's own backend leaks (via an unauthenticated
`POST backend.suricata.chat/metadata-merchant {merchant}`) a real Botpress Personal Access Token +
`bot_id` for this tenant's bot — the SAME credential `botpressMessages.ts` already uses to *read*
message history. `POST https://api.botpress.cloud/v1/chat/messages` with that PAT, `{conversationId,
userId: 'user_01JY3XV69J36PGGZ01T47QK324' (the fixed agent/system sender id observed on every
existing outgoing message in this tenant's conversations), type: 'text', tags: {} (required by the
API even when empty), payload: {text}}` returns 201 with a `tags['whatsapp:id']` populated by
Botpress itself — proof the integration actually dispatched it, not just logged it. **Verified
end-to-end 2026-09-13**: sent to the operator's own test ticket (#18923), received on the operator's
real WhatsApp, confirmed by the operator live. `conversationId` comes from the same
`metadata-ticket` call `botpressMessages.ts` already makes.

Consequence for D3's port table: `BotpressReplyPort` (NEW name, was `SuricataReplyPort`'s adapter) is
a plain `fetch`/axios HTTP client — no `SuricataSession`, no `high` priority, no browser, no page
object. It reuses `botpressMessages.ts`'s merchant/ticket-metadata lookup (factor the shared
`{tokenPa, botId, conversationId}` resolution into one function both modules call, do not duplicate
it). This makes reply structurally SIMPLER and more reliable than the other three actions, not
harder — the opposite of what D3 originally assumed. The security caveat already on record for
`botpressMessages.ts` applies identically here: this PAT is exposed by what is almost certainly a
Suricata-side authorization bug (no real auth beyond knowing the merchant slug), not an intentionally
issued integration credential — using it remains the operator's explicit, informed decision (see the
2026-09-13 security-finding memory), not something to silently normalize as "just another API key."

**D3.c — errors the drivers may throw.** Reuse the existing catalog wherever it fits; add exactly
**two** new classes in `src/domain/errors/suricata.ts`:

| Error | Source | New? | HTTP |
|---|---|---|---|
| `SuricataSessionBusyError` | `withSession` timeout | REUSE | 503 + `Retry-After` |
| `SuricataAuthError` | `ensureAuthenticated` failed twice | REUSE | 502 `SURICATA_UNAVAILABLE` |
| `SuricataTicketNotFoundError` | mirror has no row for `:externalId` | REUSE | 404 |
| `SuricataActionNotAppliedError` | **NEW** — the driver completed its click-path but the post-condition marker never appeared | NEW (`SURICATA_ACTION_NOT_APPLIED`) | 502 |
| `SuricataBotActionFailedError(code, message, auditId)` | **NEW** — wraps any of the above so the response can carry `auditId` | NEW (reuses the wrapped `.code`) | inherited |

`SuricataActionNotAppliedError` earns its existence: "I clicked and nothing in the DOM confirms it
happened" is neither a busy resource nor an auth failure, and it is the single most likely symptom
of a stale selector — it must be a distinct, greppable fact in `SuricataBotActionAudit.error`.
`SuricataBotActionFailedError` is the generalized twin of `SuricataReplySendFailedError`; the
reply-specific class is NOT reused because its name would lie on a close or a note. The flag gate
needs **no** error class: the external module already answers 403 inline
(`composeSuricataExternalModule.ts:70-73`) — same pattern, no new type.

---

## D4 — Use cases: four new, zero checkpoint

| Use case (`src/application/use-cases/suricata/`) | Input | Deps |
|---|---|---|
| `SendAutonomousSuricataReply` | `{ ticketExternalId, body }` | `SuricataTicketRepository`, `SuricataBotActionAuditRepository`, `SuricataReplyPort` |
| `CloseSuricataTicket` | `{ ticketExternalId, reason }` | + `SuricataTicketClosePort` |
| `ChangeSuricataTicketStatus` | `{ ticketExternalId, status }` | + `SuricataTicketStatusPort` |
| `AddSuricataInternalNote` | `{ ticketExternalId, note }` | + `SuricataInternalNotePort` |

All four return `{ auditId, applied: true, auditPersisted: boolean }`, the exact result contract
`ReplyToSuricataTicket` already established (`auditPersisted:false` = the action happened, only the
bookkeeping is behind — reconciliation is a read, **never** a resend).

**D4.a — `SendAutonomousSuricataReply` is a NEW class, not a flag on `ReplyToSuricataTicket`.** No
`confirm`, no `actorId`, addressed by `externalId` instead of the local id: four contract
differences. `confirm` exists to make a *human* re-confirm the exact bytes; with no human in the
loop it is ceremony a bot would compute from the same variable it is about to send, proving
nothing. Threading a `skipConfirm` boolean through the production human path would put the one
guard that protects real customers behind a parameter — the non-goals forbid touching that path at
all.

**D4.b — external surface addresses tickets by `externalId`**, matching the verdict route and the
attachment proxy. Ticket resolution is `findByExternalId`, and a miss is a 404 before any audit row
exists.

---

## D5 — Ordering: REMOTE first, mirror after, audit always

```
audit.record(attempt)  ──durable, before anything──►  [ Suricata write (irreversible) ]
                                                            │
                              audit.markOutcome  ◄──────────┘   (outside the send try)
                                                            │
                              ticketRepo.setStatus  ◄───────┘   (best-effort, close/status only)
```

**Choice: Suricata first, Prominense mirror second, both wrapped by a durable audit row.**
Rejected alternatives: (a) *local first* — writes a mirror claiming `cerrado` for a ticket Suricata
never closed, and the next sync tick silently reverts it, so the lie is invisible in both
directions; (b) *one atomic transaction across both* — impossible, the remote leg is a browser
click with no rollback. This is the same philosophy `SyncSuricataTickets` already applies: **the
local/audit record is written durably even when the remote leg fails, so failures are visible and
never silently lost.** The mirror write is explicitly a latency optimization, not a source of
truth — the sync pipeline reconciles ticket status within one tick regardless.

**D5.a — CORRECTED 2026-09-13 (live verification).** The original assumption below ("close is a
status transition plus a reason") is **wrong** and is kept struck through for the record, not
silently deleted:

> ~~new port method: `setStatus(id, status: string)` only. No `close()`. Close *is* a status
> transition plus a reason.~~

Live capture of both bulk-action modals shows **"Cerrar seleccionados" and "Cambiar Estado" are two
entirely independent actions on Suricata's side**, not one action parameterized differently. The
`#valorSelect` status catalog (`Cambiar Estado`) is a fixed list — `Open`, `Progreso`, `Esperando
Respuesta`, `Nuevo`, `Llamada Programada`, `Oferta Rechazada`, `Oferta Aceptada`, `Firma Contrato`,
`Ganado`, `Perdido` — **with no "Cerrado"/closed value in it at all**. Closing instead opens a
*different* modal body (`#motivoCierreSelect` + free-text `#descripcionCierre`) and almost certainly
flips a separate field observed in `metadata-ticket`'s own response shape (`t_cerrado`, currently
`null` on open tickets) rather than writing anything into the status the `Cambiar Estado` dropdown
edits. `src/domain/constants/suricataStatus.ts`'s placeholder `SURICATA_CLOSED_STATUS: string` (task
A.5) is now known to be the WRONG shape — there is no such literal to capture. **Two port methods,
not one:**

- `setStatus(id, status: string)` — used by `ChangeSuricataTicketStatus` only, writing one of the 10
  captured status values (D6 below) into `SuricataTicket.status` exactly as before, no change to this
  half of the original reasoning.
- `close(id, reason: string | null)` (NEW — reinstated, contrary to the original "no `close()`"
  decision) — used by `CloseSuricataTicket` only. Whether this needs its own mirror-side column
  (mirroring `t_cerrado`) or can stay a pure pass-through with no local field write is a D6 capture
  follow-up (does the sync pipeline's own `SuricataTicketSummary`/`SuricataTicketDetail` already
  expose a closed/not-closed signal from `siennaestado`/`t_cerrado`? if yes, the mirror already
  reflects it on the next tick and this method may be a no-op locally beyond the audit row — molde
  the D5 ordering diagram's "mirror write is a latency optimization" reasoning, which still holds).
  The reason string is NOT a ticket column either way — it lives in
  `SuricataBotActionAudit.payload`, unchanged from the original decision.

---

## D6 — ⛔ BLOCKING PREREQUISITE — selectors must be captured live BEFORE any driver is written

The driver **contracts** (D3) are fully designed now and can be implemented, tested against fakes
and merged with no site access. The **selector constants** cannot. This is a two-step reality and
the order is not negotiable:

1. **Step 1 (blocking).** A live, authenticated Playwright MCP session against the real Suricata
   instance captures every selector and post-condition marker below into
   `src/infrastructure/adapters/suricata/actionSelectors.ts` (new file — keeps the verified read
   selectors in `selectors.ts` untouched).
2. **Step 2.** Only then is a `PlaywrightSuricata{Close,Status,Note}` implementation considered
   writable, let alone done.

**No placeholder selector strings may be committed, not even as TODOs.** The header of
`selectors.ts` documents what happens otherwise, in this exact codebase: every hand-authored
selector was wrong, the login-form marker matched nothing, so `isAuthenticated()` always reported
"authenticated", login was never attempted, and the routes 500'd — a failure that looked like
working code for weeks. A never-verified selector for a *write* action is strictly worse: it
silently clicks the wrong row of somebody else's ticket queue.

Capture checklist (each item needs BOTH the actuator and the post-condition marker) —
**captured live 2026-09-13, recorded here verbatim, `actionSelectors.ts` still needs to be created
from this as the actual implementation task**:

- [x] Per-ticket close/status control on `/ticketunico` — **confirmed it does NOT exist**; only the
      bulk-selection modal is reachable (`/ticketunico` exposes Notas/Tareas/Historial tabs and the
      info sidebar, no close/status action). The bulk path is not a fallback, it is the only path —
      every close/status driver must select exactly one row's checkbox first.
- [x] Bulk path — row checkbox: `<td><input type="checkbox"></td>` per row inside `#tabladinamica`
      (same table the read-side scraper already parses; reuse its row/`data-ticket-id` addressing
      from `selectors.ts` rather than re-deriving it). Trigger buttons: `button:has-text("Cerrar
      seleccionados")` and `button:has-text("Cambiar Estado")` open the SAME shared modal,
      `#modalConfirmar` (`role="dialog"`, becomes `display:block` + class `show`), confirmed by
      `#mensajeAccion`'s text differing per action ("¿Seguro que deseas cerrar N tickets?" vs
      "Seleccione nuevo valor para (estados)"). Close-only fields: `#motivoCierreSelect` (`<select>`,
      captured options `value="" → "-- Sin motivo --"`, `value="1" → "SinMotivo"`) and
      `#descripcionCierre` (`<input type="text" maxlength="255">`, optional free text) inside a
      `#bloqueCierre` wrapper div (visible only for the close action, `display:none` for status).
      Confirm button: `button[onclick="confirmarAccion()"]` (text "Confirmar"); cancel:
      `button[data-bs-dismiss="modal"]` (text "Cancelar") — same two buttons for both actions.
- [x] "Cambiar Estado" control: same `#modalConfirmar`, status-only fields `#valorSelect` (`<select
      size="8">`, `#bloqueCierre` hidden) and a `#filtroValor` type-to-filter input above it. **Exact
      captured allowlist (D10), value→label**: `1=Open, 2=Progreso, 5=Esperando Respuesta, 6=Nuevo,
      7=Llamada Programada, 8=Oferta Rechazada, 9=Oferta Aceptada, 10=Firma Contrato, 11=Ganado,
      12=Perdido`. **No closed-status literal exists in this list — see D5.a's correction, closing is
      a different action entirely, not a status value.**
- [x] Internal notes panel on `/ticketunico?tick={id}`: comment textarea
      `<textarea id="internalNoteComentario" name="comentario" required>` (sibling hidden inputs
      `#internalNoteLogeado`/`#internalNoteTicketId` auto-populated with the logged-in agent name and
      the ticket id — read-only context, not something the driver fills), submit button
      `#btnCreateNote` (class `btn btn-primary rounded-pill me-1`, **no inline `onclick`** — the
      handler is bound externally in a bundle, so the driver must `click()` it and detect success via
      a post-condition marker (the new note appearing in the notes list DOM), not by inspecting the
      button itself. Locating that exact post-condition marker (and confirming `#btnCreateNote`'s
      bound handler doesn't require some other panel to be opened first, e.g. a "Notas" tab click)
      remains a small residual verification for the note driver's own implementation task, not
      re-opened here.
- [x] Auto-sync behavior: confirmed a **"Detener"/"Iniciar" toggle button exists** next to the sync
      status badge on `/ticketsdinamicosv2` (same button the `atencion-suricata-ipnext` skill already
      documents using before a multi-row close) — clicking "Detener" freezes the table/keeps
      selection stable; every close/status driver must click it before selecting a row and click
      "Iniciar" after, to avoid the redraw silently clearing the checkbox mid-action. Default interval
      observed at 60s, matches the existing documented gotcha exactly.

---

## D7 — Route wiring, and how the drivers reach it WITHOUT dragging `config.ts`

Mount point is **unchanged and confirmed**: `app.ts:4088`, `app.use('/api/external/v1/suricata', …)`,
before the global external key (order is load-bearing, already asserted by
`suricata-composition.test.ts`). The diff is: 4 new `router.post` handlers + 3 new `router.get`
handlers inside `composeSuricataExternalModule.ts`, 7 new entries on
`ComposeSuricataExternalModuleDeps`, and the matching construction lines in the existing app.ts
block. The `router.use` catch-all stays last.

**The import hazard, and the mitigation.** This session already hit the real bug:
`composeSuricataExternalModule.ts` pulling a module that transitively imports
`infrastructure/config.ts` executes its fail-fast validator at import time and calls a real
`process.exit(1)` inside a Jest worker, killing route tests that never set those envs. The four
Playwright drivers are built from `getSharedSuricataSession()`, and `sharedSuricataSession.ts`
imports `config` directly (line 31). So:

- `src/infrastructure/adapters/suricata/bootstrapSuricataActionPorts.ts` (**new**) — the ONLY file
  that imports `config` + `sharedSuricataSession` + the four driver classes. Returns `null` for
  every port when `SURICATA_BASE_URL`/`SURICATA_BROWSER_WS` are unset (molde
  `getSharedSuricataSession`).
- `src/infrastructure/adapters/suricata/suricataActionPortsRegistry.ts` (**new**) — the tiny
  singleton holder, `import type` ONLY, `set…`/`get…`, zero runtime dependencies. Molde verbatim:
  `src/infrastructure/scheduling/suricataSyncSchedulerRegistry.ts`.
- `composeSuricataExternalModule.ts` keeps receiving every port through `deps` and imports neither
  of the two files above. The registry exists for `app.ts`/future non-app consumers, not for the
  compose module.
- **Invariant, enforced by a composition test**: `composeSuricataExternalModule.ts` has zero runtime
  imports of `config`, `sharedSuricataSession`, or any `bootstrap*` module (assert over the source
  text, molde `suricata-composition.test.ts`).

---

## D8 — External read routes: maximum reuse, verified

Verified by reading the constructors: `ListSuricataTickets` (ticket/verdict/area/rbacUser repos),
`GetSuricataTicketDetail` (+message/attachment repos) and `ComputeSuricataKpis` (ticket/verdict
repos) depend on **domain ports only**. Not one of them reads `req`, a session, an actor or a
permission. The claim in the brief holds: the use cases genuinely do not care how the caller
authenticated.

**Decision: reuse all three AS-IS. Zero changes to those files.** The external composition
constructs its own instances from the same Prisma repos and the only difference is the guard
middleware the mount already applies. One adaptation is required and it lives in the **route**, not
the use case: `GetSuricataTicketDetail.execute(ticketId)` takes the LOCAL id while the external
surface addresses tickets by `externalId` (D4.b). The route resolves
`ticketRepo.findByExternalId(externalId)` → `execute(ticket.id)` → 404 on a miss — the exact
two-step the attachment proxy already performs at `composeSuricataExternalModule.ts:101-109`.
Rejected: adding a `getByExternalId` overload to a use case that is in production and covered by
tests, to save a two-line route-level lookup that already has a precedent in the same file.

---

## D9 — File changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | `SuricataBotActionAudit` + back-relation on `SuricataTicket` |
| `prisma/migrations/<ts>_suricata_bot_actions/migration.sql` | Create | CreateTable + 4 flag INSERTs `ON CONFLICT DO NOTHING` (D2) |
| `src/domain/entities/suricataBotAction.ts` | Create | Discriminated union of the 4 payloads + record/input types |
| `src/domain/constants/suricataStatus.ts` | Create | Closed-status literal (value pending D6 capture) |
| `src/domain/errors/suricata.ts` | Modify | `SuricataActionNotAppliedError`, `SuricataBotActionFailedError` |
| `src/domain/ports/SuricataTicket{Close,Status}Port.ts`, `SuricataInternalNotePort.ts` | Create | D3 |
| `src/domain/ports/SuricataBotActionAuditRepository.ts` | Create | `record` / `markOutcome` |
| `src/domain/ports/SuricataTicketRepository.ts` | Modify | `+ setStatus(id, status)` (D5.a) |
| `src/application/use-cases/suricata/{SendAutonomousSuricataReply,CloseSuricataTicket,ChangeSuricataTicketStatus,AddSuricataInternalNote}.ts` | Create | D4 |
| `src/infrastructure/adapters/suricata/PlaywrightSuricata{Close,Status,Note}.ts` | Create | D3.b — blocked on D6 |
| `src/infrastructure/adapters/suricata/actionSelectors.ts` | Create | Captured live (D6), never hand-authored |
| `src/infrastructure/adapters/suricata/bootstrapSuricataActionPorts.ts` | Create | Only config-aware file (D7) |
| `src/infrastructure/adapters/suricata/suricataActionPortsRegistry.ts` | Create | `import type` only (D7) |
| `src/infrastructure/adapters/prisma/PrismaSuricataBotActionAuditRepository.ts` | Create | + `setStatus` on `PrismaSuricataTicketRepository` |
| `src/infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository.ts` | Create | + `setStatus` on the in-memory ticket repo |
| `src/infrastructure/http/composeSuricataExternalModule.ts` | Modify | 4 write routes + 3 read routes + deps (D7) |
| `src/infrastructure/http/app.ts` | Modify | Construction lines inside the EXISTING external block (~`4084-4101`) |

---

## D10 — Testing strategy (strict TDD: red → green → refactor)

| Layer | What | How |
|---|---|---|
| Unit | `SuricataBotActionAudit` payload union | each `actionType` round-trips its payload; an unknown type is rejected at the mapper, not the DB |
| Use case | all four | in-memory ports: port throws ⇒ row stays `'failed'` **with the error** and `SuricataBotActionFailedError` carries `auditId`; success ⇒ `'applied'` + `completedAt`; `markOutcome` throwing AFTER a successful remote write ⇒ `auditPersisted:false`, **never** a thrown failure |
| Use case | ordering (D5) | spy order asserts audit → port → `setStatus`; a port failure ⇒ `setStatus` NEVER called |
| Use case | unknown `externalId` | 404 raised **before** any audit row exists |
| Route | external write ×4 | flag OFF ⇒ 403 · garbage body ⇒ 400 (not 500) · flags are independent (note ON + close OFF ⇒ 403 on close only) |
| Route | external read ×3 | same payload shape as the internal routes, with no session cookie; detail by `externalId`; unknown id ⇒ 404 |
| Composition | import hygiene | `composeSuricataExternalModule.ts` source has no runtime import of `config`/`sharedSuricataSession`/`bootstrap*` (D7) |
| Composition | mount order | external suricata mount index < global `/api/external/v1` index (existing test, extended) |
| Adapter | Prisma ↔ InMemory parity | `setStatus` + audit repo, field-for-field |

Prisma is never mocked (repo rule); the live Suricata site is never touched by the suite — the only
contact is the D6 capture pass and the D11 smoke.

---

## Threat Matrix

| Boundary | Applicability | Response |
|---|---|---|
| Documentation-like paths | **N/A** — nothing is classified or executed by filename/extension |
| Git repository selection / commit / push / PR automation | **N/A** — no VCS automation in this change |
| Shell / subprocess | **N/A** — the backend composes no shell command; the browser is reached over the sidecar websocket |
| **Routing** | **Applicable** — four new authenticated write routes. Guarded by the dedicated key (mount), a per-route flag (fail-safe OFF), `parseOr400`, and a 404 on unknown `externalId`. RED tests in D10. |
| **Process integration (remote browser)** | **Applicable** — caller-supplied text reaches a third-party UI. Reply body, close reason and note text are written with `fill`/`type` **only**, NEVER `page.evaluate` with interpolation (molde `PlaywrightSuricataReply`'s Threat Matrix note), with a test asserting the literal text arrives unmodified. |
| **Selector injection (new)** | **Applicable** — the status value is caller-supplied and would otherwise be interpolated into a selector/locator string. It MUST be matched against the D6-captured allowlist and rejected with 400 before reaching the driver; a status value is never concatenated into a selector. RED test: a status string containing selector syntax ⇒ 400, driver never invoked. |

---

## D11 — Rollout / rollback

1. Merge the migration + domain/application layers + fakes, dark. Four flags `false`; the routes
   exist and answer 403.
2. Run the **D6 capture pass**; commit `actionSelectors.ts` with the captured values.
3. Implement the three drivers, wire the registry, redeploy — still dark.
4. Flip in increasing blast radius: **note → status → close → reply**. After each flip, one
   hand-picked real ticket, verified in the Suricata UI, with its `SuricataBotActionAudit` row read
   back (`outcome='applied'`, payload exact).

**Rollback**: flip the four flags `false` — inert with no deploy. Next level: revert the external
wiring of `PlaywrightSuricataReply` so the external path falls back to the unavailable port. The
table and flag rows are additive; nothing is lost. Replies, closes and notes already delivered are
irreversible — inherent to an autonomous design, which is why reply is flipped last.

---

## D12 — Risks and declared debt

| Risk | Status |
|---|---|
| Unverified selectors silently click the wrong thing | **HIGH — mitigated only by D6 being treated as blocking.** Post-condition markers + `SuricataActionNotAppliedError` make a stale selector loud instead of silent |
| Suricata's 60s auto-sync clears selection mid-flow | Prefer the per-ticket path (D6); bulk modal only if no per-ticket control exists |
| Bot sends a wrong reply to a real customer | Per-action dark flag + full audit + staged rollout with reply last. **No control undoes a sent message** |
| Mirror/Suricata divergence on partial failure | Remote-first ordering (D5) + durable audit + sync reconciles within one tick |
| Four `high`-priority lanes starve the `low` sync | Bounded `timeoutMs` per action ⇒ `SuricataSessionBusyError`/503; a skipped sync tick is idempotent and harmless. **Declared debt**: no fairness metric exists yet |
| `app.ts` God Object | Only construction lines inside the EXISTING external block; no new mount. Mitigated, not resolved (pre-existing debt) |
| Audit table growth / PII | Payload holds real customer-facing text; no retention policy (same declared debt as the attachments) |

## Open Questions

- [ ] **D6 capture is the single blocker**: the exact selectors, the allowed status values, and the
      closed-status literal are unknown until a live authenticated pass runs. Driver implementation
      MUST NOT start before it.
- [ ] Whether Suricata exposes a per-ticket close/status control at all, or only the list's bulk
      modal — decided by the same capture pass, and it changes only the driver internals, never the
      port contracts in D3.
