# Rollout — Suricata bot autonomous actions (external write API)

Operator note for `suricata-bot-autonomous-actions` (task H.5, design D11/D12). All four
capabilities ship dark in the same PR (`delivery_strategy: single-pr`); nothing below requires a
deploy to flip — every flag is a plain `FeatureFlag` row already seeded `false` by this change's
migration.

## ⚠️ Read this before flipping anything

- These are **autonomous, unattended actions**. There is no human confirmation step on any of the
  four routes — no `confirm` field exists on the reply endpoint, unlike the internal human-facing
  reply route.
- **`suricata-bot-reply-enabled` sends REAL messages to REAL customers over WhatsApp, with zero
  review.** Once a message is sent there is no undo — Botpress dispatches it immediately and there
  is no delete/recall capability. Treat this flag with the same caution as a production billing
  action.
- `suricata-bot-close-enabled` and `suricata-bot-note-enabled` also produce irreversible
  side effects on the real Suricata instance (a closed ticket, a permanent internal note). Only
  `suricata-bot-status-enabled` changes a value that can be changed again.
- Every attempt (success or failure) is recorded in `SuricataBotActionAudit`, keyed by ticket, with
  the exact payload attempted, `outcome` (`'applied' | 'failed'`), and any error. There is no way to
  suppress this audit trail — use it to verify every flip below.

## Endpoints

All four routes are mounted under `/api/external/v1/suricata` (same mount as the existing verdict
route), addressed by the ticket's `externalId` (not the internal database id).

| Method | Path | Flag key | Use case |
|---|---|---|---|
| `POST` | `/tickets/:externalId/notes` | `suricata-bot-note-enabled` | `AddSuricataInternalNote` |
| `POST` | `/tickets/:externalId/status` | `suricata-bot-status-enabled` | `ChangeSuricataTicketStatus` |
| `POST` | `/tickets/:externalId/close` | `suricata-bot-close-enabled` | `CloseSuricataTicket` |
| `POST` | `/tickets/:externalId/reply` | `suricata-bot-reply-enabled` | `SendAutonomousSuricataReply` |

### Auth

Same guard as the existing external verdict/read routes — no RBAC session, no cookie:

- Header: `X-API-Key: <SURICATA_EXTERNAL_API_KEY>` (or `Authorization: Bearer <SURICATA_EXTERNAL_API_KEY>`).
- Missing/wrong key → `401`, before any flag check or driver call.
- Each route ALSO checks its own flag independently (fail-safe OFF → `403 FEATURE_DISABLED`) —
  flipping one of the four flags never affects the other three, and never affects the pre-existing
  `suricata-verdict-enabled` route or the INTERNAL human-facing `suricata-reply-enabled` route/RBAC
  permission (`suricata.reply`), which this change does not touch at all.

### `POST /tickets/:externalId/notes`

Request:

```json
{ "text": "Reactivamos el servicio del cliente a las 14:05." }
```

Response `201`:

```json
{ "auditId": "b3f1...", "applied": true, "auditPersisted": true }
```

Errors: `400` empty/missing `text` · `401` bad/missing key · `403 FEATURE_DISABLED` flag off ·
`404 SURICATA_TICKET_NOT_FOUND` unknown `externalId` · `502 SURICATA_ACTION_NOT_APPLIED` driver
completed its click-path but the post-condition marker never appeared.

### `POST /tickets/:externalId/status`

Request:

```json
{ "status": "Progreso" }
```

`status` MUST be one of the ten values captured live from Suricata's own "Cambiar Estado" catalog
(`Open`, `Progreso`, `Esperando Respuesta`, `Nuevo`, `Llamada Programada`, `Oferta Rechazada`,
`Oferta Aceptada`, `Firma Contrato`, `Ganado`, `Perdido`) — anything else is rejected `400` before
reaching the driver (Threat Matrix: selector injection guard, see design D10/D12). There is no
"closed" value in this catalog; closing is a separate action (see below).

Response `201`: same shape as notes, plus the mirror's `SuricataTicket.status` is updated locally
only AFTER the real Suricata call succeeds.

### `POST /tickets/:externalId/close`

Request:

```json
{ "reason": "Cliente confirmó resolución por WhatsApp." }
```

Response `201`: same `{auditId, applied, auditPersisted}` shape. **No local mirror field is written
on success** (design D5.a, corrected 2026-09-13) — Suricata's close action is independent of the
status catalog above, and the mirror's own fields catch up on the next 15-minute sync tick.

### `POST /tickets/:externalId/reply`

Request:

```json
{ "body": "Ya reactivamos tu servicio, cualquier novedad avisanos." }
```

Response `201`:

```json
{ "auditId": "b3f1...", "applied": true, "auditPersisted": true, "whatsappId": "wamid.HBg..." }
```

`whatsappId` is real proof of dispatch (Botpress's own `tags['whatsapp:id']`), present only when
Botpress populates it. No `confirm` field is ever read, required, or validated on this route —
that is intentional (design D4.a: there is no human in the loop to re-confirm against). A ticket
with no linked Botpress conversation returns `502 SURICATA_ACTION_NOT_APPLIED` — a distinct,
audited failure, not a generic crash.

## Rollout order (design D11) — lowest blast radius first

Flip exactly one flag at a time, verify, then move to the next:

1. **`suricata-bot-note-enabled` → `true`.** Pick one real, low-stakes ticket. Call the notes
   endpoint. Verify the note actually appears in Suricata's UI, and read back the
   `SuricataBotActionAudit` row for that ticket: `outcome: 'applied'`, `payload` matches exactly
   what was sent.
2. **`suricata-bot-status-enabled` → `true`.** Same per-ticket verification, checking the new
   status both in Suricata's UI and in the mirror.
3. **`suricata-bot-close-enabled` → `true`.** Same verification; expect no mirror `status` field
   to change (only the audit row and the real ticket's closed state in Suricata).
4. **`suricata-bot-reply-enabled` → `true`, LAST.** This is flipped last on purpose — it is the
   only one of the four that reaches a real customer directly and cannot be undone. Verify against
   a real WhatsApp number under the operator's own control before trusting it for customer traffic.

## Rollback

- **Immediate, no deploy**: flip the affected flag back to `false`. The route keeps answering
  `403 FEATURE_DISABLED` immediately; in-flight requests already accepted are not retried by this
  system, but nothing new is accepted.
- **Deeper rollback** (driver misbehaving even while flagged on for verification): revert the
  external wiring in `app.ts`'s EXTERNAL block so the corresponding port falls back to its
  `Unavailable*Port` guard (`UnavailableSuricataInternalNotePort` / `UnavailableSuricataTicketStatusPort`
  / `UnavailableSuricataTicketClosePort` / `UnavailableBotpressReplyPort`) — additive, no data is
  lost, the audit table and flag rows stay in place.
- **What cannot be rolled back**: any note, status change, close, or reply already delivered to
  Suricata/the customer before the flag was flipped off. This is inherent to an autonomous design
  (design D12) — it is the reason reply ships last and is verified most carefully.

## Open reconciliation items (flagged for `sdd-verify`, not silently resolved)

1. **Flag-key naming — spec vs. design.** The six spec files under
   `openspec/changes/suricata-bot-autonomous-actions/specs/` use illustrative example flag keys
   `suricata-external-{reply,close,status,note}-enabled`. `design.md` D2 deliberately chose
   `suricata-bot-{reply,close,status,note}-enabled` — the `-bot-` infix is called out there as
   load-bearing, to avoid one flip coupling this new autonomous route to the existing human-facing
   `suricata-reply-enabled` flag. The actually implemented, tested, and shipped keys are the
   `-bot-` ones documented in the table above. No spec requirement asserts the literal flag string
   is wire-visible (callers only ever observe `403 FEATURE_DISABLED`, never the key itself), so
   this is a naming inconsistency between an illustrative example and a considered decision, not a
   behavioral conflict — but the spec files should get a follow-up edit to match the implementation.
2. **`suricata-ticket-close/spec.md`'s CLOSE-5 wording is stale.** It was written under the
   original (incorrect) assumption that closing is a status transition and the mirror's ticket
   status gets updated on close. Live verification (design D5.a, corrected 2026-09-13) found close
   and status-change are two independent Suricata actions — closing does **not** write any local
   `SuricataTicket` field; the mirror's own sync tick picks up the closed state independently.
   `CloseSuricataTicket`'s implementation and its tests follow the corrected D5.a behavior (no
   mirror write); CLOSE-5's spec text describing a mirror status update is the part left stale and
   should be corrected in a follow-up spec edit.
