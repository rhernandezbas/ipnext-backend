import { Router, Request, Response } from 'express';
import { ListReportDefinitions } from '@application/use-cases/ListReportDefinitions';
import { GenerateReport } from '@application/use-cases/GenerateReport';
import { ExportReport } from '@application/use-cases/ExportReport';
import { ReportType } from '@domain/entities/report';

export function createReportsRouter(
  listReportDefinitions: ListReportDefinitions,
  generateReport: GenerateReport,
  exportReport: ExportReport,
): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response): void => {
    const definitions = listReportDefinitions.execute();
    res.json(definitions);
  });

  router.post('/generate', (req: Request, res: Response): void => {
    const { type, filters = {} } = req.body as { type: ReportType; filters?: Record<string, string> };
    if (!type) {
      res.status(400).json({ error: 'Missing report type', code: 'MISSING_TYPE' });
      return;
    }
    const result = generateReport.execute(type, filters);
    res.json(result);
  });

  router.post('/export', (req: Request, res: Response): void => {
    const { type, filters = {} } = req.body as { type: ReportType; filters?: Record<string, string> };
    if (!type) {
      res.status(400).json({ error: 'Missing report type', code: 'MISSING_TYPE' });
      return;
    }
    const csv = exportReport.execute(type, filters);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
    res.send(csv);
  });

  return router;
}
