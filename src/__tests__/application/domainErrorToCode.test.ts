/**
 * TDD — domainErrorToCode (task-bulk-send-to-iclass, AD-4)
 * Shared mapping domain error -> { errorCode, reason?, missingFields? }.
 * Used by both the bulk use-case (results[i]) and errorHandler (HTTP).
 */
import { domainErrorToCode } from '../../application/util/domainErrorToCode';
import { MissingRequiredFieldsError, TaskNotFoundError, StageNotFoundError } from '../../domain/errors/scheduling';
import { IClassNodeNotFoundError, IClassRejectedError, IClassUnavailableError } from '../../domain/errors/iclass';

describe('domainErrorToCode', () => {
  it('maps MissingRequiredFieldsError with missingFields', () => {
    expect(domainErrorToCode(new MissingRequiredFieldsError(['phone', 'city']))).toEqual({
      errorCode: 'MISSING_REQUIRED_FIELDS',
      missingFields: ['phone', 'city'],
    });
  });

  it('maps IClassNodeNotFoundError', () => {
    expect(domainErrorToCode(new IClassNodeNotFoundError('Rosario'))).toEqual({
      errorCode: 'ICLASS_NODE_NOT_FOUND',
    });
  });

  it('maps IClassRejectedError with reason (detail)', () => {
    expect(domainErrorToCode(new IClassRejectedError('ICLERR_0045: too long'))).toEqual({
      errorCode: 'ICLASS_REJECTED',
      reason: 'ICLERR_0045: too long',
    });
  });

  it('maps IClassUnavailableError', () => {
    expect(domainErrorToCode(new IClassUnavailableError())).toEqual({
      errorCode: 'ICLASS_UNAVAILABLE',
    });
  });

  it('maps TaskNotFoundError', () => {
    expect(domainErrorToCode(new TaskNotFoundError('t1'))).toEqual({ errorCode: 'TASK_NOT_FOUND' });
  });

  it('maps StageNotFoundError', () => {
    expect(domainErrorToCode(new StageNotFoundError('s1'))).toEqual({ errorCode: 'STAGE_NOT_FOUND' });
  });

  it('returns the DomainError code for any other domain error', () => {
    expect(domainErrorToCode(new StageNotFoundError('s1'))).toHaveProperty('errorCode');
  });

  it('returns null for a non-domain (unknown) error', () => {
    expect(domainErrorToCode(new Error('boom'))).toBeNull();
  });
});
