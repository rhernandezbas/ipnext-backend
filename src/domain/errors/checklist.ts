import { DomainError } from './index';

export class ChecklistItemNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Checklist item with id ${id} not found`, 'CHECKLIST_ITEM_NOT_FOUND');
    this.name = 'ChecklistItemNotFoundError';
  }
}

export class TemplateItemNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Template item with id ${id} not found`, 'TEMPLATE_ITEM_NOT_FOUND');
    this.name = 'TemplateItemNotFoundError';
  }
}

export class OrderingError extends DomainError {
  constructor(message: string) {
    super(message, 'ORDERING_ERROR');
    this.name = 'OrderingError';
  }
}

export class TemplateNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Template with id ${id} not found`, 'TEMPLATE_NOT_FOUND');
    this.name = 'TemplateNotFoundError';
  }
}
