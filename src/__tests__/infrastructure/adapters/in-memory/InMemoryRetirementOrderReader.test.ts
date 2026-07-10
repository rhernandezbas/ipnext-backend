import { InMemoryRetirementOrderReader } from '@infrastructure/adapters/in-memory/InMemoryRetirementOrderReader';

describe('InMemoryRetirementOrderReader', () => {
  let reader: InMemoryRetirementOrderReader;

  beforeEach(() => {
    reader = new InMemoryRetirementOrderReader();
  });

  it('matchea por contractId cuando la task pertenece a un proyecto con allowsEquipmentRetirement', async () => {
    reader.seedTask({ id: 't1', contractId: 'ct-1', clientId: null, allowsEquipmentRetirement: true });

    const result = await reader.hasRetirementTask({ contractId: 'ct-1' });

    expect(result).toEqual({ exists: true, taskId: 't1' });
  });

  it('matchea por clientId (customerId de la task) cuando el contrato no está linkeado', async () => {
    reader.seedTask({ id: 't2', contractId: null, clientId: 'cli-1', allowsEquipmentRetirement: true });

    const result = await reader.hasRetirementTask({ contractId: 'ct-otro', clientId: 'cli-1' });

    expect(result).toEqual({ exists: true, taskId: 't2' });
  });

  // M4 — sin falsos positivos: la pata por cliente SOLO cuenta tasks sin contrato
  // linkeado. Una task de retiro de OTRO contrato del mismo cliente NO cubre esta baja.
  it('una task de retiro de OTRO contrato del mismo cliente NO cuenta (falso positivo M4)', async () => {
    reader.seedTask({ id: 't5', contractId: 'ct-OTRO', clientId: 'cli-1', allowsEquipmentRetirement: true });

    const result = await reader.hasRetirementTask({ contractId: 'ct-1', clientId: 'cli-1' });

    expect(result.exists).toBe(false);
  });

  it('una task de proyecto SIN retirement flag NO cuenta', async () => {
    reader.seedTask({ id: 't3', contractId: 'ct-1', clientId: null, allowsEquipmentRetirement: false });

    const result = await reader.hasRetirementTask({ contractId: 'ct-1' });

    expect(result.exists).toBe(false);
    expect(result.taskId).toBeUndefined();
  });

  it('sin match → exists=false sin taskId', async () => {
    const result = await reader.hasRetirementTask({ contractId: 'ct-nada', clientId: 'cli-nada' });

    expect(result).toEqual({ exists: false });
  });

  it('input sin contractId NI clientId → exists=false SIN matchear todo (guard del OR vacío)', async () => {
    reader.seedTask({ id: 't4', contractId: 'ct-1', clientId: 'cli-1', allowsEquipmentRetirement: true });

    const result = await reader.hasRetirementTask({});

    expect(result.exists).toBe(false);
  });
});
