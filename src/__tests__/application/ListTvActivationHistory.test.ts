/**
 * #133-BE — ListTvActivationHistory: reason field must be exposed in DTO.
 *
 * TDD: these tests were written BEFORE adding `reason` to TvActivationEventDto
 * and before wiring it in toDto(). They should fail RED first.
 */
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';

const BASE_EVENT = {
  clientId:  'client-1',
  actorId:   'actor-1',
  actorName: 'Juan Técnico',
  eventType: 'baja' as const,
};

describe('ListTvActivationHistory — reason field in DTO (#133-BE)', () => {
  it('exposes reason in the DTO when the event has one', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ ...BASE_EVENT, reason: 'Mudanza' });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.executeByClient('client-1');

    expect(dto.reason).toBe('Mudanza');
  });

  it('exposes reason as null for legacy events without reason', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ ...BASE_EVENT, reason: null });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.executeByClient('client-1');

    expect(dto.reason).toBeNull();
  });

  it('exposes reason via execute() global filter as well', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ ...BASE_EVENT, clientId: 'client-2', reason: 'No usa más el servicio' });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.execute({ customerId: 'client-2' });

    expect(dto.reason).toBe('No usa más el servicio');
  });

  it('dto has reason: null when record omits reason (implicit undefined → null)', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    // reason not provided at all — in-memory defaults to null via `input.reason ?? null`
    await repo.record({ ...BASE_EVENT });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.executeByClient('client-1');

    expect(dto.reason).toBeNull();
  });
});
