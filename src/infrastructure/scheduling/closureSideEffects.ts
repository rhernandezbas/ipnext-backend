import { config } from '../config';
import { IngestClosedOptions } from '@application/use-cases/IngestClosedServiceOrders';
import { PostClosureComment } from '@application/use-cases/PostClosureComment';
import { BuildInventorySuggestions } from '@application/use-cases/BuildInventorySuggestions';
import { ExtractDeviceInfoFromPhoto } from '@application/use-cases/ExtractDeviceInfoFromPhoto';
import { PrismaTaskCommentRepository } from '../adapters/prisma/PrismaTaskCommentRepository';
import { PrismaInventorySuggestionRepository } from '../adapters/prisma/PrismaInventorySuggestionRepository';
import { PrismaOcrExtractionRepository } from '../adapters/prisma/PrismaOcrExtractionRepository';
import { PrismaDeviceTypeCatalogRepository } from '../adapters/prisma/PrismaDeviceTypeCatalogRepository';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { IClassPortalClient } from '../adapters/iclass-portal/IClassPortalClient';
import { OllamaDevicePhotoOcr } from '../adapters/ocr/OllamaDevicePhotoOcr';
import { AuditInstallationQuality } from '@application/use-cases/AuditInstallationQuality';
import { OllamaInstallationAuditor } from '../adapters/audit/OllamaInstallationAuditor';
import { PrismaTaskAuditRepository } from '../adapters/prisma/PrismaTaskAuditRepository';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';

type SideEffects = Pick<IngestClosedOptions, 'portal' | 'postComment' | 'buildSuggestions' | 'extractOcr' | 'auditInstallation'>;

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
    const deviceTypeCatalogRepo = new PrismaDeviceTypeCatalogRepository();
    const deviceTypeCatalogService = new DeviceTypeCatalogService(deviceTypeCatalogRepo);
    eff.extractOcr = new ExtractDeviceInfoFromPhoto(
      new OllamaDevicePhotoOcr({
        baseUrl: config.ocr.ollamaBaseUrl,
        model: config.ocr.model,
        timeoutMs: config.ocr.timeoutMs,
        deviceTypeNames: () => deviceTypeCatalogService.ensure().then(s => [...s]),
      }),
      new PrismaOcrExtractionRepository(),
      deviceTypeCatalogRepo,
    );
  }

  if (config.audit.enabled) {
    eff.auditInstallation = new AuditInstallationQuality(
      new OllamaInstallationAuditor({
        baseUrl: config.audit.ollamaBaseUrl,
        model: config.audit.model,
        timeoutMs: config.audit.timeoutMs,
      }),
      new PrismaTaskAuditRepository(),
      new PrismaSchedulingRepository(),
      new PrismaTaskCommentRepository(),
    );
  }

  return eff;
}
