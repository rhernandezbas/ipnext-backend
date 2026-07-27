import {
  buildNumberWhitelist,
  findUnbackedNumbers,
} from '@application/use-cases/assistant/assistantNumberVerifier';

/**
 * ai-assistant-multiagent (SEC-4, design D3) — el verificador de números.
 *
 * Es la red que convierte una alucinación de plata en un handoff. Puramente sintáctico y sin
 * modelo: se construye un whitelist de cifras respaldadas y se rechaza toda secuencia de 3+
 * dígitos de la salida que no esté ahí.
 *
 * La regla más sutil —y la más importante— está en el bloque "asimetría": los números que
 * escribió EL CLIENTE entran al whitelist; los que dijo EL BOT en turnos anteriores, NO.
 */

const empty = { facts: {}, profileTexts: [], customerMessages: [] };

describe('buildNumberWhitelist', () => {
  it('toma los números de los hechos inyectados', () => {
    const wl = buildNumberWhitelist({ ...empty, facts: { saldo: 45000 } });

    expect(wl.has('45000')).toBe(true);
  });

  it('toma números anidados en los hechos', () => {
    const wl = buildNumberWhitelist({
      ...empty,
      facts: { 'cliente.saldo': { saldo: 45000, vencimiento: '2026-08-10' } },
    });

    expect(wl.has('45000')).toBe(true);
    expect(wl.has('2026')).toBe(true);
  });

  it('toma los números de los textos del perfil (24 horas, teléfono de la empresa)', () => {
    const wl = buildNumberWhitelist({
      ...empty,
      profileTexts: ['Atendemos de 8 a 18. Urgencias: 0800-333-1234'],
    });

    expect(wl.has('0800')).toBe(true);
    expect(wl.has('1234')).toBe(true);
  });

  it('toma los números que escribió EL CLIENTE', () => {
    const wl = buildNumberWhitelist({ ...empty, customerMessages: ['pagué 45000 ayer'] });

    expect(wl.has('45000')).toBe(true);
  });

  it('normaliza separadores de miles: 45.000 y 45,000 valen igual que 45000', () => {
    const wl = buildNumberWhitelist({ ...empty, facts: { saldo: 45000 } });

    expect(findUnbackedNumbers('son $45.000', wl)).toEqual([]);
    expect(findUnbackedNumbers('son $45,000', wl)).toEqual([]);
  });
});

describe('findUnbackedNumbers', () => {
  const wl = buildNumberWhitelist({
    facts: { saldo: 45000, vencimiento: '2026-08-10' },
    profileTexts: [],
    customerMessages: [],
  });

  it('acepta una cifra respaldada por los hechos', () => {
    expect(findUnbackedNumbers('Tu saldo es $45000', wl)).toEqual([]);
  });

  it('CAZA una cifra inventada', () => {
    // El caso canónico: se inyecta 45000, el modelo escribe 54000.
    expect(findUnbackedNumbers('Tu saldo es $54000', wl)).toEqual(['54000']);
  });

  it('ignora números de 1-2 dígitos (ruido: "2 días", "el 5 de")', () => {
    expect(findUnbackedNumbers('te contesto en 2 días, el 5 de agosto', wl)).toEqual([]);
  });

  it('acepta el año que vino en la fecha de los hechos', () => {
    expect(findUnbackedNumbers('vence el 10 de agosto de 2026', wl)).toEqual([]);
  });

  it('reporta TODAS las cifras sin respaldo, no sólo la primera', () => {
    expect(findUnbackedNumbers('debés 54000 y 99999', wl).sort()).toEqual(['54000', '99999']);
  });

  it('no duplica la misma cifra repetida', () => {
    expect(findUnbackedNumbers('54000 ... y repito: 54000', wl)).toEqual(['54000']);
  });

  it('texto sin números pasa limpio', () => {
    expect(findUnbackedNumbers('Hola, ¿en qué te puedo ayudar?', wl)).toEqual([]);
  });
});

// ── LA ASIMETRÍA ────────────────────────────────────────────────────────────
describe('asimetría cliente/bot — impide el lavado de una alucinación', () => {
  it('el bot PUEDE citar un número que escribió el cliente', () => {
    const wl = buildNumberWhitelist({
      ...empty,
      customerMessages: ['ya pagué 45000 la semana pasada'],
    });

    expect(findUnbackedNumbers('Veo que mencionás 45000, lo verifico', wl)).toEqual([]);
  });

  it('el bot NO puede reusar un número que dijo ÉL MISMO en un turno anterior', () => {
    // Éste es el corazón del asunto: si el bot alucinó 54000 en el turno 2, ese texto queda
    // en el hilo. Si el whitelist tomara los mensajes del bot, en el turno 5 lo encontraría
    // "en el historial" y lo aprobaría: el error se LAVA y pasa a ser verdad por repetición,
    // con el sello del propio verificador. Por eso `buildNumberWhitelist` sólo recibe
    // `customerMessages` — los del bot ni siquiera se le pasan.
    const wl = buildNumberWhitelist({
      facts: { saldo: 45000 },
      profileTexts: [],
      customerMessages: [], // el turno donde el bot dijo 54000 NO entra acá
    });

    expect(findUnbackedNumbers('Como te dije antes, son 54000', wl)).toEqual(['54000']);
  });

  it('cada turno se valida contra los hechos FRESCOS, no contra lo dicho antes', () => {
    // El saldo cambió entre turnos: repetir el viejo ahora está mal, y se caza.
    const wl = buildNumberWhitelist({ ...empty, facts: { saldo: 51000 } });

    expect(findUnbackedNumbers('tu saldo sigue siendo 45000', wl)).toEqual(['45000']);
  });
});

// ── MODO CONVERSAR (CONV-3) ─────────────────────────────────────────────────
describe('modo CONVERSAR: whitelist vacío ⇒ ninguna cifra es válida', () => {
  it('cualquier cifra inventada en charla se caza, sin razonar cuál sería válida', () => {
    const wl = buildNumberWhitelist(empty); // sin hechos: es charla

    expect(findUnbackedNumbers('tu saldo es $45.000', wl)).toEqual(['45000']);
  });

  it('una charla sin cifras pasa perfecto', () => {
    const wl = buildNumberWhitelist(empty);

    expect(findUnbackedNumbers('¡Hola! Contame en qué te ayudo.', wl)).toEqual([]);
  });
});

// ── Limitación documentada ──────────────────────────────────────────────────
describe('limitación conocida: números escritos en letras', () => {
  it('caza el marcador de magnitud en letras sin dígito acompañante', () => {
    const wl = buildNumberWhitelist(empty);

    expect(findUnbackedNumbers('debés cuarenta y cinco mil pesos', wl)).toContain('mil');
  });

  it('NO se queja cuando la magnitud en letras acompaña una cifra respaldada', () => {
    const wl = buildNumberWhitelist({ ...empty, facts: { saldo: 45000 } });

    expect(findUnbackedNumbers('son 45000 (cuarenta y cinco mil)', wl)).toEqual([]);
  });
});
