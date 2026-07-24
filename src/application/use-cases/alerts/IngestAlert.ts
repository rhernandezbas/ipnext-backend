import { NocAlert, NocAlertInput } from '@domain/entities/nocAlert';
import { NocAlertRepository } from '@domain/ports/NocAlertRepository';
import { AlertEventPublisher } from '@domain/ports/AlertEventPublisher';

/**
 * IngestAlert — canonical ingestion use-case. Dedup por (source, fingerprint)
 * vive en `computeNocAlertIngest` (domain), invocado a través de
 * `NocAlertRepository.upsertByFingerprint`.
 *
 * Dark ingestion (spec.md): esta clase NO conoce ningún `AlertNotifier` — el
 * fan-out a Telegram/WhatsApp es Fase D y se subscribe al `AlertEventPublisher`
 * (event bus), nunca llamado directo desde acá. Publicar el evento DESPUÉS de
 * persistir OK es la única salida de este use-case.
 */
export class IngestAlert {
  constructor(
    private readonly repo: NocAlertRepository,
    private readonly publisher: AlertEventPublisher,
  ) {}

  async execute(input: NocAlertInput): Promise<NocAlert> {
    const alert = await this.repo.upsertByFingerprint(input);
    this.publisher.publish({ type: alert.status === 'firing' ? 'firing' : 'resolved', alert });
    return alert;
  }
}
