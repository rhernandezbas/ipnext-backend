# Tasks: WhatsApp Template CTA Button

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~260-300 (7 prod files + 5 test files) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Full CTA-button feature (types → validation → gateway → routes) | PR 1 | `npm test -- CreateTemplate TwilioContentGateway.admin templates.routes external-messaging-templates.routes` | N/A — pure unit/route tests against in-memory gateway, no live Twilio call required | revert commit removes `button` end-to-end; optional field, no migration |

## Phase 1: Foundation (types, no behavior change)

- [x] 1.1 `src/domain/ports/TemplateMessagingPort.ts` — add `export interface TemplateButton { title: string; url: string }` and `button?: TemplateButton` on `CreateTemplateInput`.
- [x] 1.2 `src/application/dto/messaging-templates.dto.ts` — add `button?: { title: string; url: string }` to the HTTP `CreateTemplateInput`.
- [x] 1.3 `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts` — add `button?: { title: string; url: string }` to `TemplateCreateCallRecord` and record it in `createCalls` inside `createTemplate()`.

## Phase 2: Use-case validation (CreateTemplate)

- [x] 2.1 RED — `src/__tests__/application/messaging/CreateTemplate.test.ts`: valid button reaches `createCalls[0].button`; 400 on whitespace-only title; 400 on title >25 chars; 400 on relative/`ftp://` url; 400 on missing `title`/`url` key; no-button case keeps `createCalls[0].button === undefined` (regression).
- [x] 2.2 GREEN — `src/application/use-cases/messaging/CreateTemplate.ts`: add module-private `assertValidButton()` (trim+length check, `new URL(raw)` validity check, throw `InvalidTemplateInputError`); call it only when `input.button` is defined; pass the RAW `input.button` (never `.href`) into `providerInput.button`.

## Phase 3: Gateway payload branch (TwilioContentGateway)

- [x] 3.1 RED — `src/__tests__/infrastructure/adapters/twilio/TwilioContentGateway.admin.test.ts`: no-button payload stays byte-identical `{'twilio/text':{body}}` (regression); with-button payload is `{'twilio/call-to-action':{body, actions:[{type:'URL', title, url}]}}`; a `{{1}}` placeholder inside `url` is sent unencoded.
- [x] 3.2 GREEN — `src/infrastructure/adapters/twilio/TwilioContentGateway.ts` (`createTemplate`, ~L194-210): branch `types` on `input.button` per design contract.

## Phase 4: Route wiring

- [x] 4.1 RED — `src/__tests__/infrastructure/templates.routes.test.ts`: POST with valid `button` → 201, fake's `createCalls[0].button` populated; POST with invalid `button` → 400, no create call reached.
- [x] 4.2 GREEN — `src/infrastructure/http/routes/templates.routes.ts` (~L62): forward `body.button` (type-guarded object with `title`/`url` strings) into `CreateTemplateInput`.
- [x] 4.3 RED — `src/__tests__/infrastructure/external-messaging-templates.routes.test.ts`: same 201/400 cases; prove the non-`.strict()` schema no longer silently strips `button`.
- [x] 4.4 GREEN — `src/infrastructure/http/routes/external-messaging.routes.ts` (~L125): extend `CreateTemplateBodySchema` with `button: z.object({ title: z.string(), url: z.string() }).optional()`.

## Phase 5: Verification

- [x] 5.1 Run `npm test -- CreateTemplate TwilioContentGateway.admin templates.routes external-messaging-templates.routes InMemoryTemplateAdminGateway` — all green, no regression on no-button paths.
- [x] 5.2 Spot-check existing `/validate` preview tests (VAL-3) still pass unchanged — button must never leak into `renderedMessage` (no code touch expected).
