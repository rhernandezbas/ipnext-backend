# suricata-ticket-mirror Specification

## Purpose

Background sync that scrapes Suricata Cx (headless Playwright, no REST API available) and mirrors tickets, messages, attachments and the area catalog into Postgres via Prisma. The mirror is the sole source of truth read by the panel and the external API — no live on-demand fetch from Suricata ever happens outside this sync.

## Requirements

### Requirement: MIRROR-1 — first-run backfill

On first activation (no prior successful sync recorded), the system MUST import the full historical set of tickets, messages, attachments and areas, traversing all pages of Suricata's listing.

#### Scenario: initial activation

- GIVEN the sync has never completed successfully before
- WHEN the sync lane runs
- THEN it paginates through the entire Suricata ticket history and persists every ticket, its messages and attachments

### Requirement: MIRROR-2 — incremental runs after backfill

Once a backfill has completed, subsequent runs MUST only fetch tickets changed since the last successful sync (by `updatedAt` or an equivalent stored watermark), not the full history.

#### Scenario: run after backfill

- GIVEN a successful backfill completed at T0
- WHEN the sync runs again at T1 > T0
- THEN only tickets updated after T0 are fetched and persisted

### Requirement: MIRROR-3 — idempotent persistence

Persisting a ticket, message, attachment or area MUST be an upsert keyed by Suricata's stable identifier. Running the same sync twice, or re-fetching a ticket already mirrored, MUST NOT create duplicate rows.

#### Scenario: re-run produces no duplicates

- GIVEN a ticket already mirrored with 3 messages
- WHEN the sync fetches that same ticket again with the same 3 messages
- THEN the stored ticket and message count remain unchanged (no duplicate rows)

### Requirement: MIRROR-4 — per-ticket retry, batch resilience

A scraping error on one ticket (timeout, selector not found) MUST NOT abort the run. The system MUST retry that ticket with backoff and continue processing the rest of the batch.

#### Scenario: one ticket fails, others succeed

- GIVEN a batch of 20 tickets where ticket #7 times out
- WHEN the sync runs
- THEN tickets other than #7 are persisted, #7 is retried with backoff, and the run completes

### Requirement: MIRROR-5 — visible failure, no data corruption

A run that ends with unresolved errors (after retries) MUST record a visible/loggable error state for that run. It MUST NOT fail silently, and MUST NOT alter or remove data already persisted by prior successful runs.

#### Scenario: run exhausts retries

- GIVEN ticket #7 still fails after its retry budget
- WHEN the run finishes
- THEN the run's error state is recorded and observable
- AND previously persisted tickets/messages/attachments remain intact

### Requirement: MIRROR-6 — area catalog refresh without orphan loss

The area catalog MUST be refreshed each run. A ticket referencing an area no longer present in the catalog MUST keep its previously stored area reference; the sync MUST NOT drop or null it out.

#### Scenario: area removed upstream

- GIVEN a ticket stored with area "Facturación" and a later run where "Facturación" no longer exists in Suricata's catalog
- WHEN the sync runs
- THEN the ticket still shows "Facturación" as its area, and the sync does not error on that ticket

### Requirement: MIRROR-7 — attachments migrated to internal storage

Each attachment MUST be downloaded and stored by the system during sync, independent of any Suricata session/cookie, so it can later be served to consumers that have no Suricata credentials.

#### Scenario: attachment survives without Suricata session

- GIVEN a ticket with one attachment mirrored during sync
- WHEN a consumer with no Suricata cookie requests that attachment
- THEN the attachment is served from internal storage successfully

### Requirement: MIRROR-8 — read-only against Suricata

The sync MUST NOT write status, priority, area or assignment back to Suricata under any circumstance.

#### Scenario: sync never mutates Suricata

- GIVEN any completed sync run
- WHEN reviewing the actions taken against Suricata
- THEN no write/update request was issued — only reads
