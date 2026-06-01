# Proposal: IClass Closure → Auto-Comment + Inventory per Contract

## Intent

Cerrar el "closure loop" de IClass de punta a punta. Cuando una OS cierra, además del mirror que ya existe: ingestar **fotos + checklist + materiales** (API v2 estable + scraper del portal SEAM), postear un **comentario legible** en la tarea con lo que respondió el técnico, y proponer los **equipos (SN/MAC vía OCR) + materiales** como sugerencias de inventario que el operador **confirma manualmente**, asociándolos al **contrato (`Service`)** del cliente.

## Context (verificado en sesión, no asumido)

- El closure loop base YA existe: `IngestClosedServiceOrders`, `IClassServiceOrder` + sub-tablas, `IClassClosureScheduler` (flag `iclass-closure-loop`, default OFF).
- La **API v2** da el checklist estructurado (`pergunta`, `ordem`, `tipoPergunta` 1=Texto/5=Foto, `resposta`) pero **NO** las fotos (photo-blind confirmado).
- El **portal SEAM** (`fs2.iclass.com.br`) expone fotos del checklist (bucket `iclassfs-ipnx`) y firmas (`iclassfs-assinatura`) como **links S3 públicos** (HTTP 200, sin auth). Un **GET** a `baixa_os_validada.seam?osId=...&transicaoId=47` **NO muta el estado** (verificado contra OS de prueba 4646; status 17 antes y después).
- Correlación **foto ↔ respuesta por `ordem`** (posición), no por texto (los labels se repiten).
- **OCR local** `gemma3:12b` (Ollama) extrae SN/MAC **exacto** pero **solo con preprocesamiento** (rotar + recortar la etiqueta + upscale). Foto cruda → basura.
- **`Service`** es el contrato (`clientId` + `grContratoId`). `ScheduledTask.serviceId → Service` ya existe.
- `TaskComment` + `TaskCommentAttachment` ya soporta adjuntos (fotos).
- **No existe** `ServiceInstalledItem` ni un staging de inventario por tarea.

## Scope

**In scope (backend / este repo):**
- `photoUrl String?` en `IClassSoChecklistAnswer` (migración aditiva).
- `IClassPortalClient` (adapter nuevo): login al SEAM, `getOSDetailHTML(osId)`, `parseOSDetail(html)` → fotos por `ordem` + firma.
- `OcrExtraction` (modelo + pipeline): preprocesar imagen + `gemma3:12b` → SN/MAC + tipo + confidence.
- `TaskInventorySuggestion` (staging por tarea, una sugerencia por equipo, estados pending/confirmed/discarded).
- `ServiceInstalledItem` (confirmado, N por `Service`, **una fila por equipo físico**).
- Auto-comment legible en la tarea (Q&A de texto + fotos adjuntas), **idempotente**.
- Use cases: confirmar sugerencia → `ServiceInstalledItem`; agregar SN manual; descartar; listar.
- Endpoints REST bajo el prefijo existente.

**Out of scope:**
- **Frontend** — change coordinado aparte en `ipnext-frontend` (sección "Inventario" en task detail con checkboxes + "Equipos instalados" en el contrato/cliente, diseño `impeccable`).
- Descarga/mirroring de imágenes a storage propio — solo **referenciamos la URL S3**.
- Refactor de los inventory models legacy (`InventoryItem/Product/Unit`) — coexisten.
- Buscar una URL read-only del SEAM — innecesario, el GET es inofensivo.

## Locked decisions

1. **Contrato = `Service`** (el que tiene `grContratoId`).
2. **`ServiceInstalledItem` = una fila por equipo físico**, `serialNumber`/`mac` **singulares**, N por `Service`. 2 routers = 2 filas. NO array de seriales.
3. **Staging → confirmación manual.** Lo scrapeado/OCR nunca toca el contrato solo; el operador tilda y confirma.
4. **Auto-comment: automático al ingestar.** El inventario: requiere confirmación humana.
5. **Firmas: solo referenciar URL** (dato personal sensible).
6. **OCR: `gemma3:12b` local + preprocesamiento.** Soft-fail a revisión manual cuando la confianza es baja.

## Equipo vs material

- **Equipo** (ONU/ROUTER/ANTENA/REPETIDOR/OTROS): fila individual, `serialNumber` único, cantidad implícita 1, trackeado por SN.
- **Material** (UTP, RJ45…): consumible **sin SN**, con `quantity` + unidad. Viene de `IClassSoMaterial` + texto del checklist.
