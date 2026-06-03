import type { TaskActivity } from '@domain/entities/taskActivity';
import type {
  CreateTaskActivityInput,
  TaskActivityRepository,
} from '@domain/ports/TaskActivityRepository';

/**
 * RecordTaskActivity — internal write use case (#10).
 *
 * Thin wrapper over `TaskActivityRepository.create` / `createMany`. Kept as a use
 * case (rather than calling the repo directly from the recorder) so the
 * persistence semantics can be unit-tested in Strict TDD independently of the
 * recorder's best-effort resilience wrapper. This UC does NOT swallow errors —
 * that contract lives in `DefaultTaskActivityRecorder`.
 */
export class RecordTaskActivity {
  constructor(private readonly repo: TaskActivityRepository) {}

  async execute(input: CreateTaskActivityInput): Promise<TaskActivity> {
    return this.repo.create(input);
  }

  async executeMany(inputs: CreateTaskActivityInput[]): Promise<number> {
    return this.repo.createMany(inputs);
  }
}
