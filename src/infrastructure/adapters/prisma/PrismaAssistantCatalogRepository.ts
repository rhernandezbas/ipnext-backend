import type {
  AssistantActionEntry,
  AssistantDataSourceEntry,
  AssistantRiskLevel,
} from '@domain/entities/assistant';
import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import { prisma } from '../../database/prisma';

/**
 * ai-assistant-multiagent (T1.5, CFG-3) — catálogos en Prisma.
 *
 * Las filas las siembra la migración `20261023000000_ai_assistant_multiagent` de forma
 * idempotente (`ON CONFLICT (key) DO NOTHING`), porque el deploy corre `migrate deploy`
 * pero NUNCA `prisma db seed`.
 *
 * ⚠️ No hay `create` ni `delete`: el port no los declara (frontera R5). Fabricar una fuente
 * o una acción nueva requiere registrar un resolver en código y pasar por review — desde la
 * UI sólo se HABILITA lo que ya existe.
 */

interface DataSourceRow {
  key: string;
  label: string;
  enabled: boolean;
  updatedAt: Date;
}

interface ActionRow {
  key: string;
  label: string;
  riskLevel: string;
  updatedAt: Date;
}

function toDataSource(row: DataSourceRow): AssistantDataSourceEntry {
  return {
    key: row.key,
    label: row.label,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAction(row: ActionRow): AssistantActionEntry {
  return {
    key: row.key,
    label: row.label,
    // La columna es TEXT en la DB; el dominio la tipa. Un valor fuera del set sólo puede
    // venir de una edición manual de la base — se normaliza al más restrictivo.
    riskLevel: (['green', 'yellow', 'red'].includes(row.riskLevel)
      ? row.riskLevel
      : 'red') as AssistantRiskLevel,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaAssistantCatalogRepository implements AssistantCatalogRepository {
  async listDataSources(): Promise<AssistantDataSourceEntry[]> {
    const rows = await prisma.assistantDataSource.findMany({ orderBy: { key: 'asc' } });
    return rows.map((r) => toDataSource(r as DataSourceRow));
  }

  async listActions(): Promise<AssistantActionEntry[]> {
    const rows = await prisma.assistantAction.findMany({ orderBy: { key: 'asc' } });
    return rows.map((r) => toAction(r as ActionRow));
  }

  async findMissingDataSourceKeys(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const found = await prisma.assistantDataSource.findMany({
      where: { key: { in: keys } },
      select: { key: true },
    });
    const foundKeys = new Set(found.map((f) => f.key));
    return keys.filter((k) => !foundKeys.has(k));
  }

  async findMissingActionKeys(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const found = await prisma.assistantAction.findMany({
      where: { key: { in: keys } },
      select: { key: true },
    });
    const foundKeys = new Set(found.map((f) => f.key));
    return keys.filter((k) => !foundKeys.has(k));
  }

  /**
   * CFG-3 scenario 2 — preserva el ORDEN pedido por el caller (el `findMany` de Postgres no
   * lo garantiza). Importa porque el contexto que se arma para el modelo es determinístico:
   * dos corridas con la misma intención deben producir el mismo payload.
   */
  async filterEnabledDataSourceKeys(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const rows = await prisma.assistantDataSource.findMany({
      where: { key: { in: keys }, enabled: true },
      select: { key: true },
    });
    const enabled = new Set(rows.map((r) => r.key));
    return keys.filter((k) => enabled.has(k));
  }

  async setDataSourceEnabled(
    key: string,
    enabled: boolean,
  ): Promise<AssistantDataSourceEntry | null> {
    const existing = await prisma.assistantDataSource.findUnique({ where: { key } });
    if (!existing) return null;

    const row = await prisma.assistantDataSource.update({ where: { key }, data: { enabled } });
    return toDataSource(row as DataSourceRow);
  }
}
