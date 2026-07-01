import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { GrContract } from '@domain/entities/gestionReal';
import { FetchContractsDeltaParams } from '@domain/ports/GestionRealPort';

function contract(id: string, cli: string, modificado: string | null): GrContract {
  return {
    grContratoId: id,
    grClienteId: cli,
    plan: 'IP-Air-30',
    status: 'Vigente',
    startDate: '01-01-2025',
    address: null,
    lat: null,
    lng: null,
    pppoeUsername: null,
    modificado,
    fechaCreacion: null,
    vendedor: null,
    raw: {},
  };
}

describe('InMemoryGestionRealPort.fetchContractsModifiedSince', () => {
  let gr: InMemoryGestionRealPort;

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
  });

  it('filters by modificado >= fechaDesde', async () => {
    gr.contractsModified = [
      contract('c1', '111', '18-06-2026 10:00:00'),  // before → excluded
      contract('c2', '222', '20-06-2026 10:00:00'),  // inside → included
      contract('c3', '333', '22-06-2026 08:00:00'),  // inside → included
    ];

    const result = await gr.fetchContractsModifiedSince({
      fechaDesde: '20-06-2026',
      fechaHasta: '30-06-2026',
      cantidad: 100,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.contracts.map(c => c.grContratoId)).toEqual(['c2', 'c3']);
  });

  it('paginates correctly with cantidad and offset', async () => {
    gr.contractsModified = [
      contract('c1', '111', '20-06-2026 09:00:00'),
      contract('c2', '222', '20-06-2026 10:00:00'),
      contract('c3', '333', '20-06-2026 11:00:00'),
    ];

    const page1 = await gr.fetchContractsModifiedSince({
      fechaDesde: '20-06-2026',
      fechaHasta: '30-06-2026',
      cantidad: 2,
      offset: 0,
    });
    expect(page1.total).toBe(3);
    expect(page1.contracts).toHaveLength(2);
    expect(page1.contracts[0].grContratoId).toBe('c1');

    const page2 = await gr.fetchContractsModifiedSince({
      fechaDesde: '20-06-2026',
      fechaHasta: '30-06-2026',
      cantidad: 2,
      offset: 2,
    });
    expect(page2.total).toBe(3);
    expect(page2.contracts).toHaveLength(1);
    expect(page2.contracts[0].grContratoId).toBe('c3');
  });

  it('records calls in contractsDeltaCalls', async () => {
    gr.contractsModified = [];
    const params: FetchContractsDeltaParams = {
      fechaDesde: '20-06-2026',
      fechaHasta: '30-06-2026',
      cantidad: 10,
      offset: 0,
    };

    await gr.fetchContractsModifiedSince(params);

    expect(gr.contractsDeltaCalls).toHaveLength(1);
    expect(gr.contractsDeltaCalls[0]).toEqual(params);
  });

  it('returns empty contracts and total 0 when no contracts match', async () => {
    gr.contractsModified = [
      contract('old', '111', '01-01-2025 10:00:00'),
    ];

    const result = await gr.fetchContractsModifiedSince({
      fechaDesde: '20-06-2026',
      fechaHasta: '30-06-2026',
      cantidad: 100,
      offset: 0,
    });

    expect(result.total).toBe(0);
    expect(result.contracts).toHaveLength(0);
  });

  it('skips contracts with null modificado', async () => {
    gr.contractsModified = [
      { ...contract('nomod', '111', '20-06-2026 10:00:00'), modificado: null },
      contract('hasmod', '222', '20-06-2026 10:00:00'),
    ];

    const result = await gr.fetchContractsModifiedSince({
      fechaDesde: '20-06-2026',
      fechaHasta: '30-06-2026',
      cantidad: 100,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.contracts[0].grContratoId).toBe('hasmod');
  });
});
