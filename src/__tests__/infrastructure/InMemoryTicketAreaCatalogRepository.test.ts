import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';

describe('InMemoryTicketAreaCatalogRepository', () => {
  let repo: InMemoryTicketAreaCatalogRepository;

  beforeEach(() => {
    repo = new InMemoryTicketAreaCatalogRepository();
  });

  it('starts empty', async () => {
    expect(await repo.list()).toHaveLength(0);
  });

  it('creates and retrieves by id', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    expect(area.id).toBeTruthy();
    const found = await repo.getById(area.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Soporte');
  });

  it('getByName is case-insensitive', async () => {
    await repo.create({ name: 'Soporte', color: '#6366f1' });
    const found = await repo.getByName('soporte');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Soporte');
  });

  it('getByName returns null when not found', async () => {
    expect(await repo.getByName('Nonexistent')).toBeNull();
  });

  it('getById returns null when not found', async () => {
    expect(await repo.getById('nonexistent-id')).toBeNull();
  });

  it('update changes the name', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    const updated = await repo.update(area.id, { name: 'Soporte Técnico' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Soporte Técnico');
  });

  it('update returns null for missing id', async () => {
    expect(await repo.update('missing', { name: 'X' })).toBeNull();
  });

  it('delete removes the area', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    const ok = await repo.delete(area.id);
    expect(ok).toBe(true);
    expect(await repo.getById(area.id)).toBeNull();
  });

  it('delete returns false for missing id', async () => {
    expect(await repo.delete('missing')).toBe(false);
  });

  it('countInUse returns ticket count by area id', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    repo.ticketCounts[area.id] = 5;
    expect(await repo.countInUse(area.id)).toBe(5);
  });

  it('countInUse returns 0 when no tickets', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    expect(await repo.countInUse(area.id)).toBe(0);
  });

  describe('portal-ticket-topic — portalVisible/portalLabel/portalDescription/portalOrder', () => {
    it('create defaults portalVisible=false, portalLabel/portalDescription=null, portalOrder=0 (el lado SEGURO)', async () => {
      const area = await repo.create({ name: 'NOC', color: '#333333' });
      expect(area.portalVisible).toBe(false);
      expect(area.portalLabel).toBeNull();
      expect(area.portalDescription).toBeNull();
      expect(area.portalOrder).toBe(0);
    });

    it('create acepta los campos portal-* explícitamente', async () => {
      const area = await repo.create({
        name: 'Soporte',
        color: '#6366f1',
        portalVisible: true,
        portalLabel: 'Problemas técnicos',
        portalDescription: 'No anda internet',
        portalOrder: 1,
      });
      expect(area.portalVisible).toBe(true);
      expect(area.portalLabel).toBe('Problemas técnicos');
      expect(area.portalDescription).toBe('No anda internet');
      expect(area.portalOrder).toBe(1);
    });

    it('update cambia portalVisible/portalLabel/portalDescription/portalOrder', async () => {
      const area = await repo.create({ name: 'Administración', color: '#f59e0b' });
      const updated = await repo.update(area.id, {
        portalVisible: true,
        portalLabel: 'Mis datos y contrato',
        portalDescription: 'Titularidad, domicilio, datos personales',
        portalOrder: 3,
      });
      expect(updated!.portalVisible).toBe(true);
      expect(updated!.portalLabel).toBe('Mis datos y contrato');
      expect(updated!.portalDescription).toBe('Titularidad, domicilio, datos personales');
      expect(updated!.portalOrder).toBe(3);
    });

    it('listPortalVisible NO devuelve las áreas internas (fixture con >=2 visibles y >=2 internas)', async () => {
      const soporte = await repo.create({ name: 'Soporte', color: '#1', portalVisible: true, portalOrder: 1 });
      const facturacion = await repo.create({ name: 'Facturación', color: '#2', portalVisible: true, portalOrder: 2 });
      await repo.create({ name: 'NOC', color: '#3', portalVisible: false });
      await repo.create({ name: 'GigaRed', color: '#4', portalVisible: false });

      const visible = await repo.listPortalVisible();

      expect(visible.map((a) => a.id).sort()).toEqual([soporte.id, facturacion.id].sort());
      expect(visible.some((a) => a.name === 'NOC' || a.name === 'GigaRed')).toBe(false);
    });

    it('listPortalVisible respeta portalOrder ASC y desempata por name ASC', async () => {
      const c = await repo.create({ name: 'Charlie', color: '#1', portalVisible: true, portalOrder: 2 });
      const a = await repo.create({ name: 'Alpha', color: '#2', portalVisible: true, portalOrder: 1 });
      const b = await repo.create({ name: 'Bravo', color: '#3', portalVisible: true, portalOrder: 1 });

      const visible = await repo.listPortalVisible();

      expect(visible.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    });

    it('getPortalVisibleById devuelve el área cuando portalVisible=true', async () => {
      const area = await repo.create({ name: 'Soporte', color: '#1', portalVisible: true });
      const found = await repo.getPortalVisibleById(area.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(area.id);
    });

    it('getPortalVisibleById devuelve null para un área INTERNA (portalVisible=false) — misma respuesta que un id inexistente', async () => {
      const internalArea = await repo.create({ name: 'NOC', color: '#1', portalVisible: false });
      const foundInternal = await repo.getPortalVisibleById(internalArea.id);
      const foundMissing = await repo.getPortalVisibleById('does-not-exist');
      expect(foundInternal).toBeNull();
      expect(foundMissing).toBeNull();
    });
  });
});
