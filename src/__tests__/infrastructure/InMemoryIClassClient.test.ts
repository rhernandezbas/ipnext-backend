import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { CreateServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassUnavailableError } from '@domain/errors/iclass';

const baseInput: CreateServiceOrderInput = {
  customerCode: 'C1',
  customerName: 'Juan Perez',
  phone: '099111222',
  address: 'Calle Falsa 123',
  city: 'Mercedes',
  description: 'Instalación',
};

describe('InMemoryIClassClient', () => {
  it('listNodes() returns the configured nodes', async () => {
    const client = new InMemoryIClassClient();
    client.nodes = [
      { code: 'Mercedes', description: 'Mercedes SY' },
      { code: 'Dolores', description: 'Dolores SY' },
    ];

    const nodes = await client.listNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.code).sort()).toEqual(['Dolores', 'Mercedes']);
  });

  it('listNodes() defaults to an empty list', async () => {
    const client = new InMemoryIClassClient();
    expect(await client.listNodes()).toEqual([]);
  });

  it('createServiceOrder() registers the OS and returns an orderCode', async () => {
    const client = new InMemoryIClassClient();

    const { orderCode } = await client.createServiceOrder(baseInput);

    expect(typeof orderCode).toBe('string');
    expect(orderCode.length).toBeGreaterThan(0);
    expect(client.createdOrders).toHaveLength(1);
    expect(client.createdOrders[0].input).toEqual(baseInput);
    expect(client.createdOrders[0].orderCode).toBe(orderCode);
  });

  it('createServiceOrder() uses a configurable order code when provided', async () => {
    const client = new InMemoryIClassClient();
    client.nextOrderCode = 'OS-999';

    const { orderCode } = await client.createServiceOrder(baseInput);
    expect(orderCode).toBe('OS-999');
  });

  it('throws IClassUnavailableError on listNodes when failureMode is "unavailable"', async () => {
    const client = new InMemoryIClassClient();
    client.failureMode = 'unavailable';

    await expect(client.listNodes()).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('throws IClassUnavailableError on createServiceOrder when failureMode is "unavailable"', async () => {
    const client = new InMemoryIClassClient();
    client.failureMode = 'unavailable';

    await expect(client.createServiceOrder(baseInput)).rejects.toBeInstanceOf(IClassUnavailableError);
    expect(client.createdOrders).toHaveLength(0);
  });
});
