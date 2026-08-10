/**
 * customer-balance-unmask (Fase 2, tarea 2.5) — spec `balance-staleness-helper`,
 * requirement "one staleness criterion for every caller" (S13).
 *
 * Los TRES call sites (`toCustomer`, `GetInboxClientContext.buildClientSummary`,
 * `RefreshClientBalanceIfStale`'s internal gate) deben coincidir en el MISMO
 * veredicto para el MISMO `lastBalanceAt`/`ttlMinutes` — antes de este change el
 * mapper computaba `balanceStale` con su propio criterio status-gated
 * (`isBalanceStale`, retirado en la Fase 2) y podía discrepar del inbox, que ya
 * usaba `isBalanceOlderThanTtl`. Este test ejercita los TRES caminos PÚBLICOS
 * (no llama al helper puro tres veces — sería tautológico) para probar que
 * ninguno reintrodujo un cálculo de edad propio.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * fix wave F7 + F8 — **el pin ahora es "mismo TTL para el MISMO carril".**
 *
 * F8 (mutante M5, sobrevivía 67/67): el archivo corría SÓLO con `ttl=60`, que es
 * también el default hardcodeado. Un mapper que ignorara el `balanceTtlMinutes`
 * inyectado y usara 60 fijo pasaba entero. Ahora el TTL configurado es **120**:
 * el que hardcodee 60 muere.
 *
 * F7: el TTL dejó de ser único. Había uno solo (60min) para una base que se
 * refresca en DOS cadencias — el carril rápido cada hora, el lento (las 9.082
 * bajas) una vez por día. Resultado: `balanceStale:true` PERMANENTE para el 62%
 * de los clientes, un flag que grita todo el tiempo y por lo tanto no dice nada.
 * Ahora el TTL sale del carril del status, y este test cruza **las dos
 * cadencias** (la lección de R2: los tests de staleness nunca cruzaban la
 * cadencia real, así que la deriva era invisible).
 */
import { toCustomer } from '@infrastructure/adapters/prisma/PrismaCustomerRepository';
import { mapStatus } from '@infrastructure/adapters/prisma/PrismaClientMirrorRepository';
import { GetInboxClientContext } from '@application/use-cases/messaging/GetInboxClientContext';
import { GetClientContextByPhone } from '@application/use-cases/messaging/GetClientContextByPhone';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { ListTickets } from '@application/use-cases/ListTickets';
import { ListTasks } from '@application/use-cases/ListTasks';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import {
  RefreshClientBalanceIfStale,
  SLOW_LANE_BALANCE_TTL_MINUTES,
  balanceTtlMinutesForStatus,
} from '@application/use-cases/RefreshClientBalanceIfStale';
import { FAST_LANE, SLOW_LANE } from '@application/use-cases/RefreshDebtorBalances';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { parseClientBalanceResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { CustomerStatus } from '@domain/entities/customer';
import type { GrClientBalance } from '@domain/entities/gestionReal';
import { customerFrom, grBalancePayload } from '../helpers/customerFixture';

const NOW = () => new Date('2026-08-10T12:00:00.000Z');

/**
 * ⚠️ **120, NO 60.** El default hardcodeado del helper es 60; probar con 60 no
 * distingue "lee el TTL inyectado" de "ignora el parámetro". Éste es el pin de
 * F8, y es el mismo patrón que `GetInboxClientContext.test.ts` ya usaba (#1b).
 */
const TTL_MINUTES = 120;

/**
 * fix wave 3 (FW3) — el TTL **efectivo** del carril rápido vuelve a ser el
 * configurado, sin sumas. La FW2 le había agregado un margen de batch de 60min;
 * lo revirtió la FW3 porque este TTL no es sólo el flag de display, es también
 * el gate del refresh on-demand — y ese refresh consulta GR EN VIVO, así que sí
 * puede mejorar el dato del batch (ver el revert-probe en
 * `ClienteSaldoResolver.test.ts`, "FW3 — el cliente pagó hace 30min").
 *
 * El pin de F7/F8 no cambia: "mismo TTL para el MISMO carril", los tres call
 * sites moviéndose JUNTOS.
 */
const FAST_TTL_EFECTIVO = TTL_MINUTES;

const MIN = 60 * 1000;

function makeCustomerRepo(overrides?: Partial<CustomerRepository>): CustomerRepository {
  return {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn().mockResolvedValue([]),
    listInvoices: jest.fn().mockResolvedValue([]),
    listLogs: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 5 }),
    updateLocation: jest.fn(),
    listActiveContacts: jest.fn().mockResolvedValue([]),
    getPortalBalanceSummary: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

async function inboxStale(lastBalanceAt: string | null, status: CustomerStatus): Promise<boolean> {
  const customer = customerFrom({
    id: 'c1',
    status,
    grClienteId: 'gr-1',
    lastBalanceAt: lastBalanceAt ? new Date(lastBalanceAt) : null,
  }, { ttlMinutes: TTL_MINUTES, now: NOW });
  const customerRepo = makeCustomerRepo({
    listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
    findById: jest.fn().mockResolvedValue(customer),
  });
  const conversationRepo = new InMemoryConversationRepository();
  const ticketRepo = new InMemoryTicketRepository();
  const schedulingRepo = new InMemorySchedulingRepository();
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const uc = new GetInboxClientContext(
    conversationRepo,
    new GetClientContextByPhone(customerRepo),
    customerRepo,
    new GetClientContracts(customerRepo),
    new GetClientInvoices(customerRepo),
    new GetClientLogs(customerRepo),
    new ListTickets(ticketRepo),
    ticketRepo,
    new ListTasks(schedulingRepo),
    new ListPppoeByContract(pppoeRepo),
    undefined,
    { now: NOW, ttlMinutes: TTL_MINUTES },
  );
  const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 900, contactPhone: '+5492324421234' });

  const result = await uc.execute(conv.id);
  return result.status === 'matched' ? result.client!.balance.stale : true;
}

async function refreshJudgedStale(lastBalanceAt: string | null, status: CustomerStatus): Promise<boolean> {
  const gr = new InMemoryGestionRealPort();
  const mirror = new InMemoryClientMirrorRepository();
  // fix wave (F1) — el balance nace de un payload GR pasado por el parser real,
  // no de un `GrClientBalance` escrito a mano: la moneda la SINTETIZA el parser
  // (`amount > 0 ? 'ARS' : null`) y un literal a mano puede codificar un par
  // que la escritura real nunca produce (así vivió el CRITICAL de F1).
  const balance: GrClientBalance = parseClientBalanceResponse('gr-1', grBalancePayload('1000.00', { grClienteId: 'gr-1' }));
  gr.balancesByClient['gr-1'] = balance;
  const refresh = new RefreshClientBalanceIfStale(gr, mirror, { now: NOW, ttlMinutes: TTL_MINUTES });

  await refresh.execute({ grClienteId: 'gr-1', lastBalanceAt, status });
  // Si RefreshClientBalanceIfStale juzgó "fresco", NUNCA llama a GR (short-circuit interno).
  return gr.balanceCalls.includes('gr-1');
}

function mapperStale(lastBalanceAt: string | null, status: CustomerStatus): boolean {
  const c = customerFrom({
    status,
    grClienteId: 'gr-1',
    lastBalanceAt: lastBalanceAt ? new Date(lastBalanceAt) : null,
  }, { ttlMinutes: TTL_MINUTES, now: NOW });
  return c.balanceStale!;
}

/** Los tres call sites, para el mismo input. El pin es que coincidan. */
async function losTres(lastBalanceAt: string | null, status: CustomerStatus): Promise<boolean[]> {
  return [
    mapperStale(lastBalanceAt, status),
    await inboxStale(lastBalanceAt, status),
    await refreshJudgedStale(lastBalanceAt, status),
  ];
}

const hace = (ms: number) => new Date(NOW().getTime() - ms).toISOString();

describe.each([
  { carril: 'RÁPIDO', status: 'active' as CustomerStatus, ttl: FAST_TTL_EFECTIVO },
  { carril: 'LENTO (bajas)', status: 'baja' as CustomerStatus, ttl: SLOW_LANE_BALANCE_TTL_MINUTES },
])('balanceStale — un solo criterio en los tres call sites, carril $carril (S13 + F7/F8)', ({ status, ttl }) => {
  it('dentro del TTL del carril: los tres coinciden en "no stale"', async () => {
    const dentro = hace((ttl - 10) * MIN);
    expect(await losTres(dentro, status)).toEqual([false, false, false]);
  });

  it('pasado el TTL del carril: los tres coinciden en "stale"', async () => {
    const pasado = hace((ttl + 30) * MIN);
    expect(await losTres(pasado, status)).toEqual([true, true, true]);
  });

  it('lastBalanceAt null (nunca fetcheado): los tres coinciden en "stale"', async () => {
    expect(await losTres(null, status)).toEqual([true, true, true]);
  });
});

/**
 * ⚠️ **El test que cruza las DOS cadencias.** Un balance de 3 horas es el mismo
 * dato en los dos casos; lo que cambia es cada cuánto se refresca ese cliente.
 * Para un `active` (carril rápido, cada hora) 3h es viejo. Para una `baja`
 * (carril lento, 1×/día) 3h es lo más fresco que ese dato va a estar nunca —
 * marcarlo stale era gritar por 9.082 clientes, todo el tiempo, sin que nadie
 * pudiera hacer nada al respecto.
 *
 * Con TTL único, ESTE test es imposible de escribir: las dos filas darían lo
 * mismo. Por eso M5 sobrevivía.
 */
describe('F7 — el MISMO lastBalanceAt da veredictos distintos según el carril', () => {
  // 5h — pasado el efectivo del rápido (120min) y muy dentro del lento. La FW2 la
  // había movido de 3h a 5h para saltear su margen; el margen murió en la FW3
  // pero la fixture se queda: discrimina igual, con más aire de los dos lados.
  const cincoHoras = hace(5 * 60 * MIN);

  it('5h en el carril rápido (TTL 120min) ⇒ stale en los tres', async () => {
    expect(await losTres(cincoHoras, 'active')).toEqual([true, true, true]);
  });

  it('5h en el carril lento (TTL 26h) ⇒ NO stale en los tres', async () => {
    expect(await losTres(cincoHoras, 'baja')).toEqual([false, false, false]);
  });

  it('30h ⇒ stale incluso en el carril lento (el margen sobre la cadencia diaria es 26h, no infinito)', async () => {
    expect(await losTres(hace(30 * 60 * MIN), 'baja')).toEqual([true, true, true]);
  });
});

/**
 * ⚠️ **FW3 — el carril RÁPIDO usa el TTL configurado, SIN margen de batch.**
 *
 * La fix wave 2 le había sumado un `FAST_LANE_BATCH_MARGIN_MINUTES` de 60min
 * (efectivo 2h con el default) razonando así: el sello `lastBalanceAt` se pone
 * cuando el batch TOCA a cada cliente y el pase tarda ~43min medidos, así que
 * buena parte de cada hora el flag dice "viejo" sobre el dato más fresco que el
 * batch puede producir — "y los refrescos on-demand que eso dispara no pueden
 * mejorar nada".
 *
 * **Esa última premisa era falsa**, y ahí estaba todo el daño: este TTL no es
 * sólo el flag de display, es TAMBIÉN el gate del refresh on-demand
 * (`RefreshClientBalanceIfStale.isStale`), y ese refresh no re-lee el batch —
 * consulta `gr.fetchClientBalance` EN VIVO. Medido con el margen puesto: cliente
 * activo con $45.000 sellados hace 90min que pagó hace 30 ⇒ el bot contestaba
 * `tieneDeuda:true, saldo:45000` con CERO llamadas a GR.
 *
 * Lo que se acepta a cambio: por el skew del sello, el flag puede quedar
 * prendido hasta ~43min de más y disparar un refresh que no cambia nada. Es el
 * lado SEGURO (una llamada, colapsada por el single-flight de F2 y acotada por
 * `maxRetries: 1`), y es literalmente la política escrita en
 * `balanceTtlMinutesForStatus`. El carril LENTO sí lleva margen, pero por el
 * motivo inverso: sin él TODA baja queda stale permanente y el flag deja de
 * informar.
 *
 * El revert-probe del escenario en vivo vive en `ClienteSaldoResolver.test.ts`
 * ("FW3 — el cliente pagó hace 30min"). Acá se pinea la aritmética.
 */
describe('FW3 — el carril RÁPIDO no lleva margen de batch sobre el TTL configurado', () => {
  it('TTL efectivo del carril rápido = TTL configurado, sin sumas', () => {
    // Con el default de producción (60min): efectivo 60min, no 2h.
    expect(balanceTtlMinutesForStatus('active', 60)).toBe(60);
    expect(balanceTtlMinutesForStatus('active', TTL_MINUTES)).toBe(TTL_MINUTES);
  });

  it('un sello justo dentro de lo que el margen tapaba (150min con TTL 120) es STALE en los TRES call sites', async () => {
    // La fixture discriminante: 150min pasa el TTL configurado (120) pero caía
    // dentro del efectivo con margen (180). Si alguien reintroduce el margen,
    // los tres viran a `false` acá — y el gate del refresh se cierra con él.
    expect(await losTres(hace(150 * MIN), 'active')).toEqual([true, true, true]);
  });

  it('la perilla sigue viva: bajar el TTL configurado baja el efectivo (M5 sigue muerto)', () => {
    expect(balanceTtlMinutesForStatus('active', 10)).toBeLessThan(
      balanceTtlMinutesForStatus('active', 200),
    );
  });

  it('el carril LENTO conserva SU margen (24h de cadencia + 2h): ahí el flag informaría de MENOS, no de más', () => {
    expect(balanceTtlMinutesForStatus('baja', TTL_MINUTES)).toBe(SLOW_LANE_BALANCE_TTL_MINUTES);
    expect(SLOW_LANE_BALANCE_TTL_MINUTES).toBe(26 * 60);
  });
});

/**
 * Anti-deriva: la lista de statuses del carril lento vive en la capa de
 * aplicación (`balanceTtlMinutesForStatus`) mientras que la de estados GR vive
 * en `RefreshDebtorBalances` y la traducción estado→status en el adapter Prisma.
 * Un test SÍ puede mirar las tres a la vez, y es el único lugar donde el
 * "carril del status" y el "carril del sync" se pueden verificar iguales. Si
 * alguien mueve un estado de carril y no toca el TTL, esto se rompe.
 */
describe('F7 — el carril del TTL coincide con el carril del sync (anti-deriva)', () => {
  it('todo estado del SLOW_LANE mapea a un status con TTL diario', () => {
    for (const estado of SLOW_LANE.estados) {
      expect(balanceTtlMinutesForStatus(mapStatus(estado), TTL_MINUTES)).toBe(SLOW_LANE_BALANCE_TTL_MINUTES);
    }
  });

  it('ningún estado del FAST_LANE usa el TTL diario', () => {
    for (const estado of FAST_LANE.estados) {
      expect(balanceTtlMinutesForStatus(mapStatus(estado), TTL_MINUTES)).toBe(FAST_TTL_EFECTIVO);
    }
  });

  it('status desconocido/ausente cae al carril RÁPIDO (el lado que refresca más seguido)', () => {
    // Basura al valor seguro: equivocarse hacia "refrescar de más" cuesta una
    // llamada a GR; hacia "refrescar de menos" cuesta un saldo viejo dicho como fresco.
    expect(balanceTtlMinutesForStatus(undefined, TTL_MINUTES)).toBe(FAST_TTL_EFECTIVO);
    expect(balanceTtlMinutesForStatus(null, TTL_MINUTES)).toBe(FAST_TTL_EFECTIVO);
    expect(balanceTtlMinutesForStatus('cualquier-cosa', TTL_MINUTES)).toBe(FAST_TTL_EFECTIVO);
  });
});
