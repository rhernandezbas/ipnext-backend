import { SyncIClassStatuses } from '@application/use-cases/SyncIClassStatuses';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';
import { IClassUnavailableError } from '@domain/errors/iclass';

function makeSummary(statusCode: string, statusDescription: string, id = '1', codigo = '1') {
  return {
    iclassId: id,
    iclassCodigo: codigo,
    clusterName: 'X', thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
    customerCode: 'c1', customerName: 'Client', addressCode: 'a1', addressLine: 'Addr', addressCity: 'City',
    addressLat: null, addressLng: null,
    statusCode,
    statusDescription,
    requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: null, closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: null, rawDetail: {},
  };
}

describe('SyncIClassStatuses', () => {
  it('discovers distinct statusCodes from IClass and returns counts', async () => {
    const iclass = new InMemoryIClassClient();
    const repo = new InMemoryIClassStatusCatalogRepository();
    iclass.serviceOrders = [
      makeSummary('3', 'Agendada', '1', '1001'),
      makeSummary('7', 'Concluida', '2', '1002'),
      makeSummary('12', 'Em Análise', '3', '1003'),
    ];
    const uc = new SyncIClassStatuses(iclass, repo);
    const result = await uc.execute();

    expect(result.synced).toBe(3);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);

    const items = await repo.list();
    expect(items).toHaveLength(3);
    const codes = items.map(i => i.statusCode).sort();
    expect(codes).toEqual(['12', '3', '7']);
    // All new entries default to tracked=false
    expect(items.every(i => i.tracked === false)).toBe(true);
  });

  it('de-duplicates — same statusCode from multiple SOs is created once', async () => {
    const iclass = new InMemoryIClassClient();
    const repo = new InMemoryIClassStatusCatalogRepository();
    iclass.serviceOrders = [
      makeSummary('7', 'Concluida', '1', '101'),
      makeSummary('7', 'Concluida', '2', '102'),
      makeSummary('7', 'Concluida', '3', '103'),
    ];
    const uc = new SyncIClassStatuses(iclass, repo);
    const result = await uc.execute();

    expect(result.synced).toBe(1); // 1 distinct code
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('re-running updates iclassLabel but preserves operator config (tracked)', async () => {
    const iclass = new InMemoryIClassClient();
    const repo = new InMemoryIClassStatusCatalogRepository();
    iclass.serviceOrders = [makeSummary('12', 'Em Análise', '1', '1001')];

    const uc = new SyncIClassStatuses(iclass, repo);
    await uc.execute();
    // Operator configures the entry
    await repo.update('12', { tracked: true, displayLabel: 'En análisis' });

    // Sync again with updated label from IClass
    iclass.serviceOrders = [makeSummary('12', 'Em Análise (v2)', '1', '1001')];
    const result2 = await uc.execute();

    expect(result2.synced).toBe(1);
    expect(result2.created).toBe(0);
    expect(result2.updated).toBe(1);

    const entry = await repo.getByStatusCode('12');
    expect(entry!.iclassLabel).toBe('Em Análise (v2)');
    expect(entry!.tracked).toBe(true);         // preserved
    expect(entry!.displayLabel).toBe('En análisis'); // preserved
  });

  it('discards empty statusCode (post-trim)', async () => {
    const iclass = new InMemoryIClassClient();
    const repo = new InMemoryIClassStatusCatalogRepository();
    iclass.serviceOrders = [
      makeSummary('', 'Sin estado', '1', '1001'),
      makeSummary('  ', 'Solo espacios', '2', '1002'),
      makeSummary('7', 'Concluida', '3', '1003'),
    ];
    const uc = new SyncIClassStatuses(iclass, repo);
    const result = await uc.execute();

    expect(result.synced).toBe(1); // only '7'
    expect(result.created).toBe(1);
    const items = await repo.list();
    expect(items).toHaveLength(1);
    expect(items[0].statusCode).toBe('7');
  });

  it('throws when IClass is unavailable', async () => {
    const iclass = new InMemoryIClassClient();
    const repo = new InMemoryIClassStatusCatalogRepository();
    iclass.failureMode = 'unavailable';
    const uc = new SyncIClassStatuses(iclass, repo);
    await expect(uc.execute()).rejects.toThrow(IClassUnavailableError);
  });
});
