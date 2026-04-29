import { ReportType } from '@domain/entities/report';
import { InMemoryReportRepository } from '@infrastructure/adapters/in-memory/InMemoryReportRepository';

export class ExportReport {
  constructor(private readonly repo: InMemoryReportRepository) {}

  execute(type: ReportType, filters: Record<string, string>): string {
    const result = this.repo.generateReport(type, filters);

    const headers = result.columns.map(c => c.label).join(',');
    const rows = result.rows.map(row =>
      result.columns.map(c => {
        const val = row[c.key];
        const str = val === null || val === undefined ? '' : String(val);
        // Escape commas and quotes
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(',')
    );

    return [headers, ...rows].join('\n');
  }
}
