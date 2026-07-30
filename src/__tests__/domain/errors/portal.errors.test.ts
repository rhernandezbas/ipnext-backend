import {
  PortalAccountNotFoundError,
  InvalidPortalCredentialsError,
  InvalidPortalRefreshTokenError,
  PortalRefreshTokenReusedError,
  InvalidCurrentPortalPasswordError,
  PortalPasswordTooShortError,
} from '@domain/errors/portal.errors';
import { DomainError } from '@domain/errors';

describe('portal domain errors', () => {
  it('PortalAccountNotFoundError carries the id and a stable code', () => {
    const err = new PortalAccountNotFoundError('acc-1');
    expect(err).toBeInstanceOf(DomainError);
    expect(err.name).toBe('PortalAccountNotFoundError');
    expect(err.code).toBe('PORTAL_ACCOUNT_NOT_FOUND');
    expect(err.message).toContain('acc-1');
  });

  it('InvalidPortalCredentialsError is the SAME shape regardless of the caller (anti-enumeration)', () => {
    const err = new InvalidPortalCredentialsError();
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('INVALID_PORTAL_CREDENTIALS');
  });

  it('InvalidPortalRefreshTokenError has a stable code', () => {
    const err = new InvalidPortalRefreshTokenError();
    expect(err.code).toBe('INVALID_PORTAL_REFRESH_TOKEN');
  });

  it('PortalRefreshTokenReusedError has a stable code distinct from InvalidPortalRefreshTokenError', () => {
    const err = new PortalRefreshTokenReusedError();
    expect(err.code).toBe('PORTAL_REFRESH_TOKEN_REUSED');
    expect(err.code).not.toBe(new InvalidPortalRefreshTokenError().code);
  });

  it('InvalidCurrentPortalPasswordError has a stable code', () => {
    expect(new InvalidCurrentPortalPasswordError().code).toBe('INVALID_CURRENT_PORTAL_PASSWORD');
  });

  it('PortalPasswordTooShortError has a stable code', () => {
    expect(new PortalPasswordTooShortError().code).toBe('PORTAL_PASSWORD_TOO_SHORT');
  });
});
