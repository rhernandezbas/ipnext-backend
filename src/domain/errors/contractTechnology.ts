import { DomainError } from './index';

export class ContractTechnologyNotFoundError extends DomainError {
  constructor(id: string) {
    super(`ContractTechnology with id ${id} not found`, 'CONTRACT_TECHNOLOGY_NOT_FOUND');
    this.name = 'ContractTechnologyNotFoundError';
  }
}

export class ContractTechnologyNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A contract technology named "${name}" already exists`, 'CONTRACT_TECHNOLOGY_NAME_CONFLICT');
    this.name = 'ContractTechnologyNameConflictError';
  }
}

export class ContractTechnologyInUseError extends DomainError {
  constructor(public readonly contractCount: number) {
    super(`ContractTechnology is in use by ${contractCount} contract(s)`, 'CONTRACT_TECHNOLOGY_IN_USE');
    this.name = 'ContractTechnologyInUseError';
  }
}
