import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class ClearTaskChecklist {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(taskId: string, actor?: ActorContext): Promise<void> {
    await this.schedulingRepo.clearChecklist(taskId);

    if (this.recorder) {
      await this.recorder.record(taskId, 'checklist_cleared', {
        actor: actor ?? SYSTEM_ACTOR,
      });
    }
  }
}
