/**
 * suricata-bot-autonomous-actions (Phase B live capture, task B.8; Phase D,
 * task D.1) — DOM selectors for the four autonomous write actions
 * (reply/close/status/note), captured live and authenticated against
 * `https://ipnext.suricata.cloud` on 2026-09-13 (design D6, tasks.md B.1-B.7).
 *
 * Kept in a DEDICATED file, separate from the verified READ selectors in
 * `selectors.ts` (D6 Step 1) — a write action clicking the wrong thing is
 * strictly worse than a read scraping the wrong thing, so the two never share
 * a module.
 *
 * ⚠️ Reply needs NO selector here at all (B.7's corrected finding, D3.b): it
 * is a plain Botpress Chat API HTTP call, not a Playwright driver. Close
 * (`#motivoCierreSelect`/`#descripcionCierre`/`#modalConfirmar`) and status
 * (`#valorSelect`/`#filtroValor`) selectors are captured in tasks.md
 * B.3/B.4/design.md D6 but are added to this file by Phases E/F's own
 * implementation tasks, not invented here ahead of time (B.8's own note:
 * "avoids one agent creating a half-empty file another then has to merge
 * into" — this Phase D pass adds ONLY the note selectors it needs).
 *
 * No placeholder strings: every value below was read off the live DOM, never
 * guessed (D6's non-negotiable rule, header comment of `selectors.ts`).
 */

/** `/ticketunico?tick={externalId}` — the ticket's OWN detail page (B.5). */
export const SURICATA_TICKET_DETAIL_PATH = '/ticketunico';

export const SURICATA_INTERNAL_NOTE_SELECTORS = {
  /**
   * `<textarea id="internalNoteComentario" name="comentario" required>` —
   * the ONLY field the driver ever fills. Its sibling hidden inputs
   * (`internalNoteLogeadoField`/`internalNoteTicketIdField` below) are
   * auto-populated by Suricata's own bundle from the logged-in session and
   * the page's ticket context — the driver reads them for the NOTE-7
   * post-navigation re-confirmation, it NEVER writes to them (B.5).
   */
  commentTextarea: '#internalNoteComentario',
  /** Auto-populated with the logged-in agent's name — read-only context, never filled by the driver. */
  loggedInHiddenField: '#internalNoteLogeado',
  /**
   * Auto-populated with the CURRENT page's ticket id — this is the NOTE-7
   * re-confirmation anchor: the driver reads it right before submitting and
   * fails closed (never clicks Crear) if it does not match the ticket the
   * caller asked for, rather than trusting the URL alone (B.6's auto-sync
   * caveat is about the LIST page; this is the analogous defense for the
   * detail page's own possible navigation drift).
   */
  ticketIdHiddenField: '#internalNoteTicketId',
  /**
   * `class="btn btn-primary rounded-pill me-1"`, NO inline `onclick` — its
   * handler is bound externally in a bundle (B.5). The driver clicks it and
   * detects success via `commentTextarea` going back to empty (the one
   * stable, cheap post-condition marker available without depending on the
   * exact shape of wherever the new note re-renders in the panel).
   */
  submitButton: '#btnCreateNote',
} as const;

/**
 * suricata-bot-autonomous-actions (Phase E extension, task E.1, design D6/
 * D3.b, tasks.md B.3/B.4/B.6) — the shared bulk-selection modal on
 * `/ticketsdinamicosv2` that both "Cambiar Estado" (status, THIS phase) and
 * "Cerrar seleccionados" (close, Phase F) open. Close-only fields
 * (`#motivoCierreSelect`/`#descripcionCierre`) are deliberately NOT added
 * here yet — Phase F's own implementation task adds them, same incremental-
 * capture discipline B.8 already established for this file (avoids one
 * agent creating a half-empty file another then has to merge into).
 */
export const SURICATA_BULK_ACTION_SELECTORS = {
  /**
   * Each `<tr>` inside `#tabladinamica` carries the ticket's externalId as a
   * `data-ticket-id` attribute (B.3 — reuses the read-side scraper's own
   * `#tabladinamica` addressing from `selectors.ts` rather than inventing a
   * second row-identification scheme). Returns the exact locator string for
   * ONE row's checkbox — interpolated only into a Playwright `page.locator()`
   * call, never into a `page.evaluate` body (Threat Matrix).
   */
  rowCheckbox: (externalId: string): string => `#tabladinamica tr[data-ticket-id="${externalId}"] input[type="checkbox"]`,
  /** Opens `#modalConfirmar` with `#bloqueCierre` hidden and `#valorSelect` visible (B.4). */
  changeStatusButton: 'button:has-text("Cambiar Estado")',
  /** Opens the SAME `#modalConfirmar` with `#bloqueCierre` visible instead (B.3) — Phase F's own trigger. */
  closeButton: 'button:has-text("Cerrar seleccionados")',
  /** Shared confirmation modal for BOTH actions, differentiated by `#mensajeAccion`'s text (B.3). */
  modal: '#modalConfirmar',
  /** `<select size="8">` — the captured status catalog lives in `suricataStatus.ts` (B.4), matched by visible LABEL text. */
  statusSelect: '#valorSelect',
  /** Optional type-to-filter input above `statusSelect` (B.4) — not required, selecting by value/label directly works too. */
  statusFilterInput: '#filtroValor',
  confirmButton: 'button[onclick="confirmarAccion()"]',
  cancelButton: 'button[data-bs-dismiss="modal"]',
  /**
   * B.6 — freezes/unfreezes the list's 60s auto-redraw so a mid-flow row
   * selection survives. Every close/status driver MUST click `autoSyncStopButton`
   * BEFORE selecting a row and `autoSyncStartButton` AFTER acting (STATUS-7).
   */
  autoSyncStopButton: 'button:has-text("Detener")',
  autoSyncStartButton: 'button:has-text("Iniciar")',
  /**
   * suricata-bot-autonomous-actions (Phase F, task F.1, design D6/D5.a,
   * tasks.md B.3) — close-only fields inside `#bloqueCierre`, visible only
   * when `closeButton` opened the modal (`changeStatusButton` hides this
   * block instead, B.4). `<select>` with captured options
   * `value=""→"-- Sin motivo --"`, `value="1"→"SinMotivo"` — the driver
   * leaves this at its default (no motivo classification), because the
   * external caller supplies a single free-text `reason`, which maps to
   * `closeDescriptionInput` below, not to this fixed two-value catalog.
   */
  closeReasonSelect: '#motivoCierreSelect',
  /**
   * `<input type="text" maxlength="255">`, free text, optional (B.3) — the
   * caller's `reason` string is filled here verbatim via `fill`, never via
   * `page.evaluate` with interpolation (Threat Matrix).
   */
  closeDescriptionInput: '#descripcionCierre',
} as const;
