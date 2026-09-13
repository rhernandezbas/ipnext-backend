/**
 * suricata-tickets-mirror (fix wave, 2026-09-13) — holder AISLADO del
 * scheduler singleton, separado de `bootstrapSuricataSync.ts` a propósito:
 * ese archivo importa `config` (validación fail-fast de env vars al import,
 * `process.exit(1)` si falta alguna) y varios adapters Prisma/Minio.
 * `composeSuricataModule.ts` solo necesita LEER el scheduler ya construido
 * para la ruta `POST /sync` -- importar `bootstrapSuricataSync.ts` para eso
 * arrastraba esa validación a tests de rutas que nunca seteaban ese env
 * (rompió `suricata.routes.test.ts`/`suricata.reply.routes.test.ts` con un
 * `process.exit` real dentro del worker de Jest). Solo tipos (`import type`,
 * borrados en compilación) -- cero dependencias en runtime.
 */
import type { SuricataSyncScheduler } from './SuricataSyncScheduler';

let cached: SuricataSyncScheduler | null = null;

export function setSuricataSyncScheduler(scheduler: SuricataSyncScheduler | null): void {
  cached = scheduler;
}

export function getSuricataSyncScheduler(): SuricataSyncScheduler | null {
  return cached;
}
