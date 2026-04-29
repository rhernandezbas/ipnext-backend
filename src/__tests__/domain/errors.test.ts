import {
  DomainError,
  ClientNotFoundError,
  TicketNotFoundError,
  AuthenticationError,
  SplynxUnavailableError,
} from '../../domain/errors';

describe('Domain Errors', () => {
  describe('DomainError', () => {
    it('sets message and code', () => {
      const err = new DomainError('Something failed', 'SOME_CODE');
      expect(err.message).toBe('Something failed');
      expect(err.code).toBe('SOME_CODE');
      expect(err.name).toBe('DomainError');
    });

    it('is an instance of Error', () => {
      expect(new DomainError('msg', 'CODE')).toBeInstanceOf(Error);
    });
  });

  describe('ClientNotFoundError', () => {
    it('formats message with client id', () => {
      const err = new ClientNotFoundError('42');
      expect(err.message).toBe('Client with id 42 not found');
      expect(err.code).toBe('CLIENT_NOT_FOUND');
    });
  });

  describe('TicketNotFoundError', () => {
    it('formats message with ticket id', () => {
      const err = new TicketNotFoundError('99');
      expect(err.message).toBe('Ticket with id 99 not found');
      expect(err.code).toBe('TICKET_NOT_FOUND');
    });
  });

  describe('AuthenticationError', () => {
    it('uses default message', () => {
      const err = new AuthenticationError();
      expect(err.message).toBe('Authentication failed');
      expect(err.code).toBe('AUTHENTICATION_ERROR');
    });

    it('accepts custom message', () => {
      const err = new AuthenticationError('Token expired');
      expect(err.message).toBe('Token expired');
    });
  });

  describe('SplynxUnavailableError', () => {
    it('uses default message', () => {
      const err = new SplynxUnavailableError();
      expect(err.message).toBe('Splynx API is unavailable');
      expect(err.code).toBe('SPLYNX_UNAVAILABLE');
    });
  });
});
