import { AddTaskComment } from '@application/use-cases/AddTaskComment';
import { DeleteTaskComment } from '@application/use-cases/DeleteTaskComment';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

describe('AddTaskComment activity (D.5)', () => {
  it('emits commented + one attachment_added per attachment', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const recorder = new FakeTaskActivityRecorder();
    const uc = new AddTaskComment(repo, recorder);

    const comment = await uc.execute(
      {
        taskId: 'task-1',
        authorName: 'A',
        body: 'hi',
        attachments: [{ url: 'u1', filename: 'f1' }, { url: 'u2', filename: 'f2' }],
      },
      ACTOR,
    );

    expect(recorder.calls.map(c => c.type)).toEqual(['commented', 'attachment_added', 'attachment_added']);
    expect(recorder.calls[0]).toMatchObject({
      taskId: 'task-1',
      type: 'commented',
      payload: { actor: ACTOR, metadata: { commentId: comment.id } },
    });
    expect(recorder.calls[1].payload.metadata).toMatchObject({ commentId: comment.id });
  });

  it('emits only `commented` when there are no attachments', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const recorder = new FakeTaskActivityRecorder();
    const uc = new AddTaskComment(repo, recorder);

    await uc.execute({ taskId: 'task-1', authorName: 'A', body: 'hi', attachments: [] }, ACTOR);

    expect(recorder.calls.map(c => c.type)).toEqual(['commented']);
  });
});

describe('DeleteTaskComment activity (D.6)', () => {
  it('emits comment_deleted with the taskId resolved from the comment', async () => {
    const repo = new InMemoryTaskCommentRepository();
    await repo.create({ id: 'c1', taskId: 'task-9', authorName: 'A', body: 'x', createdAt: new Date('2026-06-03T10:00:00Z').toISOString(), attachments: [] });
    const recorder = new FakeTaskActivityRecorder();
    const uc = new DeleteTaskComment(repo, recorder);

    const deleted = await uc.execute('c1', ACTOR);

    expect(deleted).toBe(true);
    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-9',
        type: 'comment_deleted',
        payload: expect.objectContaining({ actor: ACTOR, metadata: { commentId: 'c1' } }),
      }),
    );
  });

  it('does not emit when the comment does not exist', async () => {
    const repo = new InMemoryTaskCommentRepository();
    const recorder = new FakeTaskActivityRecorder();
    const uc = new DeleteTaskComment(repo, recorder);

    const deleted = await uc.execute('ghost', ACTOR);

    expect(deleted).toBe(false);
    expect(recorder.calls).toHaveLength(0);
  });
});
