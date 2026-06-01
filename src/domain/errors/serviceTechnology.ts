import { DomainError } from './index';

export class ServiceTechnologyNotFoundError extends DomainError {
  constructor(id: string) {
    super(`ServiceTechnology with id ${id} not found`, 'SERVICE_TECHNOLOGY_NOT_FOUND');
    this.name = 'ServiceTechnologyNotFoundError';
  }
}

export class ServiceTechnologyNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A service technology named "${name}" already exists`, 'SERVICE_TECHNOLOGY_NAME_CONFLICT');
    this.name = 'ServiceTechnologyNameConflictError';
  }
}

export class ServiceTechnologyInUseError extends DomainError {
  constructor(public readonly serviceCount: number) {
    super(`ServiceTechnology is in use by ${serviceCount} service(s)`, 'SERVICE_TECHNOLOGY_IN_USE');
    this.name = 'ServiceTechnologyInUseError';
  }
}
