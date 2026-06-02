# Spec: IClass Closure Photos + Auto-Comment

## Capability: scrape-os-photos

`IClassPortalPort.parseOSDetail(osId)` → secciones de la página de cierre del portal SEAM.

- Login persistente al portal (`ICLASS_PORTAL_USER` / `ICLASS_PORTAL_PASSWORD`), cookie cacheada, re-login transparente al expirar.
- GET a `restrict/baixa_os_validada.seam?osId={iclassId}&transicaoId=47&...` (read-only de hecho; **nunca** se hace submit de "Terminar OS").
- **Scope obligatorio**: las preguntas se extraen SOLO del panel "Encuesta". El form tiene `div.prop` fuera de la encuesta (5 vacíos + cabecera de Cierre: Motivo/Responsable/Relación) que NO deben contarse, o se desalinea el `ordem`.
- Devuelve por cada pregunta de la "Encuesta": `{ ordem, kind: 'text'|'choice'|'photo', photoUrl?, fileName?, photoMissing }`.
- Devuelve los adjuntos de "Adjuntos": `{ url, label }` (incluye la firma).
- **SCEN-SC-1**: pregunta con link "Imagen" → `kind:'photo'`, `photoUrl` = URL S3.
- **SCEN-SC-2**: pregunta foto con "No Disponible" → `kind:'photo'`, `photoMissing:true`, `photoUrl:null`.
- **SCEN-SC-3**: el parser sobre un HTML sin la sección "Encuesta" → devuelve lista vacía, **no lanza**.
- **SCEN-SC-4**: pregunta con `<select>` → `kind:'choice'`. NO se confunde con texto ni foto.
- **SCEN-SC-5**: los `div.prop` de la cabecera (Motivo/Responsable/Relación) y los vacíos quedan EXCLUIDOS del conteo de preguntas de la encuesta (verificado: el `ordem` de la API arranca en la 1ª pregunta de la encuesta, no en Motivo).

## Capability: correlate-photos-by-ordem

Al ingestar, por cada `IClassSoChecklistAnswer` con `questionType` Foto, se setea `photoUrl` con la foto del SEAM en el **mismo `ordem`**.

- **SCEN-CO-1**: API ordem 3 = "FOTO ROUTER" (Foto) ↔ foto SEAM en posición 3 → `answer.photoUrl` queda con esa URL.
- **SCEN-CO-2**: labels repetidos (varias "ADJUNTAR FOTO…") se desambiguan por `ordem`, no por texto.
- **SCEN-CO-3**: si el SEAM no responde (caído/rate-limit), la ingesta del resto NO falla; `photoUrl` queda null y se reintenta en el próximo ciclo.

## Capability: post-closure-comment

`PostClosureComment` postea un `TaskComment` legible cuando una OS cerrada matchea una task.

- Autor: `"Sistema IClass"`.
- Body legible: resumen de las respuestas de **texto** del checklist (`pregunta: respuesta`), motivo de cierre, técnico, observaciones.
- Las fotos del checklist + firma se adjuntan como `TaskCommentAttachment[]` (por URL, sin descargar).
- **SCEN-PC-1**: OS cerrada con checklist de texto → se crea 1 comment con el resumen formateado y los attachments de fotos.
- **SCEN-PC-2 (idempotencia)**: re-ingestar la misma OS → NO crea un segundo comment (guard por OS + autor sistema).
- **SCEN-PC-3**: OS sin respuestas de texto → comment mínimo con motivo/técnico; no falla.

## Domain model (additions)

```typescript
interface IClassSoChecklistAnswer {
  // ...existente...
  photoUrl: string | null; // NUEVO
}

interface ScrapedOSDetail {
  questions: { ordem: number; kind: 'text' | 'photo'; photoUrl?: string; fileName?: string; photoMissing: boolean }[];
  attachments: { url: string; label: string }[];
}
```

## Port

```typescript
interface IClassPortalPort {
  parseOSDetail(osId: string): Promise<ScrapedOSDetail>;
}
```
