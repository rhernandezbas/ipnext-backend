import { ReportDefinition, ReportResult, ReportType } from '@domain/entities/report';

export interface ReportRepository {
  getDefinitions(): ReportDefinition[];
  generateReport(type: ReportType, filters: Record<string, string>): ReportResult;
}
