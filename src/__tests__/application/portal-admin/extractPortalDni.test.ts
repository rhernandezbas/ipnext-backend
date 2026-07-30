/**
 * extractPortalDni — customer-portal-api (Fase 3, task 3.1).
 *
 * Pure parser: pulls the GR document number out of `Client.customAttributes`
 * (the raw GR client payload persisted verbatim — see GestionRealClient.ts
 * `parseClientsResponse`, key `documento`, string|number|null|"" in the wild).
 */
import { extractPortalDni } from '@domain/services/extractPortalDni';

describe('extractPortalDni', () => {
  it('returns the trimmed string when customAttributes.documento is a non-empty string', () => {
    expect(extractPortalDni({ documento: '17883799' })).toBe('17883799');
  });

  it('trims surrounding whitespace', () => {
    expect(extractPortalDni({ documento: '  17883799  ' })).toBe('17883799');
  });

  it('stringifies a numeric documento (GR raw payload is untyped JSON)', () => {
    expect(extractPortalDni({ documento: 17883799 })).toBe('17883799');
  });

  it('returns null when documento is an empty string', () => {
    expect(extractPortalDni({ documento: '' })).toBeNull();
  });

  it('returns null when documento is whitespace-only', () => {
    expect(extractPortalDni({ documento: '   ' })).toBeNull();
  });

  it('returns null when documento is null', () => {
    expect(extractPortalDni({ documento: null })).toBeNull();
  });

  it('returns null when documento key is absent', () => {
    expect(extractPortalDni({})).toBeNull();
  });

  it('returns null when customAttributes itself is null', () => {
    expect(extractPortalDni(null)).toBeNull();
  });

  it('returns null when customAttributes itself is undefined', () => {
    expect(extractPortalDni(undefined)).toBeNull();
  });

  it('returns null when customAttributes is not an object (defensive)', () => {
    expect(extractPortalDni('not-an-object')).toBeNull();
  });
});
