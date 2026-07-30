import { IpPool, IpKind } from '@domain/entities/network';
import { supportedIpKinds, resolveMovePoolType } from '@domain/services/ipKindSupport';

/**
 * pppoe-move-ip-kind-aware (Fase 1) — servicio de dominio PURO.
 *
 * Existe UNA sola función por concepto porque la consumen los DOS caminos: el move
 * (autoridad, decide el pool) y el DTO de NAS (hint para el FE, decide qué ofrecer).
 * Si cada capa lo calculara por su cuenta, el FE ofrecería lo que el BE rechaza.
 *
 * El predicado es IDÉNTICO al del allocator (`FindFreeIp:45` → `p.ipKind === type`):
 * solo `ipKind`, nada más. `IpPool` del dominio no expone `status`.
 */
function pool(id: string, ipKind: IpKind | null): IpPool {
  return {
    id,
    name: `pool-${id}`,
    networkId: `net-${id}`,
    rangeStart: '10.0.0.2',
    rangeEnd: '10.0.0.254',
    type: 'static',
    assignedCount: 0,
    totalCount: 253,
    nasId: 'nas-1',
    ipKind,
  };
}

describe('supportedIpKinds', () => {
  it('NAS con solo pools public soporta solo public (caso real: NE8000 - Mercedes)', () => {
    const pools = [pool('a', 'public'), pool('b', 'public'), pool('c', 'public')];
    expect(supportedIpKinds(pools)).toEqual(['public']);
  });

  it('NAS con solo pools cgnat soporta solo cgnat (caso real: CANEPA)', () => {
    const pools = [pool('a', 'cgnat'), pool('b', 'cgnat')];
    expect(supportedIpKinds(pools)).toEqual(['cgnat']);
  });

  it('NAS con pools de ambas clases soporta las dos (caso real: RDA Agote)', () => {
    const pools = [pool('a', 'cgnat'), pool('b', 'public'), pool('c', 'cgnat')];
    const kinds = supportedIpKinds(pools);
    expect(kinds).toContain('cgnat');
    expect(kinds).toContain('public');
    expect(kinds).toHaveLength(2);
  });

  it('NAS sin pools no soporta ninguna clase (NO asume nada)', () => {
    expect(supportedIpKinds([])).toEqual([]);
  });

  it('pools legacy con ipKind null se ignoran', () => {
    expect(supportedIpKinds([pool('a', null), pool('b', null)])).toEqual([]);
  });

  it('no duplica clases cuando hay varios pools de la misma', () => {
    const kinds = supportedIpKinds([pool('a', 'public'), pool('b', 'public')]);
    expect(kinds).toEqual(['public']);
  });

  it('orden estable (cgnat antes que public) para que el FE no baile', () => {
    expect(supportedIpKinds([pool('a', 'public'), pool('b', 'cgnat')])).toEqual(['cgnat', 'public']);
  });
});

/**
 * ⚠️ SOLO para moves NORMALES. La firma NO recibe el `ipTypePreference` a propósito.
 *
 * La primera versión sí lo recibía y hacía ganar la preferencia cuando el destino soportaba
 * ambas clases. La suite completa lo rechazó con un test que pinea la semántica W1
 * ("move NORMAL sigue asignando cgnat aunque la preferencia persistida sea 'public'"): honrar
 * la preferencia acá cambiaba en silencio el comportamiento de servicios existentes marcados
 * 'public'. El test tenía razón; el spec original estaba mal y se corrigió.
 *
 * La ADOPCIÓN de un pendiente NO usa esta función: ahí la preferencia es un REQUISITO y debe
 * FALLAR si el NAS no la soporta (un pendiente 'public' no puede recibir una CGNAT en silencio).
 */
describe('resolveMovePoolType (solo moves NORMALES)', () => {
  it('el destino soporta cgnat -> cgnat (semantica W1 exacta)', () => {
    expect(resolveMovePoolType(['cgnat'])).toBe('cgnat');
    expect(resolveMovePoolType(['cgnat', 'public'])).toBe('cgnat');
  });

  it('el destino NO soporta cgnat pero si public -> public (CONVERSION, el fix del NE8000)', () => {
    expect(resolveMovePoolType(['public'])).toBe('public');
  });

  it('el destino no soporta ninguna clase -> null (el caller traduce a error tipado)', () => {
    expect(resolveMovePoolType([])).toBeNull();
  });

  it('es pura: no lanza nunca', () => {
    expect(() => resolveMovePoolType([])).not.toThrow();
  });
});
