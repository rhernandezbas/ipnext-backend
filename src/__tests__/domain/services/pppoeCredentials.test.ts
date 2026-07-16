/**
 * install-pppoe-pregen (K1) — generador PURO y DETERMINÍSTICO de credenciales PPPoE.
 *
 * Spec (decisión final del usuario):
 *  - username = nombre + apellido + númeroDeContrato, todo minúscula, sin espacios,
 *    sin acentos/diacríticos (ñ→n), solo [a-z0-9]. Único por construcción (el
 *    contrato es único) — sin contadores de colisión.
 *  - Split del `Client.name` GR "APELLIDO(S) NOMBRE(S)": apellido = PRIMER token,
 *    nombre = ÚLTIMO token (heurística determinística).
 *  - password = nombre + "1234" LITERAL (fijo, para dictar por teléfono).
 *  - 100% determinístico: mismo input → mismas credenciales (re-ingest idempotente).
 */
import { generatePppoeCredentials } from '@domain/services/pppoeCredentials';

describe('generatePppoeCredentials', () => {
  it('caso canónico "APELLIDO NOMBRE": username = nombre+apellido+contrato, password = nombre+1234', () => {
    const creds = generatePppoeCredentials('HERNANDEZ RONALD', '45123');
    expect(creds.username).toBe('ronaldhernandez45123');
    expect(creds.password).toBe('ronald1234');
  });

  it('multi-token "APELLIDOS NOMBRES": apellido = PRIMER token, nombre = ÚLTIMO token', () => {
    const creds = generatePppoeCredentials('HERNANDEZ BASTIDAS RONALD JOSE', '777');
    expect(creds.username).toBe('josehernandez777');
    expect(creds.password).toBe('jose1234');
  });

  it('normaliza acentos y ñ (NUÑEZ MARÍA → marianunez)', () => {
    const creds = generatePppoeCredentials('NUÑEZ MARÍA', '12064');
    expect(creds.username).toBe('marianunez12064');
    expect(creds.password).toBe('maria1234');
  });

  it('descarta todo lo que no sea [a-z0-9] (apóstrofes, guiones)', () => {
    const creds = generatePppoeCredentials("O'BRIEN JUAN-CARLOS", '88');
    expect(creds.username).toBe('juancarlosobrien88');
    expect(creds.password).toBe('juancarlos1234');
  });

  it('tolera whitespace extra en el nombre y en el contrato', () => {
    const creds = generatePppoeCredentials('  PEREZ   ANA ', ' 45123 ');
    expect(creds.username).toBe('anaperez45123');
    expect(creds.password).toBe('ana1234');
  });

  it('nombre de UN solo token (razón social) → se usa una sola vez en el username', () => {
    const creds = generatePppoeCredentials('ACME', '99');
    expect(creds.username).toBe('acme99');
    expect(creds.password).toBe('acme1234');
  });

  it('es determinístico: dos invocaciones idénticas → credenciales idénticas', () => {
    const a = generatePppoeCredentials('HERNANDEZ RONALD', '45123');
    const b = generatePppoeCredentials('HERNANDEZ RONALD', '45123');
    expect(a).toEqual(b);
  });

  it('degenerado defensivo: nombre vacío → username = contrato, password = "1234"', () => {
    const creds = generatePppoeCredentials('', '45123');
    expect(creds.username).toBe('45123');
    expect(creds.password).toBe('1234');
  });
});
