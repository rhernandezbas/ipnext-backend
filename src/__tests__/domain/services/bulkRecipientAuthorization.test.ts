/**
 * bulk-granular-perms — tests del servicio de dominio puro `forbiddenBulkTargets`.
 * Gate granular por estado de cliente + números crudos: BLOQUEA (no filtra) la
 * campaña si falta permiso para algún estado/tipo presente.
 */
import {
  forbiddenBulkTargets,
  BULK_SUPER_ADMIN_SENTINEL,
  BULK_NUMBERS_ACTION,
} from '@domain/services/bulkRecipientAuthorization';

const ALL_STATUS_ACTIONS = ['bulk_active', 'bulk_late', 'bulk_blocked', 'bulk_inactive', 'bulk_baja'];

describe('forbiddenBulkTargets', () => {
  it('todos permitidos → []', () => {
    const allowed = new Set([...ALL_STATUS_ACTIONS, BULK_NUMBERS_ACTION]);
    const recipients = [
      { clientId: 'c1', status: 'active' },
      { clientId: 'c2', status: 'late' },
      { clientId: 'c3', status: 'blocked' },
      { clientId: 'c4', status: 'inactive' },
      { clientId: 'c5', status: 'baja' },
      { clientId: null, status: 'no_cliente' },
    ];
    expect(forbiddenBulkTargets(allowed, recipients)).toEqual([]);
  });

  it('falta el permiso de un status → ese status en la lista de prohibidos', () => {
    // tiene todos MENOS bulk_blocked
    const allowed = new Set(['bulk_active', 'bulk_late', 'bulk_inactive', 'bulk_baja', BULK_NUMBERS_ACTION]);
    const recipients = [
      { clientId: 'c1', status: 'active' },
      { clientId: 'c2', status: 'blocked' },
    ];
    expect(forbiddenBulkTargets(allowed, recipients)).toEqual(['blocked']);
  });

  it('número crudo (clientId null) sin bulk_numbers → "números"', () => {
    const allowed = new Set(ALL_STATUS_ACTIONS); // sin bulk_numbers
    const recipients = [
      { clientId: 'c1', status: 'active' },
      { clientId: null, status: 'no_cliente' },
    ];
    expect(forbiddenBulkTargets(allowed, recipients)).toEqual(['números']);
  });

  it('super_admin (set con "*") → [] aunque falten permisos de estado/números', () => {
    const allowed = new Set([BULK_SUPER_ADMIN_SENTINEL]);
    const recipients = [
      { clientId: 'c1', status: 'blocked' },
      { clientId: null, status: 'no_cliente' },
      { clientId: 'c2', status: 'estado-que-no-existe' },
    ];
    expect(forbiddenBulkTargets(allowed, recipients)).toEqual([]);
  });

  it('status desconocido (no está en el enum) → bloqueado defensivamente', () => {
    const allowed = new Set([...ALL_STATUS_ACTIONS, BULK_NUMBERS_ACTION]);
    const recipients = [{ clientId: 'c1', status: 'zombie' }];
    expect(forbiddenBulkTargets(allowed, recipients)).toEqual(['zombie']);
  });

  it('lista distinct + ordenada (no repite estados; orden determinístico)', () => {
    const allowed = new Set(['bulk_active']); // solo active
    const recipients = [
      { clientId: 'c1', status: 'blocked' },
      { clientId: 'c2', status: 'blocked' }, // repetido
      { clientId: 'c3', status: 'baja' },
      { clientId: null, status: 'no_cliente' },
      { clientId: 'c4', status: 'active' }, // permitido, no aparece
    ];
    // distinct + sort localeCompare: baja < blocked < números
    expect(forbiddenBulkTargets(allowed, recipients)).toEqual(['baja', 'blocked', 'números']);
  });

  it('set vacío → bloquea TODO lo presente (ningún permiso concedido)', () => {
    const recipients = [
      { clientId: 'c1', status: 'active' },
      { clientId: null, status: 'no_cliente' },
    ];
    expect(forbiddenBulkTargets(new Set(), recipients)).toEqual(['active', 'números']);
  });
});
