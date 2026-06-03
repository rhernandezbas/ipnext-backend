import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';

export interface MaterialConsumptionDto extends TaskMaterialConsumption {
  recordedByUserName: string | null;
}

export function toMaterialConsumptionDto(
  entity: TaskMaterialConsumption,
  userName: string | null,
): MaterialConsumptionDto {
  return { ...entity, recordedByUserName: userName };
}
