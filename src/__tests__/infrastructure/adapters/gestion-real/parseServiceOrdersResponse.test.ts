import { parseServiceOrdersResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';

/**
 * Real-shape fixture for the GR `ordenesdeservicio` action.
 * The response is an OBJECT keyed by order id; each value is an order object.
 * Shape confirmed against 884 real PEND orders (2026-05).
 */
const ORDERS_RESPONSE = {
  '551': {
    estado: 'PEND',
    tipo: 'CI',
    cliente: '108254',
    contrato: '1319',
    domicilio: {
      domicilio: 'CALLE 29 N 1284',
      barrio: { codigo: '0', valor: false },
      localidad: { codigo: '19', valor: 'Achupallas' },
      provincia: { codigo: 'BA', valor: 'Buenos Aires' },
    },
    observaciones: 'Instalar &aacute;ntes del viernes',
    creado: '01-05-2026 10:00:00',
    modificado: '02-05-2026 11:00:00',
  },
  '552': {
    estado: 'PEND',
    tipo: 'CO',
    cliente: '108255',
    contrato: '1320',
    domicilio: {
      domicilio: 'AV. SIEMPRE VIVA 742',
      localidad: { codigo: '20', valor: 'Springfield' },
    },
    creado: '01-05-2026 12:00:00',
  },
};

describe('parseServiceOrdersResponse', () => {
  it('normalizes the dict-keyed response into a flat array carrying the order id', () => {
    const orders = parseServiceOrdersResponse(ORDERS_RESPONSE);
    expect(orders).toHaveLength(2);

    const o = orders.find(x => x.grOrdenId === '551')!;
    expect(o).toBeDefined();
    expect(o.grOrdenId).toBe('551');
    expect(o.tipo).toBe('CI');
    expect(o.estado).toBe('PEND');
    expect(o.cliente).toBe('108254');
    expect(o.contrato).toBe('1319');
    expect(o.domicilio).not.toBeNull();
    expect(o.domicilio!.direccion).toBe('CALLE 29 N 1284');
    expect(o.domicilio!.localidad).toBe('Achupallas');
    expect(o.domicilio!.provincia).toBe('Buenos Aires');
    expect(o.fechaCreacion).toBe('01-05-2026 10:00:00');
  });

  it('maps a missing domicilio block to null', () => {
    const orders = parseServiceOrdersResponse({
      '900': { estado: 'PEND', tipo: 'CI', cliente: '1', contrato: '2' },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0].domicilio).toBeNull();
  });

  it('maps empty/null cliente and contrato to null gracefully (IN-type orders)', () => {
    const orders = parseServiceOrdersResponse({
      '901': { estado: 'PEND', tipo: 'IN', cliente: '', contrato: null },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0].cliente).toBeNull();
    expect(orders[0].contrato).toBeNull();
  });

  it('skips a top-level error field and handles an empty/malformed payload', () => {
    expect(parseServiceOrdersResponse({ error: 0 })).toEqual([]);
    expect(parseServiceOrdersResponse({})).toEqual([]);
    expect(parseServiceOrdersResponse(null)).toEqual([]);
  });

  it('preserves the raw order payload for fidelity', () => {
    const orders = parseServiceOrdersResponse(ORDERS_RESPONSE);
    const o = orders.find(x => x.grOrdenId === '551')!;
    expect(o.raw).toMatchObject({ tipo: 'CI', cliente: '108254' });
  });
});
