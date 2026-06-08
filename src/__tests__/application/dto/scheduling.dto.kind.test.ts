/**
 * A2.1 [RED] Tests para el discriminated union CreateTaskSchema (network-node-task #29).
 * Cubre REQ-VAL-1 del spec.
 */
import { CreateTaskSchema } from '../../../application/dto/scheduling.dto';

const BASE_CUSTOMER = {
  title: 'Tarea de test',
  priority: 'normal',
  estimatedHours: 1,
  category: 'installation',
  kind: 'customer',
  customerId: 'customer-001',
  contractId: 'contract-001',
};

const BASE_NETWORK = {
  title: 'Tarea de RED',
  priority: 'normal',
  estimatedHours: 1,
  category: 'maintenance',
  kind: 'network',
  networkSiteId: 'site-001',
};

// REQ-VAL-1: Customer branch
describe('CreateTaskSchema — customer branch', () => {
  it('valid customer payload passes', () => {
    const r = CreateTaskSchema.safeParse(BASE_CUSTOMER);
    expect(r.success).toBe(true);
  });

  it('customer without contractId is rejected (REQ-VAL-1)', () => {
    const { contractId: _, ...noContract } = BASE_CUSTOMER;
    const r = CreateTaskSchema.safeParse(noContract);
    expect(r.success).toBe(false);
  });

  it('customer without customerId is rejected', () => {
    const { customerId: _, ...noCustomer } = BASE_CUSTOMER;
    const r = CreateTaskSchema.safeParse(noCustomer);
    expect(r.success).toBe(false);
  });
});

// REQ-VAL-1: Network branch
describe('CreateTaskSchema — network branch', () => {
  it('valid network payload passes', () => {
    const r = CreateTaskSchema.safeParse(BASE_NETWORK);
    expect(r.success).toBe(true);
  });

  it('network without networkSiteId is rejected (REQ-VAL-1)', () => {
    const { networkSiteId: _, ...noSiteId } = BASE_NETWORK;
    const r = CreateTaskSchema.safeParse(noSiteId);
    expect(r.success).toBe(false);
  });

  it('network with empty networkSiteId is rejected', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_NETWORK, networkSiteId: '' });
    expect(r.success).toBe(false);
  });

  it('network + customerId combo is rejected (REQ-KIND-2 — mixing modes)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_NETWORK, customerId: 'c-1' });
    expect(r.success).toBe(false);
  });
});

// No kind at all → rejected (union requires kind discriminator)
describe('CreateTaskSchema — missing kind', () => {
  it('payload with no kind field is rejected', () => {
    const r = CreateTaskSchema.safeParse({
      title: 'x',
      priority: 'normal',
      estimatedHours: 1,
      category: 'other',
      customerId: 'c-1',
      contractId: 'ct-1',
    });
    expect(r.success).toBe(false);
  });
});
