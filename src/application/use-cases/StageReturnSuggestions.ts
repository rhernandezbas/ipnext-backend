import { ReturnSuggestionRepository } from '@domain/ports/ReturnSuggestionRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import {
  ReturnSuggestion,
  createReturnSuggestion,
  normalizeSerial,
} from '@domain/entities/return-suggestion';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
import { randomUUID } from 'crypto';

export interface StageReturnSuggestionsInput {
  taskId: string;
  /** IClass iclassId — kept on each suggestion for traceability + the confirm sourceRef. */
  serviceOrderId: string;
  /** OCR'd device candidates for the task (sn/mac per device photo). */
  extractions: OcrExtraction[];
}

/**
 * Stage equipment-return suggestions when a completed RETIRO SO closes (EPIC #38 W4).
 *
 * READ-ONLY w.r.t. stock — this NEVER records a movement. Per OCR serial it tries to
 * match an `installed` InventoryAsset by NORMALIZED serial (MAC as the fallback key when
 * the SN is missing) and writes ONE ReturnSuggestion: `pending` + matchedAssetId when an
 * installed asset matches, `needs_review` otherwise (no match, or the asset is not
 * installed → the repo's findByNormalizedSerial already excludes non-installed). The
 * operator later confirms (ConfirmAssetReturn) — the ONLY mutation.
 *
 * Idempotent: the repo's create() upserts by (serviceOrderId, serialNumber), so a
 * partial-crash re-run dedups silently. The CALLER (closure pipeline) owns the
 * inventoryReturnsProcessed flag (L1) — this use case only stages.
 */
export class StageReturnSuggestions {
  constructor(
    private readonly returns: ReturnSuggestionRepository,
    private readonly assets: InventoryAssetRepository,
  ) {}

  async execute(input: StageReturnSuggestionsInput): Promise<ReturnSuggestion[]> {
    const staged: ReturnSuggestion[] = [];

    for (const e of input.extractions) {
      // MAC fallback (design D4): match on the SN; if the OCR has no SN, use the MAC.
      // normalizeSerial strips the MAC colons, so a MAC-keyed asset still resolves.
      const key = normalizeSerial(e.sn) ?? normalizeSerial(e.mac);
      // Fix #4: a device with NEITHER SN nor MAC is unactionable (can't match/link/dedup).
      // Postgres @@unique treats NULL serialNumber as DISTINCT, so staging a null-key row
      // would duplicate on a partial-crash re-stage. Skip it entirely.
      if (key == null) continue;
      const matched = await this.assets.findByNormalizedSerial(key);

      const suggestion = await this.returns.create(
        createReturnSuggestion({
          id: randomUUID(),
          taskId: input.taskId,
          serviceOrderId: input.serviceOrderId,
          serialNumber: key, // normalized — the stable natural key + confirm sourceRef seed
          mac: e.mac,
          deviceType: e.deviceType,
          matchedAssetId: matched?.id ?? null,
          status: matched ? 'pending' : 'needs_review',
        }),
      );
      staged.push(suggestion);
    }

    return staged;
  }
}
