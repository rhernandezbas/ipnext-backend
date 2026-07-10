import { parseContractsDeltaResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';

const SAMPLE_PAYLOAD = {
  error: 0,
  resultados: '2',
  contratos: [
    {
      id: '900',
      cliente_id: '111',
      nombre: 'IP-Air-30',
      estado: 'Vigente',
      inicio: '01-01-2025',
      domicilio: 'Calle Falsa 123',
      lat: '-34.5',
      lng: '-58.3',
      vendedor: 'JUAN PEREZ',
      modificado: '20-06-2026 10:00:00',
      motivo_baja: 'CAMBIO DE TITULARIDAD',
    },
    {
      id: '901',
      cliente_id: '222',
      nombre: 'IP-Air-50',
      estado: 'Vigente',
      inicio: '01-02-2025',
      domicilio: null,
      lat: null,
      lng: null,
      vendedor: null,
      modificado: '20-06-2026 11:00:00',
      // motivo_baja absent — contrato vigente
    },
  ],
};

describe('parseContractsDeltaResponse — REQ-DELTA-1', () => {
  it('maps total from resultados field', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.total).toBe(2);
  });

  it('stamps grClienteId PER ITEM from cliente_id (not from a parameter)', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0].grClienteId).toBe('111');
    expect(result.contracts[1].grClienteId).toBe('222');
  });

  it('maps id → grContratoId', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0].grContratoId).toBe('900');
    expect(result.contracts[1].grContratoId).toBe('901');
  });

  it('maps nombre → plan', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0].plan).toBe('IP-Air-30');
    expect(result.contracts[1].plan).toBe('IP-Air-50');
  });

  it('maps estado → status', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0].status).toBe('Vigente');
  });

  it('maps modificado field', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0].modificado).toBe('20-06-2026 10:00:00');
    expect(result.contracts[1].modificado).toBe('20-06-2026 11:00:00');
  });

  it('maps lat and lng as numbers when present, null otherwise', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0].lat).toBe(-34.5);
    expect(result.contracts[0].lng).toBe(-58.3);
    expect(result.contracts[1].lat).toBeNull();
    expect(result.contracts[1].lng).toBeNull();
  });

  it('always sets pppoeUsername to null (feed does not carry conexiones)', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0].pppoeUsername).toBeNull();
    expect(result.contracts[1].pppoeUsername).toBeNull();
  });

  it('handles empty contratos array gracefully → total from resultados, empty contracts', () => {
    const result = parseContractsDeltaResponse({ error: 0, resultados: '0', contratos: [] });
    expect(result.total).toBe(0);
    expect(result.contracts).toHaveLength(0);
  });

  it('handles missing/null data gracefully → total 0, empty contracts', () => {
    const result = parseContractsDeltaResponse(null);
    expect(result.total).toBe(0);
    expect(result.contracts).toHaveLength(0);
  });

  // recapture-active-client-match — Decisión 5: GR-owned motivo_baja → Contract.motivoBaja
  it('maps motivo_baja → motivoBaja when present (S14a)', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[0]!.motivoBaja).toBe('CAMBIO DE TITULARIDAD');
  });

  it('maps motivoBaja to null when motivo_baja is absent (contrato vigente)', () => {
    const result = parseContractsDeltaResponse(SAMPLE_PAYLOAD);
    expect(result.contracts[1]!.motivoBaja).toBeNull();
  });
});
