import { DetectOwnershipTransferCases } from '@application/use-cases/actions/DetectOwnershipTransferCases';
import { InMemoryOwnershipCaseRepository } from '@infrastructure/adapters/in-memory/InMemoryOwnershipCaseRepository';
import { InMemoryContractPairingReader } from '@infrastructure/adapters/in-memory/InMemoryContractPairingReader';
import { PairingContract } from '@domain/entities/ownershipCase';
import { CreateOwnershipCaseInput } from '@domain/ports/OwnershipCaseRepository';

const START = '2024-05-01T00:00:00.000Z';
const ADDRESS = 'CALLE FALSA 123';

function baja(id: string, clientId: string, overrides: Partial<PairingContract> = {}): PairingContract {
  return {
    id,
    clientId,
    address: ADDRESS,
    startDate: START,
    motivoBaja: 'CAMBIO DE TITULARIDAD',
    status: 'baja',
    ...overrides,
  };
}

function activo(id: string, clientId: string, overrides: Partial<PairingContract> = {}): PairingContract {
  return {
    id,
    clientId,
    address: ADDRESS,
    startDate: START,
    motivoBaja: null,
    status: 'active',
    ...overrides,
  };
}

describe('DetectOwnershipTransferCases (DET-1)', () => {
  let caseRepo: InMemoryOwnershipCaseRepository;
  let reader: InMemoryContractPairingReader;
  let detector: DetectOwnershipTransferCases;

  beforeEach(() => {
    caseRepo = new InMemoryOwnershipCaseRepository();
    reader = new InMemoryContractPairingReader();
    detector = new DetectOwnershipTransferCases(caseRepo, reader);
  });

  // Scenario: baja con motivo titularidad y un candidato único
  it('creates a pending case WITH target when exactly one active contract of another client matches', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    reader.seed(activo('c-new', 'cli-2'));

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    const { items, total } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(total).toBe(1);
    const c = items[0]!;
    expect(c.status).toBe('pending');
    expect(c.sourceContractId).toBe('c-old');
    expect(c.sourceClientId).toBe('cli-1');
    expect(c.targetContractId).toBe('c-new');
    expect(c.targetClientId).toBe('cli-2');
    expect(c.candidates).toBeNull();
    expect(c.motivoBaja).toBe('CAMBIO DE TITULARIDAD');
    expect(c.equipmentReviewed).toBe(false);
  });

  // Scenario: candidatos múltiples
  it('creates an ambiguous case with the candidates list and NO target when >=2 contracts match', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    reader.seed(activo('c-a', 'cli-2'));
    reader.seed(activo('c-b', 'cli-3'));

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const c = items[0]!;
    expect(c.status).toBe('ambiguous');
    expect(c.targetContractId).toBeNull();
    expect(c.targetClientId).toBeNull();
    expect(c.candidates).toEqual([
      { contractId: 'c-a', clientId: 'cli-2' },
      { contractId: 'c-b', clientId: 'cli-3' },
    ]);
  });

  // Scenario: sin candidato
  it('creates a pending case WITHOUT target when no active contract matches the keys', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    // Same client universe but different address — not a pairing match.
    reader.seed(activo('c-x', 'cli-2', { address: 'OTRA CALLE 456' }));

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const c = items[0]!;
    expect(c.status).toBe('pending');
    expect(c.targetContractId).toBeNull();
    expect(c.targetClientId).toBeNull();
    expect(c.candidates).toBeNull();
  });

  // Scenario: idempotencia (caso NO prístino — el operador ya lo avanzó)
  it('is idempotent — a re-run skips the existing NON-pristine case and NEVER overwrites its state', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    reader.seed(activo('c-new', 'cli-2'));

    const first = await detector.execute();
    expect(first).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });

    // Operator moves the case forward between ticks — the re-run must NOT reset it.
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const existing = items[0]!;
    await caseRepo.update(existing.id, { status: 'done' });

    const second = await detector.execute();
    // Fix wave 2: la baja ya caseada ni siquiera entra al scan (exclusión explícita).
    expect(second).toEqual({ scanned: 0, created: 0, skipped: 0, repaired: 0 });

    const after = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(after.total).toBe(1);
    expect(after.items[0]!.id).toBe(existing.id);
    expect(after.items[0]!.status).toBe('done');
  });

  // Scenario: motivo distinto no dispara (guaranteed by the reader; the use case must not create)
  it('does not open a case for bajas with a non-titularity motivo', async () => {
    reader.seed(baja('c-old', 'cli-1', { motivoBaja: 'MIGRACION' }));
    reader.seed(activo('c-new', 'cli-2'));

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 0, created: 0, skipped: 0, repaired: 0 });
    expect((await caseRepo.list({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it('matches the titularity motivo case-insensitively and as a substring', async () => {
    reader.seed(baja('c-old', 'cli-1', { motivoBaja: 'Baja por Cambio de Titularidad (venta)' }));
    reader.seed(activo('c-new', 'cli-2'));

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(items[0]!.targetContractId).toBe('c-new');
  });

  // Scenario: mismo cliente no es candidato
  it('leaves the case without target when the only matching contract belongs to the SAME client', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    reader.seed(activo('c-new', 'cli-1')); // same client — contract change, not titularity

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const c = items[0]!;
    expect(c.status).toBe('pending');
    expect(c.targetContractId).toBeNull();
    expect(c.candidates).toBeNull();
  });

  // Margin decision: a baja without address can never pair (exact-address key) —
  // the case is still created, visible, resolvable by hand.
  it('never pairs a baja without address — case created pending without target', async () => {
    reader.seed(baja('c-old', 'cli-1', { address: null }));
    reader.seed(activo('c-new', 'cli-2', { address: null }));

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(items[0]!.status).toBe('pending');
    expect(items[0]!.targetContractId).toBeNull();
  });

  // L5 — address en blanco/whitespace se trata como null en el guard anti-pairing.
  it('never pairs a baja with a blank/whitespace address (treated as null)', async () => {
    reader.seed(baja('c-old', 'cli-1', { address: '   ' }));
    reader.seed(activo('c-new', 'cli-2', { address: '   ' }));

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(items[0]!.status).toBe('pending');
    expect(items[0]!.targetContractId).toBeNull();
  });

  // M2/B1 — cap por tick: el detector pide un batch acotado (default 500),
  // el backlog restante entra en ticks siguientes (exclusión de caseadas — fix wave 2).
  it('caps the scan at the batch limit per tick', async () => {
    const capped = new DetectOwnershipTransferCases(caseRepo, reader, { batchLimit: 2 });
    reader.seed(baja('c-1', 'cli-1', { address: 'UNO 1' }));
    reader.seed(baja('c-2', 'cli-2', { address: 'DOS 2' }));
    reader.seed(baja('c-3', 'cli-3', { address: 'TRES 3' }));

    const result = await capped.execute();

    expect(result.scanned).toBe(2);
    expect(result.created).toBe(2);
    expect((await caseRepo.list({ page: 1, pageSize: 10 })).total).toBe(2);
  });

  // FIX WAVE 2 — el cap DRENA: las bajas ya caseadas se EXCLUYEN del scan y el
  // batch siguiente trae las SIGUIENTES. Sin la exclusión, el WHERE matchea las
  // mismas N filas para siempre (createdAt es fecha de fila del mirror, no de
  // baja) y el excedente starvaba permanente.
  it('el cap drena: cada tick trae las bajas AÚN sin caso, no las ya caseadas', async () => {
    const capped = new DetectOwnershipTransferCases(caseRepo, reader, { batchLimit: 2 });
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    reader.seed(baja('c-1', 'cli-1', { address: 'UNO 1' }), daysAgo(4));
    reader.seed(baja('c-2', 'cli-2', { address: 'DOS 2' }), daysAgo(3));
    reader.seed(baja('c-3', 'cli-3', { address: 'TRES 3' }), daysAgo(2));
    reader.seed(baja('c-4', 'cli-4', { address: 'CUATRO 4' }), daysAgo(1));

    // Tick 1: las 2 primeras del orden estable (c-4, c-3) quedan caseadas.
    const tick1 = await capped.execute();
    expect(tick1).toEqual({ scanned: 2, created: 2, skipped: 0, repaired: 0 });

    // Tick 2: el batch trae las SIGUIENTES (c-2, c-1), no re-escanea las caseadas.
    const tick2 = await capped.execute();
    expect(tick2).toEqual({ scanned: 2, created: 2, skipped: 0, repaired: 0 });
    expect((await caseRepo.list({ page: 1, pageSize: 10 })).total).toBe(4);
    expect(await caseRepo.existsBySourceContract('c-1')).toBe(true);
    expect(await caseRepo.existsBySourceContract('c-2')).toBe(true);

    // Tick 3: no queda nada sin casear — el scan viene vacío.
    const tick3 = await capped.execute();
    expect(tick3.scanned).toBe(0);
    expect(tick3.created).toBe(0);
  });

  // FIX WAVE 2 — existsBySourceContract queda como CINTURÓN para carreras DENTRO
  // del tick: un caso creado entre el snapshot de ids caseados y el loop se
  // skipea, no explota por el unique.
  it('un caso creado dentro del tick (carrera) se skipea por el guard existsBySourceContract', async () => {
    class RaceyPairingReader extends InMemoryContractPairingReader {
      onAfterFindBajas: (() => Promise<void>) | null = null;

      override async findTitularityBajas(input: Parameters<InMemoryContractPairingReader['findTitularityBajas']>[0]) {
        const result = await super.findTitularityBajas(input);
        if (this.onAfterFindBajas) {
          const hook = this.onAfterFindBajas;
          this.onAfterFindBajas = null;
          await hook();
        }
        return result;
      }
    }

    const raceyReader = new RaceyPairingReader();
    const det = new DetectOwnershipTransferCases(caseRepo, raceyReader);
    raceyReader.seed(baja('c-race', 'cli-1', { address: 'UNO 1' }));
    raceyReader.onAfterFindBajas = async () => {
      await caseRepo.create({
        sourceContractId: 'c-race',
        sourceClientId: 'cli-1',
        motivoBaja: 'CAMBIO DE TITULARIDAD',
        status: 'pending',
      });
    };

    const result = await det.execute();

    expect(result).toEqual({ scanned: 1, created: 0, skipped: 1, repaired: 0 });
    expect((await caseRepo.list({ page: 1, pageSize: 10 })).total).toBe(1);
  });

  // M2 — per-baja try/catch: un fallo de create (P2002/carrera/etc.) NO aborta el batch.
  it('a failing create counts as skipped and does NOT abort the rest of the batch', async () => {
    class FailingCreateRepo extends InMemoryOwnershipCaseRepository {
      override async create(input: CreateOwnershipCaseInput) {
        if (input.sourceContractId === 'c-boom') throw new Error('P2002 simulated');
        return super.create(input);
      }
    }
    const failingRepo = new FailingCreateRepo();
    const det = new DetectOwnershipTransferCases(failingRepo, reader);
    reader.seed(baja('c-boom', 'cli-1', { address: 'UNO 1' }));
    reader.seed(baja('c-ok', 'cli-2', { address: 'DOS 2' }));

    const result = await det.execute();

    expect(result).toEqual({ scanned: 2, created: 1, skipped: 1, repaired: 0 });
    expect(await failingRepo.existsBySourceContract('c-ok')).toBe(true);
  });

  it('returns {scanned, created, skipped, repaired} counters over successive ticks', async () => {
    reader.seed(baja('c-1', 'cli-1'));
    reader.seed(baja('c-2', 'cli-2', { address: 'OTRA 9' }));
    await detector.execute(); // opens both

    reader.seed(baja('c-3', 'cli-3', { address: 'TERCERA 5' }));
    const result = await detector.execute();

    // Fix wave 2: las bajas ya caseadas NO entran al scan (exclusión explícita) —
    // el tick siguiente solo ve lo nuevo. skipped queda para fallos/carreras intra-tick.
    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });
    expect((await caseRepo.list({ page: 1, pageSize: 10 })).total).toBe(3);
  });
});

// ─── H1a — re-pareo de casos prístinos (DET-1) ────────────────────────────────

describe('DetectOwnershipTransferCases — re-pareo de casos prístinos (H1a)', () => {
  let caseRepo: InMemoryOwnershipCaseRepository;
  let reader: InMemoryContractPairingReader;
  let detector: DetectOwnershipTransferCases;

  beforeEach(() => {
    caseRepo = new InMemoryOwnershipCaseRepository();
    reader = new InMemoryContractPairingReader();
    detector = new DetectOwnershipTransferCases(caseRepo, reader);
  });

  it('un caso prístino (pending, sin target, sin candidates, sin review) gana target cuando aparece 1 candidato', async () => {
    // Tick 1: la baja llega SOLA (timing F0 — el alta entra al mirror después).
    reader.seed(baja('c-old', 'cli-1'));
    const first = await detector.execute();
    expect(first).toEqual({ scanned: 1, created: 1, skipped: 0, repaired: 0 });

    // Tick 2: el alta ya está en el mirror. La baja ya caseada no re-entra al
    // scan (fix wave 2) — el caso se repara por el loop de prístinos.
    reader.seed(activo('c-new', 'cli-2'));
    const second = await detector.execute();

    expect(second).toEqual({ scanned: 0, created: 0, skipped: 0, repaired: 1 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const c = items[0]!;
    expect(c.status).toBe('pending');
    expect(c.targetContractId).toBe('c-new');
    expect(c.targetClientId).toBe('cli-2');
    expect(c.candidates).toBeNull();
  });

  it('un caso prístino pasa a ambiguous con candidates cuando aparecen >=2 candidatos', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    await detector.execute();

    reader.seed(activo('c-a', 'cli-2'));
    reader.seed(activo('c-b', 'cli-3'));
    const result = await detector.execute();

    expect(result.repaired).toBe(1);
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const c = items[0]!;
    expect(c.status).toBe('ambiguous');
    expect(c.targetContractId).toBeNull();
    expect(c.candidates).toEqual([
      { contractId: 'c-a', clientId: 'cli-2' },
      { contractId: 'c-b', clientId: 'cli-3' },
    ]);
  });

  it('un caso NO prístino (equipmentReviewed=true) NO se re-parea aunque haya candidato', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    await detector.execute();
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    await caseRepo.update(items[0]!.id, {
      equipmentReviewed: true,
      equipmentReviewedById: 'user-1',
      equipmentReviewedAt: '2026-07-10T00:00:00.000Z',
    });

    reader.seed(activo('c-new', 'cli-2'));
    const result = await detector.execute();

    expect(result.repaired).toBe(0);
    expect((await caseRepo.getById(items[0]!.id))!.targetContractId).toBeNull();
  });

  it('un caso con target ya seteado NO se re-parea (solo los prístinos)', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    reader.seed(activo('c-new', 'cli-2'));
    await detector.execute(); // paired on creation

    reader.seed(activo('c-third', 'cli-3')); // a second candidate appears later
    const result = await detector.execute();

    expect(result.repaired).toBe(0);
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(items[0]!.targetContractId).toBe('c-new');
    expect(items[0]!.status).toBe('pending');
  });

  it('un caso prístino con 0 candidatos sigue prístino (sin error, re-intenta el próximo tick)', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    await detector.execute();

    const result = await detector.execute();

    // Fix wave 2: la baja caseada queda fuera del scan; el prístino sin candidatos
    // tampoco cuenta como repaired — el resultado del tick es todo ceros.
    expect(result).toEqual({ scanned: 0, created: 0, skipped: 0, repaired: 0 });
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(items[0]!.status).toBe('pending');
    expect(items[0]!.targetContractId).toBeNull();
  });

  it('si el contrato origen ya no está en el mirror, el prístino se salta sin romper el batch', async () => {
    caseRepo.seedCase({
      id: 'case-huerfano',
      sourceContractId: 'ct-gone',
      sourceClientId: 'cli-1',
      motivoBaja: 'CAMBIO DE TITULARIDAD',
      bajaDate: null,
      targetContractId: null,
      targetClientId: null,
      candidates: null,
      status: 'pending',
      dismissReason: null,
      equipmentReviewed: false,
      equipmentReviewedById: null,
      equipmentReviewedAt: null,
      detectedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    const result = await detector.execute();

    expect(result).toEqual({ scanned: 0, created: 0, skipped: 0, repaired: 0 });
    expect((await caseRepo.getById('case-huerfano'))!.status).toBe('pending');
  });

  it('el re-pareo respeta el guard de address null/blank del origen', async () => {
    reader.seed(baja('c-old', 'cli-1', { address: null }));
    await detector.execute();

    reader.seed(activo('c-new', 'cli-2', { address: null }));
    const result = await detector.execute();

    expect(result.repaired).toBe(0);
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(items[0]!.targetContractId).toBeNull();
  });
});

// ─── FIX WAVE 2 — el re-pareo es CAS: no resucita ni pisa (carrera vs HTTP) ────

/**
 * Simula la carrera detector-vs-HTTP de forma determinística: el "operador"
 * muta el caso ENTRE listPristineUnpaired (snapshot del detector) y el write
 * del re-pareo, hookeando el propio listado (one-shot).
 */
class RaceyOwnershipCaseRepository extends InMemoryOwnershipCaseRepository {
  onAfterListPristine: (() => Promise<void>) | null = null;

  override async listPristineUnpaired(limit: number) {
    const pristine = await super.listPristineUnpaired(limit);
    if (this.onAfterListPristine) {
      const hook = this.onAfterListPristine;
      this.onAfterListPristine = null;
      await hook();
    }
    return pristine;
  }
}

describe('DetectOwnershipTransferCases — re-pareo CAS (fix wave 2)', () => {
  let caseRepo: RaceyOwnershipCaseRepository;
  let reader: InMemoryContractPairingReader;
  let detector: DetectOwnershipTransferCases;

  beforeEach(() => {
    caseRepo = new RaceyOwnershipCaseRepository();
    reader = new InMemoryContractPairingReader();
    detector = new DetectOwnershipTransferCases(caseRepo, reader);
  });

  it('un dismiss entre el listado y el write NO resucita el caso (rama ambiguous)', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    await detector.execute(); // caso prístino sin candidatos
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const caseId = items[0]!.id;

    // Tick siguiente: aparecen 2 candidatos, pero el operador descarta el caso
    // ENTRE el listado de prístinos y el write del detector.
    reader.seed(activo('c-a', 'cli-2'));
    reader.seed(activo('c-b', 'cli-3'));
    caseRepo.onAfterListPristine = async () => {
      await caseRepo.update(caseId, { status: 'dismissed', dismissReason: 'no corresponde' });
    };

    const result = await detector.execute();

    expect(result.repaired).toBe(0);
    const after = (await caseRepo.getById(caseId))!;
    expect(after.status).toBe('dismissed');
    expect(after.dismissReason).toBe('no corresponde');
    expect(after.candidates).toBeNull();
  });

  it('un dismiss entre el listado y el write NO gana target (rama 1 candidato)', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    await detector.execute();
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const caseId = items[0]!.id;

    reader.seed(activo('c-new', 'cli-2'));
    caseRepo.onAfterListPristine = async () => {
      await caseRepo.update(caseId, { status: 'dismissed', dismissReason: 'duplicado' });
    };

    const result = await detector.execute();

    expect(result.repaired).toBe(0);
    const after = (await caseRepo.getById(caseId))!;
    expect(after.status).toBe('dismissed');
    expect(after.dismissReason).toBe('duplicado');
    expect(after.targetContractId).toBeNull();
    expect(after.targetClientId).toBeNull();
  });

  it('un set-target del operador entre el listado y el write NO se pisa', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    await detector.execute();
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    const caseId = items[0]!.id;

    reader.seed(activo('c-new', 'cli-2')); // el candidato que el detector re-parearía
    caseRepo.onAfterListPristine = async () => {
      await caseRepo.update(caseId, { targetContractId: 'ct-manual', targetClientId: 'cli-9' });
    };

    const result = await detector.execute();

    expect(result.repaired).toBe(0);
    const after = (await caseRepo.getById(caseId))!;
    expect(after.targetContractId).toBe('ct-manual');
    expect(after.targetClientId).toBe('cli-9');
    expect(after.status).toBe('pending');
  });

  it('sin carrera, el repair legítimo sigue funcionando y cuenta repaired', async () => {
    reader.seed(baja('c-old', 'cli-1'));
    await detector.execute();

    reader.seed(activo('c-new', 'cli-2'));
    const result = await detector.execute(); // sin hook — nadie tocó el caso

    expect(result.repaired).toBe(1);
    const { items } = await caseRepo.list({ page: 1, pageSize: 10 });
    expect(items[0]!.targetContractId).toBe('c-new');
    expect(items[0]!.targetClientId).toBe('cli-2');
    expect(items[0]!.status).toBe('pending');
  });
});
