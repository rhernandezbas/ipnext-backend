import {
  parseClientsResponse,
  parseContractsResponse,
  parseServiceOrdersResponse,
  isoDate,
} from '@infrastructure/adapters/gestion-real/GestionRealClient';

// Contract fixture with lat/lng populated.
const CONTRACTS_RESPONSE_WITH_LOCATION = {
  error: '0',
  contratos: [
    {
      id: '42',
      nombre: 'Plan 100MB',
      inicio: '01-01-2024',
      estado: 'Vigente',
      domicilio: 'CALLE 29 N?1284',
      lat: '-35.040958',
      lng: '-59.910656',
      conexiones: {},
      modificado: '27-05-2026 10:00:00',
    },
  ],
};

// Contract fixture with empty lat/lng strings and empty domicilio.
const CONTRACTS_RESPONSE_EMPTY_LOCATION = {
  error: '0',
  contratos: [
    {
      id: '43',
      nombre: 'Plan 50MB',
      inicio: '01-03-2024',
      estado: 'Vigente',
      domicilio: '',
      lat: '',
      lng: '',
      conexiones: {},
      modificado: '27-05-2026 11:00:00',
    },
  ],
};

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
      // GR uses fecha_creacion here (NOT `creado` like in ordenesdeservicio);
      // legacy rows carry the "00-00-0000 00:00:00" placeholder.
      fecha_creacion: '23-10-2014 00:00:00',
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
      vendedor: 'CAROLINA ROSALES',
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
    expect(c.fechaCreacion).toBe('23-10-2014 00:00:00');
    expect(c.phone).toBe('23464114762346540252');
  });

  // Phone parsing: GR keys `telefonos` by phone TYPE and the key varies.
  // These cases mirror real shapes measured over 100 active clients (~5% lost).
  const clientWithPhone = (telefonos: unknown) => ({
    error: 0,
    resultados: '1',
    clientes: {
      '100011': {
        nombre: 'TEST',
        estado: { codigo: '1', valor: 'Activo' },
        telefonos,
      },
    },
  });

  const phoneOf = (telefonos: unknown): string | null =>
    parseClientsResponse(clientWithPhone(telefonos)).clients[0].phone;

  it('uses telefonos.Telefono when present (preserves the 95% case)', () => {
    expect(phoneOf({ Telefono: '111' })).toBe('111');
  });

  it('falls back to the first non-empty value when key is "Movil"', () => {
    expect(phoneOf({ Movil: '02324-15543200' })).toBe('02324-15543200');
  });

  it('falls back when the key is empty string', () => {
    expect(phoneOf({ '': '2324645421' })).toBe('2324645421');
  });

  it('falls back when the key is a number (dirty data)', () => {
    expect(phoneOf({ '01131667428': '02324-423380/02324-156917' })).toBe(
      '02324-423380/02324-156917',
    );
  });

  it('prioritizes Telefono over other keys', () => {
    expect(phoneOf({ Telefono: '111', Movil: '222' })).toBe('111');
  });

  it('falls back to another key when Telefono is empty', () => {
    expect(phoneOf({ Telefono: '', Movil: '222' })).toBe('222');
  });

  it('returns null when all phone values are empty', () => {
    expect(phoneOf({ '': '' })).toBeNull();
  });

  it('returns null when telefonos is absent', () => {
    expect(phoneOf(undefined)).toBeNull();
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
    expect(k.vendedor).toBe('CAROLINA ROSALES');
  });

  it('captures lat/lng as numbers when GR provides non-empty strings', () => {
    const contracts = parseContractsResponse(CONTRACTS_RESPONSE_WITH_LOCATION, '200');
    expect(contracts).toHaveLength(1);
    const k = contracts[0];
    expect(k.address).toBe('CALLE 29 N?1284');
    expect(k.lat).toBeCloseTo(-35.040958);
    expect(k.lng).toBeCloseTo(-59.910656);
  });

  it('returns null for lat/lng when GR provides empty strings, and null for empty domicilio', () => {
    const contracts = parseContractsResponse(CONTRACTS_RESPONSE_EMPTY_LOCATION, '201');
    expect(contracts).toHaveLength(1);
    const k = contracts[0];
    expect(k.address).toBeNull();
    expect(k.lat).toBeNull();
    expect(k.lng).toBeNull();
  });

  // Service order `observaciones` → the OS comment (backlog #16). Real shapes
  // captured from api.gestionreal.com.ar on 2026-06-03: GR keys orders by id and
  // the comment field is `observaciones`, arriving with UNDECODED HTML entities
  // (e.g. instalaci&oacute;n) — we decode them so the task description reads clean.
  it('maps observaciones and decodes HTML entities (#16)', () => {
    const response = {
      error: '0',
      '17641': {
        tipo: 'CI',
        estado: 'CONF',
        cliente: '205122',
        contrato: '12020',
        observaciones:
          'Orden de servicio por instalaci&oacute;n de cliente generada autom&aacute;ticamente',
        creado: '27-05-2026 10:59:47',
      },
    };

    const orders = parseServiceOrdersResponse(response);

    expect(orders).toHaveLength(1);
    const o = orders[0];
    expect(o.grOrdenId).toBe('17641');
    expect(o.observaciones).toBe(
      'Orden de servicio por instalación de cliente generada automáticamente',
    );
  });

  it('decodes numeric HTML entities and preserves line breaks in observaciones (#16)', () => {
    const response = {
      error: '0',
      '17635': {
        tipo: 'CO',
        estado: 'CONF',
        observaciones: 'Señal ca&iacute;da&#46;\nLLevar equipo&#46;',
      },
    };

    const orders = parseServiceOrdersResponse(response);

    expect(orders[0].observaciones).toBe('Señal caída.\nLLevar equipo.');
  });

  it('returns null observaciones when GR omits or empties the field (#16)', () => {
    const response = {
      error: '0',
      '1': { tipo: 'CI', estado: 'CONF' },
      '2': { tipo: 'CI', estado: 'CONF', observaciones: '   ' },
    };

    const orders = parseServiceOrdersResponse(response);

    expect(orders.find(o => o.grOrdenId === '1')!.observaciones).toBeNull();
    expect(orders.find(o => o.grOrdenId === '2')!.observaciones).toBeNull();
  });

  it('builds the daily GR password date in Argentina time (UTC-3), not the container UTC date', () => {
    // Madrugada UTC: el dia UTC ya avanzo respecto a Argentina. GR valida el
    // password en hora argentina, asi que debe dar el dia argentino (el anterior).
    expect(isoDate(new Date('2026-06-01T01:00:00Z'))).toBe('2026-05-31');
    // Horario diurno: UTC y Argentina caen en el mismo dia.
    expect(isoDate(new Date('2026-05-27T12:00:00Z'))).toBe('2026-05-27');
    expect(isoDate(new Date('2026-01-03T15:00:00Z'))).toBe('2026-01-03');
  });
});
