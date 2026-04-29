import { InMemoryReportRepository } from '../../infrastructure/adapters/in-memory/InMemoryReportRepository';
import { ListReportDefinitions } from '../../application/use-cases/ListReportDefinitions';
import { GenerateReport } from '../../application/use-cases/GenerateReport';
import { ExportReport } from '../../application/use-cases/ExportReport';

function makeRepo() {
  return new InMemoryReportRepository();
}

describe('ListReportDefinitions', () => {
  it('returns 20 definitions', () => {
    const repo = makeRepo();
    const uc = new ListReportDefinitions(repo);

    const result = uc.execute();

    expect(result).toHaveLength(20);
  });

  it('definitions cover clients, finance, network, scheduling, voice, and inventory categories', () => {
    const repo = makeRepo();
    const uc = new ListReportDefinitions(repo);

    const result = uc.execute();
    const categories = [...new Set(result.map(d => d.category))];

    expect(categories).toContain('clients');
    expect(categories).toContain('finance');
    expect(categories).toContain('network');
    expect(categories).toContain('scheduling');
    expect(categories).toContain('voice');
    expect(categories).toContain('inventory');
  });
});

describe('GenerateReport', () => {
  it('clients_by_status returns rows with status field', () => {
    const repo = makeRepo();
    const uc = new GenerateReport(repo);

    const result = uc.execute('clients_by_status', {});

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]).toHaveProperty('status');
    expect(result.reportType).toBe('clients_by_status');
  });

  it('revenue_by_period returns rows with period and invoiced fields', () => {
    const repo = makeRepo();
    const uc = new GenerateReport(repo);

    const result = uc.execute('revenue_by_period', { period: 'monthly' });

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]).toHaveProperty('period');
    expect(result.rows[0]).toHaveProperty('invoiced');
  });

  it('low_stock returns rows with quantity below minStock', () => {
    const repo = makeRepo();
    const uc = new GenerateReport(repo);

    const result = uc.execute('low_stock', {});

    expect(result.rows.length).toBeGreaterThan(0);
    result.rows.forEach(row => {
      expect(Number(row['quantity'])).toBeLessThan(Number(row['minStock']));
    });
  });
});

describe('ExportReport', () => {
  it('returns a CSV string with headers', () => {
    const repo = makeRepo();
    const uc = new ExportReport(repo);

    const result = uc.execute('clients_by_status', {});

    expect(typeof result).toBe('string');
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // First line should be headers
    expect(lines[0]).toContain('Estado');
  });
});
