import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { InFlightTaskDto, toInFlightTaskDto } from '@application/dto/iclassClosure.dto';

/** Stage code que aloja tareas enviadas a IClass y esperando cierre (en vuelo). */
const IN_FLIGHT_STAGE_CODE = 'registered_in_iclass';

/**
 * Lista las tareas actualmente en el stage `registered_in_iclass` (enviadas a
 * IClass, esperando cierre) y las mapea a `InFlightTaskDto`. NUNCA devuelve la
 * entidad cruda — siempre el DTO (regla CLAUDE.md).
 */
export class ListInFlightTasks {
  constructor(private readonly scheduling: SchedulingRepository) {}

  async execute(): Promise<InFlightTaskDto[]> {
    const tasks = await this.scheduling.listTasksInIClassStage(IN_FLIGHT_STAGE_CODE);
    return tasks.map(toInFlightTaskDto);
  }
}
