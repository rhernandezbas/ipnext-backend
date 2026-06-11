/**
 * #47 — Gigared domain errors: codes are the FROZEN wire contract.
 * Each error carries the exact `code` the router/errorHandler maps to a pinned status.
 */
import { DomainError } from '@domain/errors';
import {
  GigaredNotConfiguredError,
  GigaredUnavailableError,
  GigaredAuthError,
  GigaredNotFoundError,
  GigaredRejectedError,
  TvCatalogMissingError,
  CicNotFoundError,
  CicAlreadyLinkedError,
} from '@domain/errors/gigared';

describe('Gigared domain errors (#47)', () => {
  it('GigaredNotConfiguredError → code GIGARED_NOT_CONFIGURED, is a DomainError', () => {
    const e = new GigaredNotConfiguredError();
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('GIGARED_NOT_CONFIGURED');
    expect(e.name).toBe('GigaredNotConfiguredError');
  });

  it('GigaredUnavailableError → code GIGARED_UNAVAILABLE', () => {
    const e = new GigaredUnavailableError();
    expect(e.code).toBe('GIGARED_UNAVAILABLE');
    expect(e.name).toBe('GigaredUnavailableError');
  });

  it('GigaredUnavailableError carries an optional upstream detail (#47g transparency)', () => {
    const e = new GigaredUnavailableError('Gigared external service (CUA) error', 'CUA timeout');
    expect(e.detail).toBe('CUA timeout');
    // detail is optional — omitting it leaves it undefined (no crash)
    expect(new GigaredUnavailableError().detail).toBeUndefined();
  });

  it('GigaredAuthError → code GIGARED_AUTH_FAILED', () => {
    const e = new GigaredAuthError();
    expect(e.code).toBe('GIGARED_AUTH_FAILED');
    expect(e.name).toBe('GigaredAuthError');
  });

  it('GigaredAuthError carries an optional upstream detail (#47g transparency)', () => {
    const e = new GigaredAuthError('Gigared API key is invalid', 'La clave de API no es válida');
    expect(e.detail).toBe('La clave de API no es válida');
    expect(new GigaredAuthError().detail).toBeUndefined();
  });

  it('GigaredNotFoundError → code GIGARED_NOT_FOUND', () => {
    const e = new GigaredNotFoundError();
    expect(e.code).toBe('GIGARED_NOT_FOUND');
    expect(e.name).toBe('GigaredNotFoundError');
  });

  it('GigaredRejectedError → code GIGARED_REJECTED, carries title+detail', () => {
    const e = new GigaredRejectedError('Bad input', 'service_id is invalid');
    expect(e.code).toBe('GIGARED_REJECTED');
    expect(e.name).toBe('GigaredRejectedError');
    expect(e.title).toBe('Bad input');
    expect(e.detail).toBe('service_id is invalid');
  });

  it('TvCatalogMissingError → code TV_CATALOG_MISSING', () => {
    const e = new TvCatalogMissingError();
    expect(e.code).toBe('TV_CATALOG_MISSING');
    expect(e.name).toBe('TvCatalogMissingError');
  });

  it('CicNotFoundError → code CIC_NOT_FOUND (C2), is a DomainError', () => {
    const e = new CicNotFoundError('0000001234');
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('CIC_NOT_FOUND');
    expect(e.name).toBe('CicNotFoundError');
    expect(e.message).toContain('0000001234');
  });

  it('CicAlreadyLinkedError → code CIC_ALREADY_LINKED (C2), carries the conflicting internalId', () => {
    const e = new CicAlreadyLinkedError('0000001234', 'cust-OTHER');
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('CIC_ALREADY_LINKED');
    expect(e.name).toBe('CicAlreadyLinkedError');
    expect(e.linkedInternalId).toBe('cust-OTHER');
  });
});
