import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { MaterialConsumptionDto, toMaterialConsumptionDto } from '@application/dto/MaterialConsumptionDto';

/** Lists all material consumptions for a task, with resolved recordedByUserName. */
export class ListTaskMaterialConsumptions {
  constructor(
    private readonly consumptions: TaskMaterialConsumptionRepository,
    private readonly users: RbacUserRepository,
  ) {}

  async execute(taskId: string): Promise<MaterialConsumptionDto[]> {
    const records = await this.consumptions.listByTask(taskId);
    return Promise.all(
      records.map(async r => {
        const user = r.recordedByUserId ? await this.users.findById(r.recordedByUserId) : null;
        return toMaterialConsumptionDto(r, user?.name ?? null);
      }),
    );
  }
}
