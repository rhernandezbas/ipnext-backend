# suricata-bot-verdict Specification

## Purpose

A structured bot verdict per mirrored ticket, submitted through a single token-authenticated external endpoint. The same contract serves today's manual caller and a future autonomous bot — this spec defines the contract only, not bot autonomy. Verdicts accumulate as a history (training dataset); the most recent one is the vigent verdict shown in the panel and KPIs.

## Requirements

### Requirement: VERDICT-1 — dedicated token authentication

The endpoint MUST require a dedicated API token (independent of session/RBAC), validated with a constant-time comparison, following the existing external-token precedent. Missing, incorrect, or unconfigured token MUST fail closed with 401.

#### Scenario: missing token

- GIVEN a request with no token header
- WHEN it calls the verdict endpoint
- THEN it responds 401 without executing any business logic

#### Scenario: token not configured server-side

- GIVEN the server has no verdict API token configured
- WHEN any request arrives, with any token value
- THEN it responds 401 (never opens the endpoint by default)

### Requirement: VERDICT-2 — payload shape and conditional requirements

The body MUST be `{resuelto: boolean, analisis: string, motivo?: string, respuestaSugerida?: string}`. `analisis` MUST be non-empty. When `resuelto=false`, both `motivo` and `respuestaSugerida` MUST be present and non-empty. When `resuelto=true`, both are optional. Any violation MUST respond 400 before persisting anything.

#### Scenario: unresolved without motivo

- GIVEN `{resuelto: false, analisis: "..."}` with no `motivo`
- WHEN submitted
- THEN it responds 400, no verdict is persisted

#### Scenario: unresolved without respuestaSugerida

- GIVEN `{resuelto: false, analisis: "...", motivo: "..."}` with no `respuestaSugerida`
- WHEN submitted
- THEN it responds 400, no verdict is persisted

#### Scenario: resolved verdict needs no motivo/respuestaSugerida

- GIVEN `{resuelto: true, analisis: "..."}`
- WHEN submitted
- THEN it is accepted and persisted

### Requirement: VERDICT-3 — ticket must exist in the mirror

The endpoint MUST reject a verdict for a ticket id not present in the mirror with 404, without persisting anything.

#### Scenario: unknown ticket id

- GIVEN a ticket id that does not exist in the mirror
- WHEN a verdict is submitted for it
- THEN it responds 404, no verdict row is created

### Requirement: VERDICT-4 — verdicts accumulate, never overwritten

Each accepted submission MUST be persisted as a new verdict row (actor/source, ticket, payload, timestamp) — never overwriting or deleting a prior verdict for the same ticket. The full history MUST remain queryable.

#### Scenario: second verdict on the same ticket

- GIVEN a ticket already has one stored verdict
- WHEN a second verdict is submitted for it
- THEN both verdicts exist in storage afterward — the first is not deleted or altered

### Requirement: VERDICT-5 — current verdict is the most recent

The list view and the KPI computations MUST use only the most recent verdict per ticket (by submission timestamp) as "current"; older verdicts are historical only.

#### Scenario: KPI reflects the latest verdict

- GIVEN a ticket with an older verdict `resuelto:false` and a newer verdict `resuelto:true`
- WHEN KPIs are computed
- THEN that ticket counts toward "resolved by bot", not "needed human"
