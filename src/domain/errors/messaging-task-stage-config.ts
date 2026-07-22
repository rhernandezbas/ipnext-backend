import { DomainError } from './index';

/**
 * bulk-task-recipients (D2, TSC-4) — typed error for the config-CRUD capability
 * `messaging-task-stage-config`. Deliberately SEPARATE from `messaging-bulk.ts` (the
 * bulk-recipients delta errors): this one is thrown by
 * `TaskStageRecipientConfigRepository.replaceMappedStages` when translating a Prisma
 * FK violation (P2003) — it belongs to the config capability, not to the resolver
 * wiring. Molde: `domain/errors/nocBroadcast.ts`.
 */

/**
 * `replaceMappedStages` received a `stageId` that does not correspond to an existing
 * `Stage` — the adapter's `$transaction` rolled back (todo-o-nada, previous config
 * preserved). The global errorHandler maps `TASK_STAGE_NOT_FOUND` → 422.
 */
export class TaskStageNotFoundError extends DomainError {
  constructor(message = 'Uno o más stageIds no corresponden a un Stage existente') {
    super(message, 'TASK_STAGE_NOT_FOUND');
    this.name = 'TaskStageNotFoundError';
  }
}
