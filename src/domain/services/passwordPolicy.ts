/**
 * Password policy (SDD #6a). Pure domain rule applied when a NEW password is set
 * (create user / change password) — never on login or to existing passwords.
 */
import { PasswordPolicyError } from '@domain/errors/rbacUser.errors';

export const PASSWORD_RULES = {
  minLength: 10,
  requireLetter: true,
  requireDigit: true,
};

/** Throws PasswordPolicyError listing every failed rule. */
export function validatePassword(plain: string): void {
  const reasons: string[] = [];
  if (plain.length < PASSWORD_RULES.minLength) {
    reasons.push(`al menos ${PASSWORD_RULES.minLength} caracteres`);
  }
  if (PASSWORD_RULES.requireLetter && !/[a-zA-Z]/.test(plain)) {
    reasons.push('al menos una letra');
  }
  if (PASSWORD_RULES.requireDigit && !/[0-9]/.test(plain)) {
    reasons.push('al menos un número');
  }
  if (reasons.length > 0) {
    throw new PasswordPolicyError(reasons);
  }
}
