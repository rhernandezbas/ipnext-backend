/**
 * ImportCsvLeads — batch-import recapture leads from a raw CSV string.
 *
 * Expected column order (header row required):
 *   nombre, telefono, email, direccion, motivo_baja, plan_anterior
 *
 * Only `nombre` is required per row. All other fields are optional.
 * Malformed rows are collected in `errors` without aborting the batch.
 */
import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { parseCsv } from './csvParse';

export interface ImportCsvLeadsResult {
  created: number;
  errors: string[];
}

export class ImportCsvLeads {
  constructor(private readonly repo: RecaptureRepository) {}

  async execute(csv: string): Promise<ImportCsvLeadsResult> {
    const rows = parseCsv(csv);

    let created = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNum = i + 1; // 1-based for human-readable error messages

      const nombre = row['nombre']?.trim() ?? '';
      if (!nombre) {
        errors.push(`Row ${rowNum}: missing required field "nombre"`);
        continue;
      }

      await this.repo.create({
        source: 'csv',
        clientId: null,
        contactName: nombre,
        phone: row['telefono']?.trim() || null,
        email: row['email']?.trim() || null,
        address: row['direccion']?.trim() || null,
        churnReason: row['motivo_baja']?.trim() || null,
        previousPlan: row['plan_anterior']?.trim() || null,
      });

      created++;
    }

    return { created, errors };
  }
}
