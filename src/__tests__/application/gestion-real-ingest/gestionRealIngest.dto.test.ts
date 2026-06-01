import {
  toIngestConfigDTO,
  UpdateIngestConfigSchema,
} from '@application/dto/gestionRealIngest.dto';
import { IngestConfig } from '@domain/ports/GestionRealIngestConfigRepository';

describe('gestionRealIngest.dto — sourceEstado', () => {
  it('toIngestConfigDTO round-trips sourceEstado', () => {
    const config: IngestConfig = {
      intervalMs: 180000,
      windowMonths: 12,
      fiberProjectId: null,
      wirelessProjectId: null,
      sourceEstado: 'CONF',
    };

    const dto = toIngestConfigDTO(config);

    expect(dto.sourceEstado).toBe('CONF');
  });

  it('UpdateIngestConfigSchema accepts valid GR estados', () => {
    for (const estado of ['PEND', 'CONF', 'CERR', 'ANUL'] as const) {
      const parsed = UpdateIngestConfigSchema.safeParse({ sourceEstado: estado });
      expect(parsed.success).toBe(true);
    }
  });

  it('UpdateIngestConfigSchema rejects an invalid estado', () => {
    const parsed = UpdateIngestConfigSchema.safeParse({ sourceEstado: 'XXX' });
    expect(parsed.success).toBe(false);
  });
});
