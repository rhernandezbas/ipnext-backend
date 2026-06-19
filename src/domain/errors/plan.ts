import { DomainError } from './index';

export class PlanCodeTakenError extends DomainError {
  constructor(public readonly planCode: string) {
    super(`El plan con código '${planCode}' ya existe`, 'PLAN_CODE_TAKEN');
    this.name = 'PlanCodeTakenError';
  }
}

export class PlanNotFoundError extends DomainError {
  constructor(public readonly planId: string) {
    super(`Plan ${planId} not found`, 'PLAN_NOT_FOUND');
    this.name = 'PlanNotFoundError';
  }
}
