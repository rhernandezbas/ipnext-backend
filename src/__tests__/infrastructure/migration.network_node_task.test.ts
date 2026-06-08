/**
 * A1.1 [RED] Migration snapshot test:
 * Verifica que la migración network_node_task existe y contiene los cambios esperados.
 * Cubre: kind + networkSiteId en ScheduledTask, iclassNodeCode en NetworkSite.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';

describe('Migration: network_node_task', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.includes('network_node_task'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('adds kind column with DEFAULT customer to ScheduledTask', () => {
    expect(migrationSql).toMatch(/ALTER TABLE.*"ScheduledTask".*ADD COLUMN.*"kind"/si);
    expect(migrationSql).toMatch(/'customer'/);
  });

  it('adds networkSiteId nullable FK to ScheduledTask', () => {
    expect(migrationSql).toMatch(/ALTER TABLE.*"ScheduledTask".*ADD COLUMN.*"networkSiteId"/si);
  });

  it('adds networkSiteId index on ScheduledTask', () => {
    expect(migrationSql).toMatch(/CREATE INDEX.*"ScheduledTask_networkSiteId_idx"/si);
  });

  it('adds iclassNodeCode nullable column to NetworkSite', () => {
    expect(migrationSql).toMatch(/ALTER TABLE.*"NetworkSite".*ADD COLUMN.*"iclassNodeCode"/si);
  });

  it('adds FK constraint for networkSiteId with ON DELETE SET NULL', () => {
    expect(migrationSql).toMatch(/ON DELETE SET NULL/i);
  });
});
