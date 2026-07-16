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
      pppoeProfile: null,
    };

    const dto = toIngestConfigDTO(config);

    expect(dto.sourceEstado).toBe('CONF');
  });

  // ── install-pppoe-pregen (K1): pppoeProfile en DTO + schema ────────────────

  it('K1: toIngestConfigDTO round-trips pppoeProfile', () => {
    const config: IngestConfig = {
      intervalMs: 180000,
      windowMonths: 12,
      fiberProjectId: null,
      wirelessProjectId: null,
      sourceEstado: 'CONF',
      pppoeProfile: 'IP-Air-30-10',
    };

    expect(toIngestConfigDTO(config).pppoeProfile).toBe('IP-Air-30-10');
  });

  it('K1: UpdateIngestConfigSchema accepts a non-empty pppoeProfile and null (clear)', () => {
    expect(UpdateIngestConfigSchema.safeParse({ pppoeProfile: 'IP-Air-30-10' }).success).toBe(true);
    expect(UpdateIngestConfigSchema.safeParse({ pppoeProfile: null }).success).toBe(true);
  });

  it('K1: UpdateIngestConfigSchema rejects an empty pppoeProfile', () => {
    expect(UpdateIngestConfigSchema.safeParse({ pppoeProfile: '' }).success).toBe(false);
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
