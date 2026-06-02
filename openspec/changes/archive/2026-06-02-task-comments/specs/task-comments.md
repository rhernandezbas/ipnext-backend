# Spec: Task Comments

## Capability: list-task-comments

**GET /api/scheduling/:taskId/comments**

- Returns `TaskComment[]` ordered by `createdAt ASC`
- Empty array when task has no comments
- Each comment includes `attachments: TaskCommentAttachment[]`
- No auth guard (mirrors clientComments.routes.ts pattern)

## Capability: add-task-comment

**POST /api/scheduling/:taskId/comments**

Request body:
```json
{
  "body": "string (required)",
  "authorName": "string (required)",
  "attachments": [
    {
      "url": "string (required)",
      "filename": "string (required)",
      "mimeType": "string (optional)",
      "sizeBytes": "number (optional)"
    }
  ]
}
```

- Returns `201` with the created `TaskComment` (including `id`, `taskId`, `createdAt`, `attachments[]`)
- `attachments` defaults to `[]` if omitted

## Capability: delete-task-comment

**DELETE /api/scheduling/comments/:commentId**

- Returns `204` on success
- Returns `404` with `{ error, code: "TASK_COMMENT_NOT_FOUND" }` if not found

## Domain model

```typescript
interface TaskCommentAttachment {
  id: string;
  commentId: string;
  url: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

interface TaskComment {
  id: string;
  taskId: string;
  authorName: string;
  body: string;
  createdAt: string; // ISO 8601
  attachments: TaskCommentAttachment[];
}
```

## Port

```typescript
interface TaskCommentRepository {
  listByTask(taskId: string): Promise<TaskComment[]>;
  create(comment: TaskComment): Promise<TaskComment>;
  delete(commentId: string): Promise<boolean>;
}
```
