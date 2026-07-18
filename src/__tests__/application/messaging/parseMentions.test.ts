/**
 * note-mentions (Ola 6b) — parseMentions: extrae los userIds mencionados de una nota
 * interna. El FE inserta cada mención con el token markdown-style `@[Display Name](userId)`
 * (nombre libre entre corchetes, userId entre paréntesis). Elegido por ser INAMBIGUO frente
 * a texto libre: un `@juan` suelto o un email `juan@empresa.com` NUNCA matchean; sólo el
 * token completo `@[...](...)`. Devuelve userIds ÚNICOS en orden de primera aparición.
 */
import { parseMentions } from '@application/use-cases/messaging/parseMentions';

describe('parseMentions — token @[nombre](userId)', () => {
  it('extrae un único userId de una mención bien formada', () => {
    expect(parseMentions('hola @[Juan](user-1) cómo va')).toEqual(['user-1']);
  });

  it('extrae múltiples menciones en orden', () => {
    expect(parseMentions('@[Juan](user-1) y también @[Ana](user-2), avisen')).toEqual([
      'user-1',
      'user-2',
    ]);
  });

  it('un "@" que NO es token (mención suelta / email) se ignora', () => {
    expect(parseMentions('mandale un mail a juan@empresa.com y avisá a @juan')).toEqual([]);
  });

  it('paréntesis de texto libre sin el prefijo @[...] no se confunden con una mención', () => {
    expect(parseMentions('el precio (100) subió, avisá a @[Ana](user-2)')).toEqual(['user-2']);
  });

  it('deduplica por userId, conservando el orden de primera aparición', () => {
    expect(parseMentions('@[Juan](user-1) ... y de nuevo @[Juan Pérez](user-1)')).toEqual([
      'user-1',
    ]);
  });

  it('ignora un token con userId vacío', () => {
    expect(parseMentions('nota rara @[X]() sin id')).toEqual([]);
  });

  it('trimea el userId capturado', () => {
    expect(parseMentions('@[X]( user-9 )')).toEqual(['user-9']);
  });

  it('string sin menciones → []', () => {
    expect(parseMentions('una nota interna cualquiera sin nadie mencionado')).toEqual([]);
  });

  it('string vacío → []', () => {
    expect(parseMentions('')).toEqual([]);
  });
});
