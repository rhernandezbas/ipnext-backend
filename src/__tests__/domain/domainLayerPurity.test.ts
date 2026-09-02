/**
 * L5 (fix wave, customer-portal-api) — pureza de la capa de dominio.
 *
 * Regla del repo (CLAUDE.md): la direccion de dependencias va SIEMPRE hacia
 * adentro (`infrastructure → application → domain`); el dominio no conoce a
 * nadie. `PortalAccountRepository` (y 7 ports hermanos preexistentes) importaban
 * `PaginatedQuery/PaginatedResult` desde `application/dto/pagination` —
 * violacion DIP. Fix de CLASE: los tipos viven ahora en
 * `domain/entities/pagination.ts` y `application/dto/pagination.ts` los
 * re-exporta (ningun consumidor de application/infrastructure se rompe).
 *
 * Este guard estatico escanea TODO src/domain y falla ante cualquier import
 * hacia afuera — la clase entera queda pineada, no solo el port del portal.
 */
import * as fs from 'fs';
import * as path from 'path';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Deuda PREEXISTENTE descubierta por este guard (fuera del alcance del fix wave
 * L5, que cubre la clase `pagination`): dos ports importan DTOs enteros de
 * application. Moverlos requiere relocalizar esos DTOs con sus propios
 * consumidores — cambio aparte. La allowlist pinea que la lista NO CREZCA:
 * cualquier violacion nueva rompe este test.
 */
const PREEXISTING_DEBT = new Set([
  'ports/ClientTvCancelStatusRepository.ts -> @application/dto/gigared.dto',
  'ports/SchedulingRepository.ts -> @application/dto/scheduling.dto',
]);

describe('domain layer purity (L5)', () => {
  const domainDir = path.resolve(__dirname, '..', '..', 'domain');
  const files = listTsFiles(domainDir);

  it('encuentra archivos de dominio (el guard no escanea el vacio)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('ningun archivo de src/domain importa de application/ ni de infrastructure/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // Solo lineas de import/export-from efectivas (comentarios fuera —
      // regla "tests sobre texto filtran comentarios").
      const effective = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      const importFrom = /(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importFrom.exec(effective)) !== null) {
        const spec = match[1]!;
        if (
          spec.startsWith('@application/') ||
          spec.startsWith('@infrastructure/') ||
          /\.\.\/(?:\.\.\/)*application\//.test(spec) ||
          /\.\.\/(?:\.\.\/)*infrastructure\//.test(spec)
        ) {
          const key = `${path.relative(domainDir, file).replace(/\\/g, '/')} -> ${spec}`;
          if (!PREEXISTING_DEBT.has(key)) offenders.push(key);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * external-bulk-messaging fix wave F1 (finding F8) — el MISMO guard, una capa
 * mas afuera: `application/` no puede importar de `infrastructure/` (CLAUDE.md,
 * "DIP estricto"). Los 3 use cases nuevos de external-bulk importaban
 * `API_MESSAGING_USER_LOGIN` desde `@infrastructure/bootstrap/...`; la constante
 * se mudo a `@domain/constants/machineUsers` y el bootstrap la RE-EXPORTA (cero
 * ruptura de sus consumidores de infraestructura).
 *
 * La allowlist pinea la deuda PREEXISTENTE (4 entradas, ajenas a este change)
 * para que NO CREZCA: cualquier violacion nueva rompe este test.
 */
const APPLICATION_PREEXISTING_DEBT = new Set([
  'use-cases/IngestClosedServiceOrders.ts -> @infrastructure/adapters/search/sequenceNumberClause',
  'use-cases/gigared/ChangeTvPassword.ts -> @infrastructure/security/gigaredPassword',
  'use-cases/gigared/RegisterGigaredAccount.ts -> @infrastructure/security/gigaredPassword',
  'use-cases/TriggerUispSync.ts -> @infrastructure/scheduling/UispSyncScheduler',
]);

describe('application layer purity (external-bulk-messaging fix wave F1, F8)', () => {
  const applicationDir = path.resolve(__dirname, '..', '..', 'application');
  const files = listTsFiles(applicationDir);

  it('encuentra archivos de application (el guard no escanea el vacio)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('ningun archivo de src/application importa de infrastructure/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // Solo lineas de import/export-from efectivas (comentarios fuera —
      // regla "tests sobre texto filtran comentarios").
      const effective = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      const importFrom = /(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importFrom.exec(effective)) !== null) {
        const spec = match[1]!;
        if (spec.startsWith('@infrastructure/') || /\.\.\/(?:\.\.\/)*infrastructure\//.test(spec)) {
          const key = `${path.relative(applicationDir, file).replace(/\\/g, '/')} -> ${spec}`;
          if (!APPLICATION_PREEXISTING_DEBT.has(key)) offenders.push(key);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
