/**
 * #85 — DeleteTicketHard use case.
 * RED: fails until DeleteTicketHard is created.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { DeleteTicketHard } from '@application/use-cases/DeleteTicketHard';

describe('DeleteTicketHard use case (#85)', () => {
  let repo: InMemoryTicketRepository;
  let deleteTicketHard: DeleteTicketHard;

  beforeEach(() => {
    repo = new InMemoryTicketRepository();
    deleteTicketHard = new DeleteTicketHard(repo);
  });

  it('deletes an existing ticket and returns true', async () => {
    const ticket = await repo.create({ subject: 'T1', description: 'd1' });
    const result = await deleteTicketHard.execute(ticket.id);
    expect(result).toBe(true);
    const found = await repo.getById(ticket.id);
    expect(found).toBeNull();
  });

  it('returns false for a nonexistent id', async () => {
    const result = await deleteTicketHard.execute('nonexistent');
    expect(result).toBe(false);
  });
});
