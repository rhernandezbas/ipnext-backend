# Tech Closure Evidence Specification (Wave 3)

## Purpose

Fotos/firma de cierre subidas desde la app, reusando `MinioFileStorage` (`src/infrastructure/adapters/minio/MinioFileStorage.ts`) + `ScheduledTaskAttachment` (`schema.prisma:1636-1650`) + el use case `AttachPhotosToTask.ts` — YA implementado y en uso para fotos de tarea desde el panel admin (`taskAttachments.routes.ts`, montado en `/api/scheduling`). Cero storage nuevo; el trabajo es una superficie `/api/tech/*` que reusa las MISMAS reglas de negocio (validación de mimetype por magic bytes, tope de 15 adjuntos/tarea, anti decompression-bomb, atomicidad del lote) con el auth y el scoping de técnico.

`/api/scheduling/attachments/:id/file` (staff) NO sirve para la app: un token `aud='tech'` es rechazado ahí por el guard cruzado (`tech-api-auth`). Se necesita una ruta de servir-archivo espejo bajo `/api/tech/*`.

## Requirements

### Requirement: Evidence upload is scoped to the technician's own assigned task

El sistema DEBE (MUST) rechazar `POST /api/tech/tasks/:id/evidence` con `404 TASK_NOT_FOUND` si la tarea no existe O `assigneeId !== req.technicianId` (mismo criterio anti-IDOR que `tech-tasks-worklist`).

#### Scenario: Uploading evidence to a foreign task is 404
- GIVEN la tarea `t-2` asignada a `tech-B`
- WHEN `tech-A` hace `POST /api/tech/tasks/t-2/evidence` con una foto
- THEN `404 { code: 'TASK_NOT_FOUND' }`

### Requirement: The same validation rules as the staff upload apply

El sistema DEBE (MUST) reusar EXACTAMENTE las reglas de `AttachPhotosToTask` (`AttachPhotosToTask.ts:19-27`): solo `image/jpeg`, `image/png`, `image/webp`; verificación por magic bytes (no confiar en el `Content-Type` declarado); tope `MAX_ATTACHMENTS_PER_TASK=15` por tarea; tope de 50 megapíxeles anti decompression-bomb; escritura atómica del lote (todo o nada, con compensación si falla a mitad de camino).

#### Scenario: An unsupported file type is rejected
- GIVEN el técnico sube un `.gif` declarado como `image/png`
- WHEN se procesa
- THEN `415 { code: 'UNSUPPORTED_ATTACHMENT_TYPE' }` (magic bytes no coincide)

#### Scenario: The per-task cap is enforced across staff and app uploads
- GIVEN la tarea `t-1` ya tiene 15 adjuntos (subidos desde el panel admin O desde la app, sin distinción)
- WHEN el técnico intenta subir una foto más
- THEN `422 { code: 'TOO_MANY_ATTACHMENTS' }`

### Requirement: Storage unavailability degrades explicitly, never breaks the boot

El sistema DEBE (MUST) responder `503 STORAGE_NOT_CONFIGURED` (mismo `StorageNotConfiguredError`, `src/domain/errors/taskAttachment.ts:61`) si `MINIO_*` no está configurado — el servidor sigue arrancando, solo esta feature degrada.

#### Scenario: Missing MinIO config is a clean 503
- GIVEN `MINIO_*` no está configurado en el entorno
- WHEN el técnico intenta subir evidencia
- THEN `503 { code: 'STORAGE_NOT_CONFIGURED' }`, ninguna otra ruta de `/api/tech/*` se ve afectada

## HTTP Contract

### POST /api/tech/tasks/:id/evidence
Headers: `Authorization: Bearer <accessToken>`, `Content-Type: multipart/form-data`
Body: campo `photos` (1 a 15 archivos), límite 10 MiB/archivo (mismo límite que `taskAttachments.routes.ts:18`)
Response `201`: `TechAttachmentDto[]`
```ts
interface TechAttachmentDto {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedById: string;    // req.technicianId
  createdAt: string;
  fileUrl: string;   // '/api/tech/tasks/attachments/{id}/file'  — NUEVA base, distinta de la staff
  thumbUrl: string;  // '/api/tech/tasks/attachments/{id}/file?variant=thumb'
}
```
Errors:
| Status | code |
|---|---|
| 400 | `NO_FILES` (campo `photos` vacío) |
| 400 | `TOO_MANY_FILES` / `UPLOAD_ERROR` (multer) |
| 404 | `TASK_NOT_FOUND` |
| 413 | `FILE_TOO_LARGE` |
| 415 | `UNSUPPORTED_ATTACHMENT_TYPE` |
| 422 | `TOO_MANY_ATTACHMENTS` |
| 422 | `IMAGE_TOO_LARGE` |
| 503 | `STORAGE_NOT_CONFIGURED` |

### GET /api/tech/tasks/:id/evidence
Response `200`: `{ data: TechAttachmentDto[] }` — scoped igual que arriba (404 si la tarea no es del técnico).

### GET /api/tech/tasks/attachments/:id/file?variant=thumb|original
Response: binario (`Content-Type` original, `Content-Disposition: inline`). Errors: `404 { code: 'ATTACHMENT_NOT_FOUND' }` (incluye el caso "existe pero es de una tarea de otro técnico" — indistinguible).

**Decisión v1 (cerrada, no incógnita): la firma es una foto más.** `ScheduledTaskAttachment` (`schema.prisma:1636-1650`) NO tiene una columna `kind`/tipo hoy — todo adjunto es indiferenciado. `design.md` Decision 6 cierra esto para v1: la firma del cliente se sube por el MISMO endpoint `POST /api/tech/tasks/:id/evidence`, con las MISMAS reglas de validación que una foto, distinguida únicamente por convención de `filename` (`signature.png`) — no hay modelo nuevo ni columna `kind`. **Deuda anotada**: si en el futuro se necesita distinguir firma de foto en la galería o en reportes, requiere una columna nueva — está deliberadamente fuera de esta wave.

**NO VERIFICADO CONTRA CÓDIGO — decisión nueva de superficie, no de dato:**
- Ruta `GET /api/tech/tasks/attachments/:id/file` es NUEVA — no existe hoy ningún endpoint de servir-archivo bajo `/api/tech/*` (el existente, `taskAttachments.routes.ts:112`, está montado en `/api/scheduling` y usa `createAuthMiddleware` de staff, no accesible con `aud='tech'`).

## Aditivo, solo-crece
Superficie nueva completa; no modifica el endpoint staff existente.
