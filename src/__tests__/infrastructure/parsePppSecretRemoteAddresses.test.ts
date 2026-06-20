/**
 * parsePppSecretRemoteAddresses — parser PURO de la salida de
 * `/ppp secret print terse without-paging` (RouterOS). Devuelve la lista de
 * `remote-address` NO vacíos, uno por secret. Sin tocar la red.
 *
 * Formato `terse`: una fila por secret, tokens `clave=valor` separados por espacios,
 * con un prefijo de índice y flags (ej. ` 0 X ` / ` 1  `). Los secrets sin
 * `remote-address` (IP dinámica del pool) simplemente no traen ese token.
 *
 * NOTA de import: `RouterOsGateway` importa `@infrastructure/config`, cuyo `validateEnv()`
 * hace `process.exit(1)` al import si faltan las env requeridas. Como no hay jest setup global
 * de env en este repo, sembramos las requeridas ANTES de cargar el módulo (require diferido).
 */
process.env.SPLYNX_API_URL ??= 'http://localhost';
process.env.SPLYNX_API_KEY ??= 'test';
process.env.SPLYNX_API_SECRET ??= 'test';
process.env.JWT_SECRET ??= 'test-secret';
process.env.PORT ??= '3000';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parsePppSecretRemoteAddresses } =
  require('@infrastructure/adapters/routeros/RouterOsGateway') as typeof import('@infrastructure/adapters/routeros/RouterOsGateway');

describe('parsePppSecretRemoteAddresses', () => {
  it('extrae el remote-address de cada secret que lo tiene', () => {
    const out = [
      ' 0   name="cliente1" service=pppoe profile=IP-Air-5M remote-address=100.64.10.2',
      ' 1   name="cliente2" service=pppoe profile=IP-Air-10M remote-address=100.64.10.3',
    ].join('\n');
    expect(parsePppSecretRemoteAddresses(out)).toEqual(['100.64.10.2', '100.64.10.3']);
  });

  it('omite secrets SIN remote-address (IP dinámica del pool)', () => {
    const out = [
      ' 0   name="cliente1" service=pppoe profile=IP-Air-5M remote-address=100.64.10.2',
      ' 1   name="dinamico" service=pppoe profile=POOL', // sin remote-address
      ' 2   name="cliente3" service=pppoe profile=IP-Air-5M remote-address=190.7.247.4',
    ].join('\n');
    expect(parsePppSecretRemoteAddresses(out)).toEqual(['100.64.10.2', '190.7.247.4']);
  });

  it('maneja flags (X = disabled) en el prefijo de la fila', () => {
    const out = ' 0 X name="cortado" service=pppoe profile=IP-REDUCCION remote-address=100.64.10.9';
    expect(parsePppSecretRemoteAddresses(out)).toEqual(['100.64.10.9']);
  });

  it('ignora líneas vacías y remote-address vacío (remote-address="")', () => {
    const out = [
      '',
      ' 0   name="cliente1" service=pppoe remote-address=100.64.10.2',
      ' 1   name="vacio" service=pppoe remote-address=""',
      '   ',
      ' 2   name="vacio2" service=pppoe remote-address=',
    ].join('\n');
    expect(parsePppSecretRemoteAddresses(out)).toEqual(['100.64.10.2']);
  });

  it('devuelve [] para salida vacía', () => {
    expect(parsePppSecretRemoteAddresses('')).toEqual([]);
    expect(parsePppSecretRemoteAddresses('   \n  \n')).toEqual([]);
  });

  it('parsea remote-address cuando NO es el último token de la fila', () => {
    const out =
      ' 0   name="cliente1" remote-address=100.64.10.2 service=pppoe profile=IP-Air-5M last-logged-out=jun/01/2026';
    expect(parsePppSecretRemoteAddresses(out)).toEqual(['100.64.10.2']);
  });
});
