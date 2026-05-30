/**
 * SDD #6a Phase 4 — password policy.
 */
import { validatePassword } from '@domain/services/passwordPolicy';
import { PasswordPolicyError } from '@domain/errors/rbacUser.errors';

describe('validatePassword', () => {
  it('accepts a strong password (≥10, letter + digit)', () => {
    expect(() => validatePassword('Segura1234')).not.toThrow();
  });

  it('rejects a too-short password', () => {
    expect(() => validatePassword('Ab1')).toThrow(PasswordPolicyError);
  });

  it('rejects a password with no digit', () => {
    expect(() => validatePassword('sololetras')).toThrow(PasswordPolicyError);
  });

  it('rejects a password with no letter', () => {
    expect(() => validatePassword('1234567890')).toThrow(PasswordPolicyError);
  });
});
