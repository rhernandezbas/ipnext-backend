import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { NeedsReviewTaskDTO, toNeedsReviewTaskDTO } from '@application/dto/gestionRealIngest.dto';

/**
 * Lists the needs-review tasks produced by the ingest (REQ-REVIEW-1): tasks
 * ingested from Gestión Real (`grOrdenId` set) but left unclassified (no
 * project, `[REVISAR - Logística]` prefix). Returns an empty array when none.
 *
 * The `listNeedsReview` filter lives in the repository so both in-memory and
 * Prisma adapters agree on the predicate; this use-case only maps to DTOs and
 * never returns raw entities.
 */
export class ListNeedsReviewTasks {
  constructor(private readonly scheduling: SchedulingRepository) {}

  async execute(): Promise<NeedsReviewTaskDTO[]> {
    const tasks = await this.scheduling.listNeedsReview();
    return tasks.map(toNeedsReviewTaskDTO);
  }
}
