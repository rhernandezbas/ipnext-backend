import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { TvCatalogMissingError } from '@domain/errors/gigared';

/**
 * Prefix that marks a ContractService row as GIGARED-MANAGED (H2 ownership).
 * Reconcile only ever touches rows whose notes begin with this — a TV row created by hand
 * via the #42 UI (notes null or anything else) is left completely alone.
 */
const GIGARED_NOTES_PREFIX = 'CIC ';

/** A row is Gigared-managed only when its notes start with the reconcile-owned prefix. */
function isGigaredManaged(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && notes.startsWith(GIGARED_NOTES_PREFIX);
}

/** Extract the cic recorded in a managed row's notes ("CIC {cic} · …"). null when not present. */
function cicFromNotes(notes: string | null | undefined): string | null {
  if (!isGigaredManaged(notes)) return null;
  const rest = (notes as string).slice(GIGARED_NOTES_PREFIX.length);
  const cic = rest.split(' · ')[0]?.trim();
  return cic && cic !== '' ? cic : null;
}

/**
 * Reconcile the local TV ContractService slot with Gigared's current service list (D6).
 *
 * Deterministic, idempotent: read the Gigared account by internal_id; resolve the active
 * 'TV' catalog entry (guard TvCatalogMissingError → 422); then, ONLY for the Gigared-managed
 * row (notes prefixed "CIC ", H2 ownership):
 *   - services present  → upsert ONE ContractService on (contractId, TV) with
 *                         notes = "CIC {cic} · {names.join(' · ')}", status 'active'
 *   - services empty     → INACTIVATE the local row (H1: PATCH status='inactive'), never delete —
 *                          history is preserved and the slot can be re-activated by the next add.
 *
 * If the (contractId, TV) slot is occupied by a NON-managed row (manual #42 UI), reconcile does
 * NOT touch it and does NOT create a second row (the UNIQUE pair forbids it).
 *
 * #65 fix wave options:
 *   - `ensureRow` (H2/M8): when the account has NO services and no managed row exists yet, CREATE the
 *     managed row (status 'inactive') anyway, so the alta-fresca credentials have a home. Without this
 *     flag the empty-services + no-row case is a no-op (legacy behaviour, used by link/cancel).
 *   - `clearCredentialsOnInactive` (M6): when inactivating the managed row (services empty), also null
 *     out tvLogin/tvPassword — a baja must leave no zombie credentials. Used by CancelTv.
 *   - `excludeServiceIds` (#67 re-review, CRITICAL): service ids that the baja could NOT remove because
 *     the CUA marks them irremovable (the BASE pack "Gigared Play Full" → 424 "no se puede dar de baja").
 *     Those ids are STILL present in the re-read account (their DELETE threw), so without this exclusion
 *     reconcile would take the "services present" branch and leave the local TV row ACTIVE with the OLD
 *     cic notes + stale credentials — and the following renew+unlink would make it irreparable. By
 *     subtracting these ids from the account's service list BEFORE the empty/non-empty decision, an
 *     account left with ONLY the base behaves as "empty": the row is INACTIVATED + credentials cleared.
 *
 * #65 fix wave M6 (always on): when the managed row is reactivated/upserted for a cic DIFFERENT from
 * the one recorded in its notes, stale tvLogin/tvPassword from the previous account are CLEARED — a
 * re-link to a new CIC must never inherit the old account's credentials.
 */
export async function reconcileTvContractService(deps: {
  gigared: GigaredPort;
  csRepo: ContractServiceRepository;
  catalogRepo: ServiceCatalogRepository;
  customerId: string;
  contractId: string;
  ensureRow?: boolean;
  clearCredentialsOnInactive?: boolean;
  excludeServiceIds?: string[];
}): Promise<{ contractServiceId?: string }> {
  const { gigared, csRepo, catalogRepo, customerId, contractId, ensureRow, clearCredentialsOnInactive, excludeServiceIds } = deps;

  const tvCatalog = await catalogRepo.getByName('TV');
  if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();

  const account = await gigared.getAccountByInternalId(customerId);
  const existing = await csRepo.getByPair(contractId, tvCatalog.id);

  // H2: a row that exists but is NOT Gigared-managed is off-limits — leave it untouched.
  if (existing && !isGigaredManaged(existing.notes)) {
    return {};
  }

  // #67 re-review (CRITICAL): an irremovable BASE pack is still present in the re-read account
  // (its DELETE threw 424). Subtract the excluded ids BEFORE deciding empty/non-empty, so an
  // account left with ONLY the base counts as "empty" → the row is inactivated, not reactivated.
  const exclude = new Set(excludeServiceIds ?? []);
  const services = exclude.size > 0
    ? account.services.filter((s) => !exclude.has(s.id))
    : account.services;

  if (services.length === 0) {
    if (existing) {
      // H1: never delete — inactivate the managed row so history survives.
      // M6: a baja clears the credentials so the inactive row holds no zombie login/password.
      await csRepo.update(existing.id, {
        status: 'inactive',
        ...(clearCredentialsOnInactive ? { tvLogin: null, tvPassword: null } : {}),
      });
      return { contractServiceId: existing.id };
    }
    // H2/M8: ensure a managed row exists for a fresh account so the credentials have a home.
    if (ensureRow) {
      const created = await csRepo.add({
        contractId,
        serviceCatalogId: tvCatalog.id,
        notes: `${GIGARED_NOTES_PREFIX}${account.cic}`,
      });
      // Brand-new account → start inactive (no packs yet). The add() default status is 'active',
      // so force it down.
      await csRepo.update(created.id, { status: 'inactive' });
      return { contractServiceId: created.id };
    }
    return {};
  }

  const notes = `${GIGARED_NOTES_PREFIX}${account.cic} · ${services.map((s) => s.name).join(' · ')}`;

  if (existing) {
    // M6: if the cic changed, the credentials of the OLD account must not survive the reactivation.
    const cicChanged = cicFromNotes(existing.notes) !== account.cic;
    await csRepo.update(existing.id, {
      status: 'active',
      notes,
      ...(cicChanged ? { tvLogin: null, tvPassword: null } : {}),
    });
    return { contractServiceId: existing.id };
  }
  const created = await csRepo.add({ contractId, serviceCatalogId: tvCatalog.id, notes });
  return { contractServiceId: created.id };
}
