import { redactPii, assertFactsArePiiFree } from '@application/use-cases/assistant/assistantPiiGuard';
import { AssistantPiiLeakError } from '@domain/errors/assistant';

/**
 * ai-assistant-multiagent (SEC-1 / CONV-5) — la barrera de PII.
 *
 * Dos mecanismos independientes, porque protegen de cosas distintas:
 *
 *  1. `redactPii` — sobre el TEXTO del hilo (lo que escribió el cliente). Best-effort: el
 *     texto libre no se puede sanear al 100%, y eso está documentado, no escondido.
 *  2. `assertFactsArePiiFree` — sobre los HECHOS que arman los resolvers. Acá NO es
 *     best-effort: es una barrera dura. Si un resolver futuro mete `name` en el payload,
 *     esto lo caza antes de que salga del proceso.
 */

describe('redactPii — texto libre del hilo (SEC-1 scenario 2, CONV-5)', () => {
  it('redacta un DNI con puntos', () => {
    expect(redactPii('soy Juan, DNI 20.123.456')).not.toContain('20.123.456');
  });

  it('redacta un DNI sin puntos', () => {
    expect(redactPii('mi documento es 20123456')).not.toContain('20123456');
  });

  it('redacta un CUIT/CUIL', () => {
    expect(redactPii('el cuit es 20-20123456-3')).not.toContain('20-20123456-3');
  });

  it('redacta un email', () => {
    const out = redactPii('escribime a juan.perez@gmail.com');

    expect(out).not.toContain('juan.perez@gmail.com');
    expect(out).toContain('[dato removido]');
  });

  it('NO redacta un monto de dinero (es justamente lo que el bot necesita citar)', () => {
    // 45000 tiene 5 dígitos: no matchea el patrón de DNI (7-8) ni el de CUIT.
    expect(redactPii('pagué 45000 ayer')).toContain('45000');
  });

  it('NO redacta una fecha', () => {
    expect(redactPii('vence el 10/08/2026')).toContain('10/08/2026');
  });

  it('preserva el resto del mensaje intacto', () => {
    const out = redactPii('hola, DNI 20123456, quiero saber mi saldo');

    expect(out).toContain('hola');
    expect(out).toContain('quiero saber mi saldo');
  });

  it('maneja texto vacío y null sin romper', () => {
    expect(redactPii('')).toBe('');
    expect(redactPii(null)).toBe('');
    expect(redactPii(undefined)).toBe('');
  });

  it('redacta MÚLTIPLES ocurrencias en el mismo texto', () => {
    const out = redactPii('DNI 20123456 y el de mi esposa 30987654');

    expect(out).not.toContain('20123456');
    expect(out).not.toContain('30987654');
  });
});

describe('assertFactsArePiiFree — barrera dura sobre los hechos (SEC-1)', () => {
  it('deja pasar hechos limpios', () => {
    expect(() =>
      assertFactsArePiiFree({ saldo: 45000, vencimiento: '2026-08-10', estado: 'vencido' }, []),
    ).not.toThrow();
  });

  it('caza una CLAVE prohibida aunque el valor sea inocente', () => {
    // El escenario real: un resolver futuro hace un spread del agregado rico y se lleva `name`.
    expect(() => assertFactsArePiiFree({ saldo: 45000, name: 'x' }, [])).toThrow(
      AssistantPiiLeakError,
    );
  });

  it('caza email, phone, dni, direccion como claves prohibidas', () => {
    for (const key of ['email', 'phone', 'telefono', 'dni', 'documento', 'direccion', 'domicilio']) {
      expect(() => assertFactsArePiiFree({ [key]: 'algo' }, [])).toThrow(AssistantPiiLeakError);
    }
  });

  it('caza claves prohibidas ANIDADAS', () => {
    expect(() => assertFactsArePiiFree({ cliente: { saldo: 1, email: 'a@b.com' } }, [])).toThrow(
      AssistantPiiLeakError,
    );
  });

  it('caza un VALOR que coincide con la identidad real del cliente', () => {
    // Clave inocente, valor comprometido: `titular: "Juan Pérez"`.
    expect(() => assertFactsArePiiFree({ titular: 'Juan Pérez' }, ['Juan Pérez'])).toThrow(
      AssistantPiiLeakError,
    );
  });

  it('el match de valor es case-insensitive y tolera espacios', () => {
    expect(() => assertFactsArePiiFree({ x: '  juan pérez ' }, ['Juan Pérez'])).toThrow(
      AssistantPiiLeakError,
    );
  });

  it('un valor prohibido MUY corto no dispara falsos positivos', () => {
    // Un cliente llamado "Ana" no debe hacer que la palabra "ana" en cualquier texto explote.
    expect(() => assertFactsArePiiFree({ nota: 'plan avanzado' }, ['Ana'])).not.toThrow();
  });

  it('el error NO incluye el valor filtrado (sería filtrarlo en el log)', () => {
    try {
      assertFactsArePiiFree({ email: 'juan@gmail.com' }, []);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(AssistantPiiLeakError);
      expect((err as Error).message).not.toContain('juan@gmail.com');
      expect((err as Error).message).toContain('email');
    }
  });
});
