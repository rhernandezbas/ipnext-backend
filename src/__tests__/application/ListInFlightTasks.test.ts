import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { ListInFlightTasks } from '@application/use-cases/ListInFlightTasks';
import { Stage } from '@domain/entities/workflow';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };
const INSTALADO: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(INSTALADO);
  const scheduling = new InMemorySchedulingRepository(stages);
  const useCase = new ListInFlightTasks(scheduling);
  return { stages, scheduling, useCase };
}

describe('ListInFlightTasks', () => {
  it('returns InFlightTaskDto[] for tasks in registered_in_iclass with correct fields', async () => {
    const { scheduling, useCase } = setup();
    scheduling.seedTask({
      id: 't1',
      sequenceNumber: 4013,
      stageId: REGISTRADO.id,
      title: 'Instalación fibra',
      customerName: 'Juan Pérez',
      customerCode: 'CLI-99',
      iclassOrderCode: 'SO-900',
    });

    const result = await useCase.execute();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 't1',
      sequenceNumber: 4013,
      title: 'Instalación fibra',
      customerName: 'Juan Pérez',
      customerCode: 'CLI-99',
      iclassOrderCode: 'SO-900',
    });
  });

  it('does NOT return raw ScheduledTask fields (DTO only)', async () => {
    const { scheduling, useCase } = setup();
    scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });

    const result = await useCase.execute();

    // Raw entity fields that must NOT leak through the DTO.
    expect(result[0]).not.toHaveProperty('stageId');
    expect(result[0]).not.toHaveProperty('stageCategory');
    expect(result[0]).not.toHaveProperty('createdAt');
    expect(result[0]).not.toHaveProperty('priority');
  });

  it('returns an empty array when no tasks are in-flight', async () => {
    const { scheduling, useCase } = setup();
    // task in a different stage → not in-flight
    scheduling.seedTask({ id: 't1', sequenceNumber: 9999, stageId: INSTALADO.id });

    const result = await useCase.execute();

    expect(result).toEqual([]);
  });
});
