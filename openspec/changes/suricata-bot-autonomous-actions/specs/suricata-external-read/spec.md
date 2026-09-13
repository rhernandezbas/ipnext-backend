# suricata-external-read Specification

## Purpose

External, token-authenticated read parity for the internal, session+RBAC-gated `GET /tickets`, `GET /tickets/:id`, and `GET /kpis` routes in `composeSuricataModule.ts`. Gives the bot the same read model it needs to act autonomously, without a Suricata cookie or a human session.

**Non-goal**: the read-side sync pipeline (`SyncSuricataTickets`, `PlaywrightSuricataScraper`) is untouched; this capability only exposes already-mirrored data through a new auth boundary. It performs zero live Suricata calls, exactly like its internal counterparts.

## Requirements

### Requirement: EXTREAD-1 — token authentication, no session/RBAC

All three routes MUST be reachable only through the existing external API key mechanism, the same as `suricata-external-reply`/verdict. They MUST NOT require a session cookie or check any RBAC permission.

#### Scenario: missing or wrong external key

- GIVEN a request to any of the three routes with no key or an incorrect key
- WHEN it reaches the route
- THEN it responds 401 without executing any read logic

### Requirement: EXTREAD-2 — list tickets at parity with the internal route

`GET .../tickets` MUST accept the same filter/pagination shape as the internal `GET /tickets` and MUST return the same result shape, sourced from the mirror only.

#### Scenario: list returns the same shape as the internal route

- GIVEN the same filters and pagination applied to both the internal and external list routes (with matching auth for each)
- WHEN both are called
- THEN both return the same set of tickets in the same result shape

### Requirement: EXTREAD-3 — ticket detail at parity with the internal route

`GET .../tickets/:id` MUST return the same detail shape as the internal `GET /tickets/:id`, sourced from the mirror only, and MUST respond 404 for an id not present in the mirror.

#### Scenario: detail parity for an existing ticket

- GIVEN a ticket present in the mirror
- WHEN its detail is fetched via the external route
- THEN the response matches the internal route's detail shape for the same ticket

#### Scenario: unknown ticket id

- GIVEN a ticket id absent from the mirror
- WHEN its detail is requested externally
- THEN it responds 404

### Requirement: EXTREAD-4 — KPIs at parity with the internal route

`GET .../kpis` MUST return the same computed KPI shape as the internal `GET /kpis`, using the same computation (including the most-recent-verdict-per-ticket rule from `suricata-bot-verdict`).

#### Scenario: KPI parity

- GIVEN the same mirror state
- WHEN KPIs are fetched via both the internal and external routes (with matching auth for each)
- THEN both return identical KPI values

### Requirement: EXTREAD-5 — independently unaffected by write flags

These read routes MUST NOT be gated by `suricata-external-reply-enabled`, `suricata-external-close-enabled`, `suricata-external-status-enabled`, or `suricata-external-note-enabled` — read access does not depend on any write action being enabled.

#### Scenario: reads work while all write flags are false

- GIVEN all four write flags are `false`
- WHEN a validly authenticated external read request arrives
- THEN it succeeds normally, unaffected by the write flags' state
