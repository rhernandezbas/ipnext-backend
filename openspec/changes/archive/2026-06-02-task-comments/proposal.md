# Proposal: Task Comments with Attachments (timeline)

## Intent

Add a comment timeline to `ScheduledTask`, allowing admins/technicians to leave notes and link file attachments (metadata) to a task. This enables a chronological activity/discussion thread on each task card.

## Scope

**In scope:**
- `TaskComment` model: id, taskId (FK→ScheduledTask CASCADE), authorName, body, createdAt
- `TaskCommentAttachment` model: id, commentId (FK→TaskComment CASCADE), url, filename, mimeType?, sizeBytes?
- Full hexagonal implementation: entity, port, in-memory adapter, Prisma adapter, use cases, routes
- Endpoints: `GET /:taskId/comments`, `POST /:taskId/comments`, `DELETE /comments/:commentId`

**Out of scope:**
- File upload/storage — no upload infra exists in the repo; attachments are by-URL metadata only (the frontend or a separate upload step provides the URL)
- Edit comment
- Reactions / thread replies

## Approach

Mirror `ClientComment` pattern for the base comment. Add `attachments[]` array to support metadata-only file references. Routes mounted at `/api/scheduling` (same prefix as existing scheduling routes), registered BEFORE the `/:id` catch-all to avoid routing conflicts.

## Attachment strategy

No `multer`, no S3, no upload infra found. Attachments are stored as `{ url, filename, mimeType?, sizeBytes? }`. The client provides the URL (e.g. from a CDN or blob storage handled outside this API).
