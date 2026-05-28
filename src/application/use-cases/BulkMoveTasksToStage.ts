import { MoveTaskToStage } from './MoveTaskToStage';
import { mapWithConcurrency } from '../util/mapWithConcurrency';
import { domainErrorToCode } from '../util/domainErrorToCode';

/** Max tasks processed in parallel — bounded to avoid saturating IClass (AD-2). */
const CONCURRENCY = 5;

export interface BulkMoveResult {
  taskId: string;
  ok: boolean;
  errorCode?: string;
  reason?: string;
  missingFields?: string[];
}

export interface BulkMoveSummary {
  total: number;
  ok: number;
  failed: number;
}

export interface BulkMoveTasksToStageOutput {
  summary: BulkMoveSummary;
  results: BulkMoveResult[];
}

/**
 * Moves N tasks to a stage, reusing MoveTaskToStage per id (AD-1). Failures are
 * captured per task — the operation is non-atomic and never throws on a per-task
 * error (AD-3). Results preserve input order (AD-5). Bounded concurrency (AD-2).
 */
export class BulkMoveTasksToStage {
  constructor(private readonly move: MoveTaskToStage) {}

  async execute(ids: string[], stageId: string): Promise<BulkMoveTasksToStageOutput> {
    const results = await mapWithConcurrency<string, BulkMoveResult>(
      ids,
      CONCURRENCY,
      async (id) => {
        try {
          await this.move.execute(id, stageId);
          return { taskId: id, ok: true };
        } catch (e) {
          const mapped = domainErrorToCode(e);
          return { taskId: id, ok: false, ...(mapped ?? { errorCode: 'UNKNOWN' }) };
        }
      },
    );

    const ok = results.filter((r) => r.ok).length;
    return {
      summary: { total: results.length, ok, failed: results.length - ok },
      results,
    };
  }
}
