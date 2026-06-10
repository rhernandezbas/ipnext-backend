import { DomainError } from './index';

/** Raised when the UISP API is unreachable, times out, or returns 5xx. */
export class UispUnavailableError extends DomainError {
  constructor(message = 'UISP API is unavailable') {
    super(message, 'UISP_UNAVAILABLE');
    this.name = 'UispUnavailableError';
  }
}

/** Raised when a requested UispSite is not found in the mirror. */
export class UispSiteNotFoundError extends DomainError {
  constructor(uispId: string) {
    super(`UispSite with uispId "${uispId}" not found`, 'UISP_SITE_NOT_FOUND');
    this.name = 'UispSiteNotFoundError';
  }
}

/**
 * Raised when a NetworkSite update tries to link to a uispSiteId
 * that does not exist in the UISP mirror.
 */
export class UispSiteLinkNotFoundError extends DomainError {
  constructor(uispSiteId: string) {
    super(
      `UISP site "${uispSiteId}" not found in the mirror. Sync first or check the uispId.`,
      'UISP_SITE_NOT_FOUND',
    );
    this.name = 'UispSiteLinkNotFoundError';
  }
}
