import { ReportType, ReportResult } from '@domain/entities/report';
import { ReportRepository } from '@domain/ports/ReportRepository';

export class GenerateReport {
  constructor(private readonly repo: ReportRepository) {}

  execute(type: ReportType, filters: Record<string, string>): ReportResult {
    return this.repo.generateReport(type, filters);
  }
}
