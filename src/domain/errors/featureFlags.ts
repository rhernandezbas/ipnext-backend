import { DomainError } from './index';

export class FeatureFlagNotFoundError extends DomainError {
  constructor(key: string) {
    super(`Feature flag "${key}" not found`, 'FLAG_NOT_FOUND');
    this.name = 'FeatureFlagNotFoundError';
  }
}
