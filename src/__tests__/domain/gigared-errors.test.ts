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
  TvPoolPoisonedError,
  TvIdentityStampUnverifiedError,
  TvEmailOwnedByOtherError,
  TvPoolUnavailableError,
  TvNoUsableCicError,
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

  // B1 — D-pool: anti-envenenamiento del pool (root cause del incidente Centeno/Vacherand).
  it('TvPoolPoisonedError → code TV_POOL_POISONED, carries poisonedCount', () => {
    const e = new TvPoolPoisonedError(3);
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('TV_POOL_POISONED');
    expect(e.name).toBe('TvPoolPoisonedError');
    expect(e.poisonedCount).toBe(3);
  });

  it('TvIdentityStampUnverifiedError → code TV_IDENTITY_UNVERIFIED, carries cic + internalId', () => {
    const e = new TvIdentityStampUnverifiedError('0000001234', 'cust-1');
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('TV_IDENTITY_UNVERIFIED');
    expect(e.name).toBe('TvIdentityStampUnverifiedError');
    expect(e.cic).toBe('0000001234');
    expect(e.internalId).toBe('cust-1');
  });

  // B2 — D2: recovery/probe idempotente — el email determinístico ya pertenece a OTRO customer.
  it('TvEmailOwnedByOtherError → code TV_EMAIL_OWNED_BY_OTHER, carries email + ownedByInternalId', () => {
    const e = new TvEmailOwnedByOtherError('perez204382@gmail.com', 'cust-OTHER');
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('TV_EMAIL_OWNED_BY_OTHER');
    expect(e.name).toBe('TvEmailOwnedByOtherError');
    expect(e.email).toBe('perez204382@gmail.com');
    expect(e.ownedByInternalId).toBe('cust-OTHER');
  });

  // gigared-tv-cic-reuse (T3.1) — el listado del pool falló. Es una condición TRANSITORIA
  // (el partner no respondió), no de datos: 503 reintentable, jamás un 404 "account not found".
  it('TvPoolUnavailableError → code TV_POOL_UNAVAILABLE, preserva la causa', () => {
    const e = new TvPoolUnavailableError('timeout');
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('TV_POOL_UNAVAILABLE');
    expect(e.name).toBe('TvPoolUnavailableError');
    expect(e.detail).toBe('timeout');
  });

  it('TvPoolUnavailableError sin detail → detail undefined (no inventa texto)', () => {
    expect(new TvPoolUnavailableError().detail).toBeUndefined();
  });

  // gigared-tv-cic-reuse (T3.1) — se agotaron los candidatos del reintento acotado. Es una
  // condición de DATOS (los CICs del pool no sirven), no transitoria → 422.
  it('TvNoUsableCicError → code TV_NO_USABLE_CIC, carries attemptedCount', () => {
    const e = new TvNoUsableCicError(3);
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('TV_NO_USABLE_CIC');
    expect(e.name).toBe('TvNoUsableCicError');
    expect(e.attemptedCount).toBe(3);
  });
});
