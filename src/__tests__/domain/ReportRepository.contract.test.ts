import { ReportRepository } from '../../domain/ports/ReportRepository';
import { ReportDefinition, ReportResult, ReportType } from '../../domain/entities/report';

/**
 * Contract test for ReportRepository port.
 * Verifies that the interface shape is correct at type level,
 * and that any class implementing it satisfies the contract.
 */
describe('ReportRepository contract', () => {
  it('interface compiles and can be typed against a conforming stub', () => {
    // Arrange: create an inline object conforming to the interface
    const stub: ReportRepository = {
      getDefinitions(): ReportDefinition[] {
        return [];
      },
      generateReport(_type: ReportType, _filters: Record<string, string>): ReportResult {
        return {
          reportType: _type,
          generatedAt: new Date().toISOString(),
          filters: _filters,
          columns: [],
          rows: [],
          summary: {},
        };
      },
    };

    // Act
    const defs = stub.getDefinitions();
    const result = stub.generateReport('clients_by_status', {});

    // Assert
    expect(Array.isArray(defs)).toBe(true);
    expect(result.reportType).toBe('clients_by_status');
    expect(typeof result.generatedAt).toBe('string');
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.rows)).toBe(true);
  });
});
