import { DomainError } from '@domain/errors';
import {
  ChatwootUnavailableError,
  ClientIdNotACandidateError,
  ConversationNotFoundError,
  MessagingWindowExpiredError,
} from '@domain/errors/messaging';

describe('ConversationNotFoundError', () => {
  it('sets code to CONVERSATION_NOT_FOUND', () => {
    expect(new ConversationNotFoundError('conv-1').code).toBe('CONVERSATION_NOT_FOUND');
  });

  it.each(['conv-1', 'conv-abc-99'])('interpolates the given id "%s" into the message', (id) => {
    expect(new ConversationNotFoundError(id).message).toBe(`Conversation with id "${id}" not found`);
  });

  it('sets name to ConversationNotFoundError', () => {
    expect(new ConversationNotFoundError('conv-1').name).toBe('ConversationNotFoundError');
  });

  it('is an instance of DomainError', () => {
    expect(new ConversationNotFoundError('conv-1')).toBeInstanceOf(DomainError);
  });
});

describe('MessagingWindowExpiredError', () => {
  it('sets code to MESSAGING_WINDOW_EXPIRED', () => {
    expect(new MessagingWindowExpiredError('conv-1').code).toBe('MESSAGING_WINDOW_EXPIRED');
  });

  it.each(['conv-1', 'conv-xyz-2'])('interpolates the given conversationId "%s" into the message', (id) => {
    expect(new MessagingWindowExpiredError(id).message).toBe(
      `Messaging window expired for conversation "${id}" (no inbound message within the last 24h)`,
    );
  });

  it('sets name to MessagingWindowExpiredError', () => {
    expect(new MessagingWindowExpiredError('conv-1').name).toBe('MessagingWindowExpiredError');
  });

  it('is an instance of DomainError', () => {
    expect(new MessagingWindowExpiredError('conv-1')).toBeInstanceOf(DomainError);
  });
});

describe('ChatwootUnavailableError', () => {
  it('sets code to CHATWOOT_UNAVAILABLE', () => {
    expect(new ChatwootUnavailableError().code).toBe('CHATWOOT_UNAVAILABLE');
  });

  it('defaults the message when none is given', () => {
    expect(new ChatwootUnavailableError().message).toBe('Chatwoot API is unavailable');
  });

  it('accepts a custom message (e.g. axios error detail)', () => {
    expect(new ChatwootUnavailableError('timeout after 5000ms').message).toBe('timeout after 5000ms');
  });

  it('sets name to ChatwootUnavailableError', () => {
    expect(new ChatwootUnavailableError().name).toBe('ChatwootUnavailableError');
  });

  it('is an instance of DomainError', () => {
    expect(new ChatwootUnavailableError()).toBeInstanceOf(DomainError);
  });
});

describe('ClientIdNotACandidateError', () => {
  it('sets code to CLIENT_ID_NOT_A_CANDIDATE', () => {
    expect(new ClientIdNotACandidateError('client-z', 'conv-1').code).toBe('CLIENT_ID_NOT_A_CANDIDATE');
  });

  it.each([
    ['client-z', 'conv-1'],
    ['client-abc-99', 'conv-xyz-2'],
  ])('interpolates the given clientId "%s" and conversationId "%s" into the message', (clientId, conversationId) => {
    expect(new ClientIdNotACandidateError(clientId, conversationId).message).toBe(
      `Client "${clientId}" is not a candidate for conversation "${conversationId}"`,
    );
  });

  it('sets name to ClientIdNotACandidateError', () => {
    expect(new ClientIdNotACandidateError('client-z', 'conv-1').name).toBe('ClientIdNotACandidateError');
  });

  it('is an instance of DomainError', () => {
    expect(new ClientIdNotACandidateError('client-z', 'conv-1')).toBeInstanceOf(DomainError);
  });
});
