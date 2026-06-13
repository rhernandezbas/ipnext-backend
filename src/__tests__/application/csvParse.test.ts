/**
 * Unit tests for the pure CSV parser utility.
 */
import { parseCsv } from '../../application/use-cases/recapture/csvParse';

describe('parseCsv', () => {
  it('parses a simple CSV with headers', () => {
    const input = 'nombre,telefono,email\nAlice,111,a@test.com\nBob,222,b@test.com';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ nombre: 'Alice', telefono: '111', email: 'a@test.com' });
    expect(rows[1]).toEqual({ nombre: 'Bob', telefono: '222', email: 'b@test.com' });
  });

  it('handles quoted fields containing commas', () => {
    const input = 'nombre,direccion\nAlice,"Av. del Libertador, 1234"';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direccion).toBe('Av. del Libertador, 1234');
  });

  it('handles quoted fields containing newlines', () => {
    const input = 'nombre,nota\nAlice,"linea 1\nlinea 2"';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nota).toBe('linea 1\nlinea 2');
  });

  it('handles empty fields', () => {
    const input = 'nombre,telefono,email\nAlice,,';
    const rows = parseCsv(input);
    expect(rows[0]).toEqual({ nombre: 'Alice', telefono: '', email: '' });
  });

  it('ignores trailing newline — does not produce empty row', () => {
    const input = 'nombre,telefono\nAlice,111\n';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(1);
  });

  it('returns empty array for header-only input', () => {
    const input = 'nombre,telefono,email\n';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(0);
  });

  it('returns empty array for completely empty string', () => {
    const rows = parseCsv('');
    expect(rows).toHaveLength(0);
  });

  it('handles Windows-style CRLF line endings', () => {
    const input = 'nombre,telefono\r\nAlice,111\r\nBob,222\r\n';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.nombre).toBe('Alice');
  });

  it('strips surrounding whitespace from unquoted fields', () => {
    const input = 'nombre , telefono\n Alice , 111 ';
    const rows = parseCsv(input);
    expect(rows[0]!.nombre).toBe('Alice');
    expect(rows[0]!.telefono).toBe('111');
  });
});
