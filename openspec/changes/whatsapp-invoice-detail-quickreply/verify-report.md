```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:b64fc3e2185f364bc9995e79f155329a1b95137bc074704e541a0a029e145ac2
verdict: fail
blockers: 3
critical_findings: 3
requirements: 5/6
scenarios: 12/13
test_command: npm test
test_exit_code: 0
test_output_hash: sha256:62cf83867b5a412dba0fa78db5763f6fb5775680e7708f59f77c61d953c05859
build_command: npx tsc --noEmit
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## Verification Report

**Change**: whatsapp-invoice-detail-quickreply
**Mode**: full spec-driven verification (proposal + design + specs + tasks present), Strict TDD active
**Revision**: f3134cc5 (range acab519d..f3134cc5)
**Verdict**: FAIL - 3 CRITICAL, 1 WARNING, 2 SUGGESTION

### Artifact completeness

| Artifact | Present | Notes |
|---|---|---|
| proposal.md | yes | - |
| explore.md | yes | - |
| design.md | yes | - |
| specs (2 deltas) | yes | 6 requirements, 13 scenarios |
| tasks.md | yes | 26/26 checked |
| apply-progress.md | yes | retrospective, added in f3134cc5 |

### Execution evidence

| Check | Command | Exit | Result |
|---|---|---|---|
| Test suite | npm test | 0 | 1290 suites passed / 6 skipped; 13675 tests passed, 0 failed, 88 skipped, 13763 total; 140.76 s |
| Type check | npx tsc --noEmit | 0 | clean, zero diagnostics |
| Orphan processes | Get-CimInstance Win32_Process | - | zero orphaned jest/node workers after the run |

### Spec compliance matrix

#### Delta whatsapp-invoice-detail-quickreply (QR-1 ... QR-4)

| Req | Scenario | Covering test (exact name) | Status |
|---|---|---|---|
| QR-1 | exact title match triggers the reply | invoiceDetailButton.test.ts: "match exacto -> dispara el trigger", "case-insensitive -> dispara el trigger", "con espacios de borde (trim) -> dispara el trigger"; ReplyWithInvoiceDetail.test.ts: "trigger + factura pendiente + cliente resuelto (no stale) -> UN sendMessage con el detalle"; messaging.routes.test.ts: "tap inbound del boton por la ruta REAL (firma HMAC valida) -> Chatwoot recibe el detalle" | PASS |
| QR-1 | unrelated content never false-triggers | invoiceDetailButton.test.ts: "substring (contiene el titulo pero no es igual) -> NO dispara", "contenido no relacionado -> NO dispara", "string vacio -> NO dispara"; ReplyWithInvoiceDetail.test.ts: "contenido no relacionado (no es el titulo del boton) -> NO envia nada"; ReceiveChatwootWebhook.invoiceDetail.test.ts: "sin colaborador inyectado (backward-compat) - cero regresion" | PASS |
| QR-2 | independent of the assistant flag | messaging.routes.test.ts: "tap inbound del boton por la ruta REAL (firma HMAC valida) -> Chatwoot recibe el detalle" (harness wires NO assistant engine at all - reply still sent); messaging-bulk-composition.test.ts constructor-order regex; plus the structural proof below | PASS (see SUGGESTION-1) |
| QR-3 | customer with pending invoices | renderInvoiceDetailReply.test.ts: "UNA factura con paymentUrl -> itemiza numero/vencimiento/saldo + Ver + Pagar ahora", "N facturas (>1) -> cada una itemizada, separadas por un divisor", "el vencimiento se muestra como DD/MM/YYYY, jamas el ISO crudo" | PASS |
| QR-3 | customer with zero pending invoices | renderInvoiceDetailReply.test.ts: "invoices === [] (cero pendientes) -> devuelve el mensaje neutro verbatim", "owner-locked: string de cero facturas pendientes, EXACTA", "la string de cero facturas NUNCA sugiere al dia (guardrail del diseno)" | PASS |
| QR-4 | GR lookup fails | ReplyWithInvoiceDetail.test.ts: "el reader de facturas lanza -> envia el fallback GR-lookup-failed EXACTO, no relanza (QR-4)"; ReceiveChatwootWebhook.invoiceDetail.test.ts: "el colaborador lanza (hipo) -> el webhook NO explota e IGUAL espeja el mensaje y ackea (fail-open)" | PASS |
| QR-4 | phone does not resolve to any Client | ReplyWithInvoiceDetail.test.ts: "telefono sin match en ningun Client -> NO envia nada, no lanza (QR-4)"; reinforced by "el MISMO telefono resuelve a 2 clientes -> NO cita datos de ninguno, manda el fallback" | PASS |

QR-4's requirement heading, which previously contradicted its own scenario body, now reads
"fail-open; owner-locked fallback reply on internal error, no reply on unresolved phone".
Both sub-cases are stated accurately: fallback sent on GR/internal error, genuine silence on a
zero-match phone. Previous blocker 3 is CLOSED.

#### Delta external-bulk-messaging (TPL-3, TPL-6)

| Req | Scenario | Covering test (exact name) | Status |
|---|---|---|---|
| TPL-3 | legacy sin type - sin regresion | CreateTemplate.test.ts: "legacy {title,url} sin type -> normaliza a type:url"; external-messaging-templates.routes.test.ts: "con button valido -> 201, templatePort.createCalls[0].button poblado (Zod no lo stripea)"; TwilioContentGateway.admin.test.ts: "con button -> payload types es twilio/call-to-action con actions[{type:URL,title,url}]" | PASS |
| TPL-3 | type:url explicito - equivalente a legacy | CreateTemplate.test.ts: "type:url explicito -> mismo efecto exacto que la forma legacy sin type" and "type:url explicito con url invalida -> InvalidTemplateInputError (misma regla que legacy)"; external-messaging-templates.routes.test.ts: "con button type:url explicito -> 201 y el boton llega identico al legacy sin type" | PASS |
| TPL-3 | quick-reply valido | TwilioContentGateway.admin.test.ts: "con button type:quickReply -> payload types es twilio/quick-reply con actions[{id,title}], sin url" - asserts a DIFFERENT payload than the scenario states | FAIL - CRITICAL-1 |
| TPL-3 | type desconocido o titulo vacio -> 400 | CreateTemplate.test.ts: "type desconocido -> InvalidTemplateInputError"; empty-title path via the whitespace-title button case (type-agnostic trim/empty guard) | PASS (see SUGGESTION-2) |
| TPL-3 | sin boton - sin regresion | CreateTemplate.test.ts: "sin boton -> createCalls[0].button es undefined (regresion, no se inventa nada)"; TwilioContentGateway.admin.test.ts twilio/text case | PASS |
| TPL-6 | recategorizacion de Meta sobre un quick-reply | TwilioContentGateway.admin.test.ts: "TPL-6: sometido UTILITY pero aprobado MARKETING -> el DTO reporta MARKETING, nunca UTILITY" | PASS |

### Previously-blocking items - independently re-verified

Blocker 1 - TPL-3 explicit type:url had no test. CLOSED. Both new tests genuinely construct an
EXPLICIT {type:'url', title, url} input (not the legacy untyped shape) and assert real behaviour:
the use-case test builds the explicit form and the legacy form through two separate gateways and
compares the whole recorded call with toEqual, and a sibling test proves url validation still
applies to the explicit form (ftp:// still rejected, zero create calls). The route test sends the
tag over the wire and asserts the normalized button reaching the port. Not decorative.

Blocker 2 - TPL-6 had no discriminating test. CLOSED, and the claim was verified rather than
trusted. I re-ran the revert-probe myself against TwilioContentGateway.toTemplateDto:

- Flipping BOTH category operands (the category: line and the approvalCategory assignment)
  -> 3 failed / 21 passed, including the new TPL-6 test.
- Flipping ONLY the ?? operand order on the category: line -> 1 failed / 23 passed, exactly the
  claimed discrimination, and the single failure is the new TPL-6 test.
- Reverted with git checkout --; git status --porcelain src/ empty; suite re-run 24/24 green.

The report's claim that the read-back mechanism already existed and was already correct is
accurate: the approvalOverride category precedence predates this change (S4 fix) and was untouched
by the diff. Only the test was missing.

Blocker 3 - QR-4 heading contradiction. CLOSED (see matrix note above).

### Owner constraints

Isolation (QR-2), verified fresh across the entire range acab519d..f3134cc5:

- Zero imports from assistant modules in any new file (invoice-detail/*, InvoiceDetailReader.ts,
  PrismaInvoiceDetailReader.ts, InMemoryInvoiceDetailReader.ts).
- Every "assistant" token added by the diff is either a prose comment asserting the isolation, or a
  reference to the PRE-EXISTING assistantEngine 8th constructor parameter of ReceiveChatwootWebhook
  and its composition-order regex. No new coupling.
- ai-assistant-enabled appears nowhere in the new code path. Repo-wide its only occurrences are in
  the parked ReplyWithAssistant.ts and assistant-composition.test.ts, both untouched by this change.

Owner-locked strings, character-exact in the final code
(src/application/use-cases/messaging/invoice-detail/renderInvoiceDetailReply.ts):

- GR_LOOKUP_FAILED_MESSAGE is byte-identical to the string quoted in the QR-4 spec scenario,
  ending in the "IPNEXT Cobranzas" sign-off.
- NO_PENDING_INVOICES_MESSAGE is the neutral zero-invoices string and makes no "al dia" claim,
  per the design guardrail; a dedicated test asserts that absence.

### Task completion

26/26 tasks checked across Phases 0-8. Task text matches the shipped code state in every case but
one (WARNING-1).

### Design coherence

| Design decision | Code state | Verdict |
|---|---|---|
| Title-text trigger matching (no button id on the wire) | isInvoiceDetailTrigger, trim + case-insensitive equality | coherent |
| actions with an inert slug id on the Twilio action | buildContentTypes emits exactly that | coherent, but contradicts the spec delta (CRITICAL-1) |
| Optional constructor collaborator, fail-open try/catch | 9th optional ctor arg + maybeReplyWithInvoiceDetail | coherent |
| Pure total formatter (null = lookup failed, [] = zero pending) | renderInvoiceDetailReply | coherent |
| Approach B full isolation | verified above | coherent |

### Issues

#### CRITICAL-1 - TPL-3 mandates a Twilio payload shape the code does not emit

specs/external-bulk-messaging/spec.md, normative sentence (lines 15-16) and scenario "quick-reply
valido" (lines 34-35), both state that type:'quickReply' MUST emit twilio/quick-reply with
actions carrying a type field set to QUICK_REPLY.

The shipped code (TwilioContentGateway.buildContentTypes) emits
actions: [{ id: slug(button.title), title: button.title }] - no type key at all. The type
discriminator belongs to twilio/call-to-action (type:'URL'), not to twilio/quick-reply.

The CODE is right: design.md explicitly chose "emit actions: [{ id: slug(title), title }], slug
computed inside the gateway", and that is the payload actually created and approved by Meta live.
The SPEC TEXT is wrong, and it is wrong in the normative sentence, not only in the scenario. This
scenario therefore has no passing covering test as literally written. Archiving this delta would
enshrine a false provider contract in the permanent external-bulk-messaging capability spec, for a
paid external integration.

Fix: spec text only. No code, test, or behaviour change.

#### CRITICAL-2 - TPL-3 mandates silently ignoring a stray url; the code rejects it

Same file, lines 12-13: "una url presente junto a quickReply MUST ignorarse sin error".

The fix wave (448ce327, adversarial finding 5) deliberately REVERSED this. assertValidButton now
throws InvalidTemplateInputError for {type:'quickReply', url}, and the external route returns 400.
The code comment states the reasoning explicitly: accepting it silently left the operator believing
they had created a button with a link. Two tests lock the behaviour in:
"type:quickReply con un url colado -> InvalidTemplateInputError (no se ignora)" and
"con button type:quickReply + url colada -> 400, NUNCA se crea como boton url".

The hardened behaviour is correct. The spec still mandates the behaviour the review found dangerous.

#### CRITICAL-3 - TPL-3 states a permissive quickReply title rule; the code enforces an exact constant

Same file, lines 11-12: "type:'quickReply' exige solo title no vacio tras trim, acotado en largo".

The code additionally requires title === INVOICE_DETAIL_BUTTON_TITLE exactly (post-trim,
case-sensitive), throwing otherwise. That is the deliberate anti-drift decision recorded in
design.md: an operator physically cannot create a quick-reply template whose title the webhook
would not recognize. Test: "type:quickReply con titulo distinto de la constante ->
InvalidTemplateInputError". The spec omits the single most important validation rule of this
requirement, and as written would permit creating a template the webhook can never answer.

#### WARNING-1 - task 1.6 text describes the reversed behaviour

tasks.md task 1.6 still reads "ignore stray url on quickReply" and is checked [x]. That is the
pre-fix-wave behaviour. Every other task carries an explicit reconciliation note where reality
diverged from the plan (see 2.1, 3.2, 6.2, 7.1); this one does not. Cosmetic next to the CRITICALs,
but tasks.md is archived too.

#### SUGGESTION-1 - QR-2's scenario is satisfied structurally, not by a flag toggle

No test literally sets ai-assistant-enabled to OFF and then taps the button. The guarantee is
stronger in practice: the flag is unreachable from this code path by construction, and the
integration harness wires no assistant at all, so a toggle test would be close to vacuous. Recorded
so archive does not later read the matrix as claiming a toggle test exists.

#### SUGGESTION-2 - TPL-3's empty-title scenario is covered by the type-agnostic guard

The scenario names {type:'quickReply', title:"   "}. The passing test uses the legacy shape with a
whitespace title. assertValidButton trims and rejects before branching on type, so the same code
path is exercised, but the literal quickReply variant has no case of its own.

### Accepted residual risk (unchanged)

LOW - a single invoice block over roughly 1400 characters could theoretically displace the
"more invoices" notice. Bounded in practice: real MercadoPago URLs are around 100 characters, and
MAX_REPLY_LENGTH = 1400 with MAX_INVOICES_IN_REPLY = 5 are enforced and tested by
"facturas con links larguisimos -> el mensaje sigue dentro del largo seguro".

### apply-progress.md honesty check

Cross-checked against git log acab519d..f3134cc5. It is an honest account. It declares itself
retrospective and explains why, names commits acaebaad and 448ce327 with accurate descriptions,
lists all 5 adversarial findings matching the 448ce327 commit body, records the accepted LOW
residual risk, and describes the third-pass fix wave including the correct claim that TPL-6 needed
no production code. Two minor omissions, neither a misrepresentation: the trailing Commits list
stops at 448ce327 (it does not enumerate 664fa267, though the body describes that work in detail),
and f3134cc5 - the commit that adds the file itself - is naturally absent. Nothing in it actively
misrepresents reality.

### Verdict

FAIL. Runtime evidence is fully green (13675 passed, 0 failed, exit 0; tsc --noEmit clean), all 26
tasks are complete, the three previously-blocking gaps are genuinely closed (the TPL-6 revert-probe
independently reproduced), and both owner constraints hold across the entire range. The remaining
blocker is narrower but real: the external-bulk-messaging spec delta states three normative rules
the shipped code contradicts. In each case the code is right and the spec text is stale. Because
that delta becomes the permanent capability contract for a paid external provider integration, it
must be corrected before archive. No code, test, or behaviour change is required.
