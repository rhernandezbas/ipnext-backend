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
 */
export async function reconcileTvContractService(deps: {
  gigared: GigaredPort;
  csRepo: ContractServiceRepository;
  catalogRepo: ServiceCatalogRepository;
  customerId: string;
  contractId: string;
}): Promise<{ contractServiceId?: string }> {
  const { gigared, csRepo, catalogRepo, customerId, contractId } = deps;

  const tvCatalog = await catalogRepo.getByName('TV');
  if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();

  const account = await gigared.getAccountByInternalId(customerId);
  const existing = await csRepo.getByPair(contractId, tvCatalog.id);

  // H2: a row that exists but is NOT Gigared-managed is off-limits — leave it untouched.
  if (existing && !isGigaredManaged(existing.notes)) {
    return {};
  }

  if (account.services.length === 0) {
    // H1: never delete — inactivate the managed row so history survives. Idempotent if absent.
    if (existing) await csRepo.update(existing.id, { status: 'inactive' });
    return existing ? { contractServiceId: existing.id } : {};
  }

  const notes = `${GIGARED_NOTES_PREFIX}${account.cic} · ${account.services.map((s) => s.name).join(' · ')}`;

  if (existing) {
    await csRepo.update(existing.id, { status: 'active', notes });
    return { contractServiceId: existing.id };
  }
  const created = await csRepo.add({ contractId, serviceCatalogId: tvCatalog.id, notes });
  return { contractServiceId: created.id };
}
