/**
 * TDD tests for ImportCsvLeads use case.
 * Uses InMemoryRecaptureRepository — no Prisma.
 */
import { ImportCsvLeads } from '../../application/use-cases/recapture/ImportCsvLeads';
import { InMemoryRecaptureRepository } from '../../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';

let repo: InMemoryRecaptureRepository;
let useCase: ImportCsvLeads;

beforeEach(() => {
  repo = new InMemoryRecaptureRepository();
  useCase = new ImportCsvLeads(repo);
});

describe('ImportCsvLeads — valid CSV', () => {
  it('creates leads from a well-formed CSV', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      'Alice,111,alice@test.com,Av. Corrientes 123,precio,basico',
      'Bob,222,bob@test.com,Calle Falsa 456,velocidad,premium',
    ].join('\n');

    const result = await useCase.execute(csv);

    expect(result.created).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('sets source=csv and clientId=null on every created lead', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      'Carlos,333,carlos@test.com,Av. Mayo 10,otro,standard',
    ].join('\n');

    await useCase.execute(csv);
    const { data } = await repo.list({ page: 1, limit: 25 });

    expect(data).toHaveLength(1);
    expect(data[0]!.source).toBe('csv');
    expect(data[0]!.clientId).toBeNull();
  });

  it('maps columns correctly', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      'Diana,444,diana@test.com,Calle 9 de Julio 77,precio_alto,turbo',
    ].join('\n');

    await useCase.execute(csv);
    const { data } = await repo.list({ page: 1, limit: 25 });
    const lead = data[0]!;

    expect(lead.contactName).toBe('Diana');
    expect(lead.phone).toBe('444');
    expect(lead.email).toBe('diana@test.com');
    expect((lead as any).address).toBe('Calle 9 de Julio 77');
    expect((lead as any).churnReason).toBe('precio_alto');
    expect((lead as any).previousPlan).toBe('turbo');
  });

  it('handles trailing newline without creating empty row', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      'Esteban,555,e@test.com,Avenida 1,otro,basico',
      '',
    ].join('\n');

    const result = await useCase.execute(csv);
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('handles empty (only headers) CSV — creates nothing', async () => {
    const csv = 'nombre,telefono,email,direccion,motivo_baja,plan_anterior\n';
    const result = await useCase.execute(csv);
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe('ImportCsvLeads — error handling', () => {
  it('reports error for row missing nombre, still creates others', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      ',111,a@test.com,Calle 1,otro,basico',      // missing nombre
      'Valeria,222,v@test.com,Calle 2,otro,basico', // valid
    ].join('\n');

    const result = await useCase.execute(csv);
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/nombre/i);
  });

  it('continues batch even when some rows have missing nombre', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      ',111,a@test.com,Calle 1,otro,basico', // missing nombre — error
      'Maria,999,,,,',                         // valid — only nombre is required
    ].join('\n');

    const result = await useCase.execute(csv);
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('silently skips fully blank rows (trailing newline, all-empty fields)', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      ',,,,,',           // all-empty fields — silently skipped by parseCsv
      'Maria,999,,,,',   // valid
    ].join('\n');

    const result = await useCase.execute(csv);
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(0); // blank row does not produce an error
  });

  it('includes row number in error message (1-based, counting non-blank rows)', async () => {
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      ',111,,,,',  // row 1 (first non-blank data row) — missing nombre
    ].join('\n');

    const result = await useCase.execute(csv);
    expect(result.errors[0]).toMatch(/1/);
  });
});
