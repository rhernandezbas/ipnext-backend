import { config } from '../config';
import { IngestClosedOptions } from '@application/use-cases/IngestClosedServiceOrders';
import { PostClosureComment } from '@application/use-cases/PostClosureComment';
import { BuildInventorySuggestions } from '@application/use-cases/BuildInventorySuggestions';
import { ExtractDeviceInfoFromPhoto } from '@application/use-cases/ExtractDeviceInfoFromPhoto';
import { PrismaTaskCommentRepository } from '../adapters/prisma/PrismaTaskCommentRepository';
import { PrismaInventorySuggestionRepository } from '../adapters/prisma/PrismaInventorySuggestionRepository';
import { PrismaOcrExtractionRepository } from '../adapters/prisma/PrismaOcrExtractionRepository';
import { IClassPortalClient } from '../adapters/iclass-portal/IClassPortalClient';
import { OllamaDevicePhotoOcr } from '../adapters/ocr/OllamaDevicePhotoOcr';

type SideEffects = Pick<IngestClosedOptions, 'portal' | 'postComment' | 'buildSuggestions' | 'extractOcr'>;

/**
 * Composition of the opt-in closure side effects shared by the cron and the
 * backfill. Auto-comment + material suggestions are always on (cheap, no external
 * deps). The SEAM photo scraper turns on when ICLASS_PORTAL_* is set; OCR when
 * ICLASS_OCR_ENABLED=true. Without the portal there is no photoUrl, so OCR stays
 * effectively dormant — all side effects are non-fatal in the ingest regardless.
 */
export function buildClosureSideEffects(): SideEffects {
  const eff: SideEffects = {
    postComment: new PostClosureComment(new PrismaTaskCommentRepository()),
    buildSuggestions: new BuildInventorySuggestions(new PrismaInventorySuggestionRepository()),
  };

  const portal = config.iclassPortal;
  if (portal.user && portal.password) {
    eff.portal = new IClassPortalClient({ baseUrl: portal.baseUrl, user: portal.user, password: portal.password });
  }

  if (config.ocr.enabled) {
    eff.extractOcr = new ExtractDeviceInfoFromPhoto(
      new OllamaDevicePhotoOcr({ baseUrl: config.ocr.ollamaBaseUrl, model: config.ocr.model }),
      new PrismaOcrExtractionRepository(),
    );
  }

  return eff;
}
