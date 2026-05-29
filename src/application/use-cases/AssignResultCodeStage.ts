import { IClassResultCode } from '@domain/entities/iclass-result-code';
import { IClassResultCodeRepository } from '@domain/ports/IClassResultCodeRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { IClassResultCodeNotFoundError } from '@domain/errors/iclass';
import { StageNotFoundError } from '@domain/errors/scheduling';

/**
 * Configure (or clear) the closure mapping for a result code: which Stage a task
 * is moved to when its SO closes with this result code. Mirrors
 * AssignIClassSoTypeToProject.
 *
 * - stageId null  → clear the mapping (always allowed).
 * - stageId set   → validate the Stage exists, then persist.
 *
 * Throws StageNotFoundError (404) for a ghost stage, IClassResultCodeNotFoundError
 * (404) when the result-code id does not exist.
 */
export class AssignResultCodeStage {
  constructor(
    private readonly resultCodes: IClassResultCodeRepository,
    private readonly stages: StageRepository,
  ) {}

  async execute(resultCodeId: string, stageId: string | null): Promise<IClassResultCode> {
    if (stageId !== null) {
      const stage = await this.stages.getById(stageId);
      if (!stage) throw new StageNotFoundError(stageId);
    }

    const updated = await this.resultCodes.assignStage(resultCodeId, stageId);
    if (!updated) throw new IClassResultCodeNotFoundError(resultCodeId);

    return updated;
  }
}
