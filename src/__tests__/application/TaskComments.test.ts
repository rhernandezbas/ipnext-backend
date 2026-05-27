import { AddTaskComment } from '../../application/use-cases/AddTaskComment';
import { ListTaskComments } from '../../application/use-cases/ListTaskComments';
import { DeleteTaskComment } from '../../application/use-cases/DeleteTaskComment';
import { InMemoryTaskCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';

describe('ListTaskComments', () => {
  it('returns empty array for a task with no comments', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const uc = new ListTaskComments(repo);

    const result = await uc.execute('task-1');

    expect(result).toEqual([]);
  });

  it('returns comments after AddTaskComment', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const add = new AddTaskComment(repo);
    const list = new ListTaskComments(repo);

    await add.execute({ taskId: 'task-1', authorName: 'Admin', body: 'First comment', attachments: [] });
    const result = await list.execute('task-1');

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('First comment');
    expect(result[0].authorName).toBe('Admin');
    expect(result[0].taskId).toBe('task-1');
  });
});

describe('AddTaskComment', () => {
  it('assigns an id and createdAt to the new comment', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const uc = new AddTaskComment(repo);

    const comment = await uc.execute({ taskId: 'task-2', authorName: 'Support', body: 'Test body', attachments: [] });

    expect(comment.id).toBeTruthy();
    expect(comment.createdAt).toBeTruthy();
    expect(new Date(comment.createdAt).toString()).not.toBe('Invalid Date');
    expect(comment.taskId).toBe('task-2');
    expect(comment.body).toBe('Test body');
    expect(comment.authorName).toBe('Support');
    expect(comment.attachments).toEqual([]);
  });

  it('stores attachments with the comment', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const uc = new AddTaskComment(repo);

    const comment = await uc.execute({
      taskId: 'task-3',
      authorName: 'Tech',
      body: 'With attachment',
      attachments: [{ url: 'https://cdn.example.com/file.pdf', filename: 'file.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }],
    });

    expect(comment.attachments).toHaveLength(1);
    expect(comment.attachments[0].url).toBe('https://cdn.example.com/file.pdf');
    expect(comment.attachments[0].filename).toBe('file.pdf');
    expect(comment.attachments[0].mimeType).toBe('application/pdf');
    expect(comment.attachments[0].sizeBytes).toBe(1024);
  });
});

describe('DeleteTaskComment', () => {
  it('returns true when the comment exists and deletes it', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const add = new AddTaskComment(repo);
    const del = new DeleteTaskComment(repo);
    const list = new ListTaskComments(repo);

    const comment = await add.execute({ taskId: 'task-4', authorName: 'Admin', body: 'To delete', attachments: [] });
    const deleted = await del.execute(comment.id);

    expect(deleted).toBe(true);
    const remaining = await list.execute('task-4');
    expect(remaining).toHaveLength(0);
  });

  it('returns false when the comment does not exist', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const del = new DeleteTaskComment(repo);

    const result = await del.execute('nonexistent-id');

    expect(result).toBe(false);
  });
});
