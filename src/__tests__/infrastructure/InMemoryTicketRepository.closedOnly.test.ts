/**
 * states-be (F1.5 spec #2 — estados en el panel de contexto) — `closedOnly` es el
 * espejo EXACTO de `openOnly` (fix-be #2): "cerrado" = `resolvedAt` NOT null AND
 * `archivedAt` null. NUNCA se infiere de `TicketStatusCatalog` (no tiene flag de
 * cierre). `countClosedByClientIds` es el espejo de `countOpenByClientIds` — un
 * conteo agregado por cliente, NUNCA el `.length` de una lista top-N truncada.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

describe('InMemoryTicketRepository — closedOnly (states-be, F1.5 spec #2)', () => {
  let repo: InMemoryTicketRepository;

  beforeEach(() => {
    repo = new InMemoryTicketRepository();
  });

  it('closedOnly:true devuelve solo tickets con resolvedAt != null', async () => {
    const open = await repo.create({ subject: 'Abierto', description: 'x' });
    const closed = await repo.create({ subject: 'Cerrado', description: 'x' });
    await repo.close(closed.id, 'closed');

    const res = await repo.list({ closedOnly: true });

    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.id).toBe(closed.id);
    expect(res.data.some((t) => t.id === open.id)).toBe(false);
  });

  it('closedOnly:true excluye tickets archivados (mismo criterio que openOnly)', async () => {
    const closed = await repo.create({ subject: 'Cerrado y archivado', description: 'x' });
    await repo.close(closed.id, 'closed');
    await repo.archive(closed.id);
    const stillClosed = await repo.create({ subject: 'Cerrado sin archivar', description: 'x' });
    await repo.close(stillClosed.id, 'closed');

    const res = await repo.list({ closedOnly: true });

    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.id).toBe(stillClosed.id);
  });

  it('sin closedOnly — devuelve todos (abiertos y cerrados), comportamiento default intacto', async () => {
    await repo.create({ subject: 'Abierto', description: 'x' });
    const closed = await repo.create({ subject: 'Cerrado', description: 'x' });
    await repo.close(closed.id, 'closed');

    const res = await repo.list({});

    expect(res.data).toHaveLength(2);
  });

  describe('countClosedByClientIds', () => {
    it('cuenta solo tickets cerrados por cliente, en una sola pasada', async () => {
      const t1 = await repo.create({ subject: 'C1', description: 'x', customerId: 'c1' });
      await repo.close(t1.id, 'closed');
      const t2 = await repo.create({ subject: 'C2', description: 'x', customerId: 'c1' });
      await repo.close(t2.id, 'closed');
      await repo.create({ subject: 'Abierto c1', description: 'x', customerId: 'c1' }); // no cuenta
      const t3 = await repo.create({ subject: 'C3', description: 'x', customerId: 'c2' });
      await repo.close(t3.id, 'closed');

      const result = await repo.countClosedByClientIds(['c1', 'c2']);

      expect(result.get('c1')).toBe(2);
      expect(result.get('c2')).toBe(1);
    });

    it('excluye tickets cerrados y archivados del conteo', async () => {
      const t1 = await repo.create({ subject: 'C1', description: 'x', customerId: 'c1' });
      await repo.close(t1.id, 'closed');
      await repo.archive(t1.id);
      const t2 = await repo.create({ subject: 'C2', description: 'x', customerId: 'c1' });
      await repo.close(t2.id, 'closed');

      const result = await repo.countClosedByClientIds(['c1']);

      expect(result.get('c1')).toBe(1);
    });

    it('clientIds vacio — devuelve un Map vacio sin iterar', async () => {
      const t1 = await repo.create({ subject: 'C1', description: 'x', customerId: 'c1' });
      await repo.close(t1.id, 'closed');

      const result = await repo.countClosedByClientIds([]);

      expect(result.size).toBe(0);
    });

    it('cliente sin tickets cerrados esta ausente del Map (caller default a 0)', async () => {
      await repo.create({ subject: 'Abierto', description: 'x', customerId: 'c1' });

      const result = await repo.countClosedByClientIds(['c1']);

      expect(result.has('c1')).toBe(false);
    });
  });
});
