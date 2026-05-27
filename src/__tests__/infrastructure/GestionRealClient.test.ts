import { parseClientsResponse, parseContractsResponse, isoDate } from '@infrastructure/adapters/gestion-real/GestionRealClient';

// Real shapes captured from api.gestionreal.com.ar on 2026-05-27.
const CLIENTS_RESPONSE = {
  error: 0,
  status: 'OK',
  offset: 0,
  cantidad: 2,
  resultados: '5090',
  clientes: {
    '100011': {
      tipo_documento: { codigo: '96', valor: 'DNI' },
      documento: '17883799',
      nombre: 'GONZALEZ ARACELI',
      domicilio: {
        direccion: 'CUARTEL 8 VO',
        provincia: { codigo: 'BA', valor: 'Buenos Aires' },
        localidad: { codigo: '19', valor: 'Achupallas' },
        barrio: { codigo: '0', valor: false },
      },
      mail: 'achupallas_2012@hotmail.com',
      estado: { codigo: '1', valor: 'Activo' },
      ultima_modificacion: '15-04-2026 13:12:21',
      telefonos: { Telefono: '23464114762346540252' },
    },
  },
};

const CONTRACTS_RESPONSE = {
  error: '0',
  contratos: [
    {
      id: '97',
      nombre: '50MB FO',
      inicio: '01-05-2023',
      estado: 'Vigente',
      domicilio: 'CALLE 29 N?1284',
      conexiones: {
        '0': { tipo: 'pppoe', username: 'RaulAranMercFibra', conectado: 'SI' },
        cantidad_conexiones: 1,
      },
      modificado: '27-04-2026 11:01:27',
    },
  ],
};

describe('GestionRealClient parsing', () => {
  it('parses the keyed clients object into a flat list with the total', () => {
    const { total, clients } = parseClientsResponse(CLIENTS_RESPONSE);
    expect(total).toBe(5090);
    expect(clients).toHaveLength(1);
    const c = clients[0];
    expect(c.grClienteId).toBe('100011');
    expect(c.name).toBe('GONZALEZ ARACELI');
    expect(c.email).toBe('achupallas_2012@hotmail.com');
    expect(c.statusCode).toBe('1');
    expect(c.status).toBe('Activo');
    expect(c.city).toBe('Achupallas');
    expect(c.province).toBe('Buenos Aires');
    expect(c.address).toBe('CUARTEL 8 VO');
    expect(c.ultimaModificacion).toBe('15-04-2026 13:12:21');
    expect(c.phone).toBe('23464114762346540252');
  });

  it('handles an empty/malformed response without throwing', () => {
    expect(parseClientsResponse({}).clients).toEqual([]);
    expect(parseClientsResponse(null).total).toBe(0);
  });

  it('parses the contracts array and extracts the pppoe username', () => {
    const contracts = parseContractsResponse(CONTRACTS_RESPONSE, '100012');
    expect(contracts).toHaveLength(1);
    const k = contracts[0];
    expect(k.grContratoId).toBe('97');
    expect(k.grClienteId).toBe('100012');
    expect(k.plan).toBe('50MB FO');
    expect(k.status).toBe('Vigente');
    expect(k.startDate).toBe('01-05-2023');
    expect(k.pppoeUsername).toBe('RaulAranMercFibra');
    expect(k.modificado).toBe('27-04-2026 11:01:27');
  });

  it('builds the daily password date in YYYY-MM-DD', () => {
    expect(isoDate(new Date(2026, 4, 27))).toBe('2026-05-27');
    expect(isoDate(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
});
