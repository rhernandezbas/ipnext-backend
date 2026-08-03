/**
 * EPIC v3 (clave de TV del portal) — `GetPortalTvStatus`:
 * `GET /api/portal/tv/:contractId`. Lectura 100% LOCAL (nunca toca Gigared):
 * hasTv = el CONTRATO del param tiene la fila TV (ContractService con
 * serviceCatalog name='TV', ancla el contrato — a diferencia de
 * `PrismaTvCredentialsReader`, que ancla por customer) y el login visible es el
 * `tvLogin` del slot. Sin TV -> {hasTv:false, login:null} (estado NORMAL, mismo
 * criterio que la elegibilidad WiFi). Contrato ajeno/inexistente ->
 * ContractNotFoundError (404 indistinguible).
 */
import { GetPortalTvStatus } from '@application/use-cases/portal/GetPortalTvStatus';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

const contractLookup = (owners: Record<string, string>) => ({
  findById: async (id: string) => (owners[id] ? { id, clientId: owners[id]! } : null),
});

describe('GetPortalTvStatus', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;
  let tvId: string;

  beforeEach(async () => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
    const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    tvId = cat.id;
    cs.catalog[cat.id] = { name: cat.name, label: cat.label };
  });

  it('contrato con slot TV activo -> {hasTv:true, login: tvLogin del slot}', async () => {
    await cs.add({ contractId: 'C1', serviceCatalogId: tvId, tvLogin: 'GIGA12345', tvPassword: 'ip243200' });
    const uc = new GetPortalTvStatus(contractLookup({ C1: 'client-a' }), catalog, cs);

    await expect(uc.execute('client-a', 'C1')).resolves.toEqual({ hasTv: true, login: 'GIGA12345' });
  });

  it('slot TV sin tvLogin (todavía no impactado) -> {hasTv:true, login:null} — jamás la password', async () => {
    await cs.add({ contractId: 'C1', serviceCatalogId: tvId });
    const uc = new GetPortalTvStatus(contractLookup({ C1: 'client-a' }), catalog, cs);

    await expect(uc.execute('client-a', 'C1')).resolves.toEqual({ hasTv: true, login: null });
  });

  it('contrato SIN servicio TV -> {hasTv:false, login:null} (200, estado normal — no un error)', async () => {
    const uc = new GetPortalTvStatus(contractLookup({ C1: 'client-a' }), catalog, cs);
    await expect(uc.execute('client-a', 'C1')).resolves.toEqual({ hasTv: false, login: null });
  });

  it('slot TV INACTIVO (baja/rebaja) -> {hasTv:false, login:null} — el cliente no ve un servicio dado de baja', async () => {
    const row = await cs.add({ contractId: 'C1', serviceCatalogId: tvId, tvLogin: 'GIGA12345' });
    await cs.update(row.id, { status: 'inactive' });
    const uc = new GetPortalTvStatus(contractLookup({ C1: 'client-a' }), catalog, cs);

    await expect(uc.execute('client-a', 'C1')).resolves.toEqual({ hasTv: false, login: null });
  });

  it('anti-IDOR: contrato de OTRO cliente -> ContractNotFoundError, INDISTINGUIBLE del inexistente', async () => {
    await cs.add({ contractId: 'C2', serviceCatalogId: tvId, tvLogin: 'GIGA99999' });
    const uc = new GetPortalTvStatus(contractLookup({ C2: 'client-b' }), catalog, cs);

    const foreign = uc.execute('client-a', 'C2').catch((e) => e);
    const missing = uc.execute('client-a', 'no-existe').catch((e) => e);
    const [f, m] = await Promise.all([foreign, missing]);
    expect(f).toBeInstanceOf(ContractNotFoundError);
    expect(m).toBeInstanceOf(ContractNotFoundError);
  });

  it('catálogo sin entrada TV activa -> {hasTv:false, login:null} (nadie tiene TV, no un 500)', async () => {
    const emptyCatalog = new InMemoryServiceCatalogRepository();
    const uc = new GetPortalTvStatus(contractLookup({ C1: 'client-a' }), emptyCatalog, cs);
    await expect(uc.execute('client-a', 'C1')).resolves.toEqual({ hasTv: false, login: null });
  });
});
