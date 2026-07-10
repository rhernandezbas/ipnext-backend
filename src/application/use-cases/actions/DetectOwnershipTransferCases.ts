import { OwnershipCaseRepository } from '@domain/ports/OwnershipCaseRepository';
import { ContractPairingReader } from '@domain/ports/ContractPairingReader';
import { PairingContract } from '@domain/entities/ownershipCase';

export interface DetectOwnershipCasesResult {
  /** Titularity bajas returned by the capped scan this tick. */
  scanned: number;
  /** New cases opened this run. */
  created: number;
  /** Bajas skipped: case already exists (idempotency) OR the per-baja create failed. */
  skipped: number;
  /** Pristine cases re-paired this run (target set or promoted to ambiguous) — H1a. */
  repaired: number;
}

/**
 * Cap per tick (M2/B1). NO time window — the mirror cannot express one (no
 * updatedAt, no persisted baja date). Acceptance: motivoBaja is forward-only,
 * already-cased rows are EXCLUDED from the scan (fix wave 2 — that exclusion is
 * what makes the cap drain across ticks), and per-source idempotency covers
 * intra-tick races. Backlog beyond the cap drains in later ticks.
 */
const DEFAULT_BATCH_LIMIT = 500;

/**
 * actions-worklist DET-1 — scans the GR mirror for contracts in `baja` with a
 * CAMBIO DE TITULARIDAD motivo and opens one OwnershipTransferCase per contract.
 *
 * Runs as a SEPARATE post-sync pata of the GestionRealSyncScheduler (never a hook
 * inside the delta use case — invariante "execute() intacto" del change recapture).
 *
 * Pairing is conservative (F0-verified keys: same startDate + same address, other
 * client, non-baja):
 *   - exactly 1 candidate  → `pending` with target set
 *   - >=2 candidates       → `ambiguous` + candidates JSON (manual pick later)
 *   - 0 candidates         → `pending` without target (visible, resolvable by hand)
 *
 * Idempotent per sourceContractId, with ONE exception (H1a): PRISTINE cases —
 * `pending`, no target, no candidates, no manual review (nothing human happened
 * yet) — are RE-PAIRED each tick. This closes the F0 timing dead-end: when the
 * baja and the alta land in the mirror on different ticks (seconds apart vs the
 * 3-minute tick), the case is born target-less and the next tick repairs it.
 * NON-pristine cases (operator advanced them in ANY way) are NEVER touched.
 *
 * Robustness (M2): each baja/case is processed in its own try/catch — a P2002
 * race or a bad row counts as skipped and never aborts the rest of the batch.
 * Errors outside the loops propagate to the scheduler pata, which swallows +
 * logs them (best-effort, same as the delta pata).
 */
export class DetectOwnershipTransferCases {
  private readonly batchLimit: number;

  constructor(
    private readonly caseRepo: OwnershipCaseRepository,
    private readonly pairingReader: ContractPairingReader,
    opts?: { batchLimit?: number },
  ) {
    this.batchLimit = opts?.batchLimit ?? DEFAULT_BATCH_LIMIT;
  }

  async execute(): Promise<DetectOwnershipCasesResult> {
    // H1a — re-pair pristine cases FIRST (cases created this tick with 0
    // candidates would re-pair against the same mirror state: wasted reads).
    const repaired = await this.repairPristineCases();

    // Fix wave 2 — the cap DRAINS: rows that already have a case are excluded
    // from the scan (otherwise the WHERE matches them forever and the same
    // `limit` rows occupy every batch — createdAt is mirror-row creation time,
    // not baja time, so newest-first alone never drained). The cased-id set is
    // bounded: one id per real titularity baja.
    const casedIds = await this.caseRepo.listAllSourceContractIds();
    const bajas = await this.pairingReader.findTitularityBajas({
      limit: this.batchLimit,
      excludeContractIds: casedIds,
    });

    let created = 0;
    let skipped = 0;

    for (const baja of bajas) {
      // M2 — per-baja guard: one bad row / P2002 race never aborts the batch.
      try {
        // Belt for INTRA-tick races: a case created after the cased-id snapshot
        // (concurrent detector/HTTP) is a cheap skip, not a P2002 throw.
        if (await this.caseRepo.existsBySourceContract(baja.id)) {
          skipped++;
          continue;
        }

        const candidates = await this.findCandidates(baja);

        if (candidates.length === 1) {
          const target = candidates[0]!;
          await this.caseRepo.create({
            sourceContractId: baja.id,
            sourceClientId: baja.clientId,
            motivoBaja: baja.motivoBaja ?? '',
            targetContractId: target.id,
            targetClientId: target.clientId,
            status: 'pending',
          });
        } else if (candidates.length >= 2) {
          await this.caseRepo.create({
            sourceContractId: baja.id,
            sourceClientId: baja.clientId,
            motivoBaja: baja.motivoBaja ?? '',
            candidates: candidates.map((c) => ({ contractId: c.id, clientId: c.clientId })),
            status: 'ambiguous',
          });
        } else {
          await this.caseRepo.create({
            sourceContractId: baja.id,
            sourceClientId: baja.clientId,
            motivoBaja: baja.motivoBaja ?? '',
            status: 'pending',
          });
        }
        created++;
      } catch {
        skipped++;
      }
    }

    return { scanned: bajas.length, created, skipped, repaired };
  }

  /**
   * H1a — pristine cases (pending, no target, no candidates, no manual review)
   * are re-paired against the current mirror: 1 candidate → target set (stays
   * pending); >=2 → promoted to ambiguous with the candidates list; 0 → stays
   * pristine for the next tick. A source contract gone from the mirror (or a
   * per-case error) is skipped without aborting the batch.
   *
   * Fix wave 2 — the write is a CAS (`updateIfPristine`): an operator can
   * dismiss or set-target the case over HTTP BETWEEN the pristine listing and
   * this write; an unconditional update would resurrect the dismissed case (or
   * overwrite the operator's target). The conditional write re-checks the
   * pristine shape — count 0 → skip, NOT counted as repaired.
   */
  private async repairPristineCases(): Promise<number> {
    const pristine = await this.caseRepo.listPristineUnpaired(this.batchLimit);

    let repaired = 0;
    for (const kase of pristine) {
      try {
        const source = await this.pairingReader.getContract(kase.sourceContractId);
        if (source === null) continue;

        const candidates = await this.findCandidates(source);

        if (candidates.length === 1) {
          const target = candidates[0]!;
          const applied = await this.caseRepo.updateIfPristine(kase.id, {
            targetContractId: target.id,
            targetClientId: target.clientId,
          });
          if (applied) repaired++;
        } else if (candidates.length >= 2) {
          const applied = await this.caseRepo.updateIfPristine(kase.id, {
            status: 'ambiguous',
            candidates: candidates.map((c) => ({ contractId: c.id, clientId: c.clientId })),
          });
          if (applied) repaired++;
        }
      } catch {
        continue;
      }
    }
    return repaired;
  }

  /**
   * A baja without a usable address can never pair — the F0 key is string-exact
   * address, and a null/blank-to-null/blank match would pair unrelated contracts
   * (L5: blank/whitespace addresses are treated as null). Case still opens
   * (without target) so the operator sees it.
   */
  private async findCandidates(baja: PairingContract): Promise<PairingContract[]> {
    if (baja.address === null || baja.address.trim() === '') return [];
    return this.pairingReader.findActivePairingCandidates({
      startDate: baja.startDate,
      address: baja.address,
      excludeClientId: baja.clientId,
    });
  }
}
