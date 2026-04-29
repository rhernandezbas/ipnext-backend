import { GetClientComments } from '../../application/use-cases/GetClientComments';
import { CreateClientComment } from '../../application/use-cases/CreateClientComment';
import { InMemoryClientCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryClientCommentRepository';

describe('GetClientComments', () => {
  it('returns empty array for a client with no comments', async () => {
    const repo = new InMemoryClientCommentRepository();
    const uc = new GetClientComments(repo);

    const result = await uc.execute('client-1');

    expect(result).toEqual([]);
  });

  it('returns comments after CreateClientComment', async () => {
    const repo = new InMemoryClientCommentRepository();
    const create = new CreateClientComment(repo);
    const get = new GetClientComments(repo);

    await create.execute('client-1', 'Hello world', 'Admin');
    const result = await get.execute('client-1');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Hello world');
    expect(result[0].authorName).toBe('Admin');
    expect(result[0].clientId).toBe('client-1');
  });
});

describe('CreateClientComment', () => {
  it('assigns an id and createdAt to the new comment', async () => {
    const repo = new InMemoryClientCommentRepository();
    const uc = new CreateClientComment(repo);

    const comment = await uc.execute('client-2', 'Test content', 'Support');

    expect(comment.id).toBeTruthy();
    expect(comment.createdAt).toBeTruthy();
    expect(new Date(comment.createdAt).toString()).not.toBe('Invalid Date');
    expect(comment.clientId).toBe('client-2');
    expect(comment.content).toBe('Test content');
    expect(comment.authorName).toBe('Support');
  });
});
