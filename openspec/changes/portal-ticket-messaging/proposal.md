# Proposal: mensajería interna en los reclamos (cliente ↔ staff)

> v2.B del EPIC de la app de clientes. Cambio **coordinado en 3 repos**: backend (modelo +
> endpoints), frontend de Prominense (responder desde el ticket) y app mobile (el chat).

## Intent

Hoy un reclamo del portal es un **buzón de una sola vía**: el cliente escribe asunto y
descripción, y después no puede decir nada más ni enterarse de nada. El operador tampoco tiene
forma de responderle *dentro del sistema* — tiene que salir a WhatsApp o al teléfono, y esa
conversación se pierde fuera del ticket.

Convertir el reclamo en una **conversación** cliente↔staff, con el hilo viviendo **dentro del
ticket de Prominense** (donde el operador ya trabaja), y con **adjuntos de foto, audio y video**
—que en un reclamo de ISP valen más que mil palabras ("mirá cómo quedó el cable", el video del
módem parpadeando).

**Decisión del usuario (2026-07-31): mensajería PROPIA, NO Chatwoot** — *"no es whatsapp, sería
una mensajería interna"*. Chatwoot queda para lo que es: conversaciones de WhatsApp.

## Scope

### In Scope

**Backend** (`ipnext-backend`)
1. **`TicketComment` gana dos dimensiones** (migración aditiva): **autoría** (`client` | `staff`,
   con el id del autor cuando aplique) y **visibilidad** (`public` | `internal`).
2. **⚠️ Backfill decidido: TODO lo existente queda `internal` + `staff`.** Esos comentarios los
   escribió el equipo cuando nadie imaginaba que un cliente los leería; publicarlos de golpe
   sería exponer años de notas internas. El lado seguro es el silencio.
3. **Portal**: `GET /api/portal/tickets/:number/messages` (solo los `public` del ticket del
   cliente del token) y `POST` para que el cliente escriba, con rate limit y adjuntos.
4. **Admin**: el staff responde con `visibility` explícita — **responder al cliente** vs **nota
   interna**. El default NUNCA es público: se elige.
5. **No leídos**: marca de lectura por lado, para el badge de la app y el indicador del ticket.
6. **Adjuntos** sobre el `TicketCommentAttachment` que YA existe, guardados en el **MinIO ya
   configurado en prod**: imagen, audio y video, con límites de tamaño/tipo y URLs firmadas de
   vida corta (jamás un bucket público).

**Frontend Prominense** (`ipnext-frontend`)
7. Hilo conversacional en el detalle del ticket, con **distinción visual inequívoca** entre nota
   interna y mensaje al cliente (el error de mandar una nota interna al cliente tiene que ser
   *difícil de cometer*), reproductor de audio/video y visor de imágenes.

**App** (`ipnext-customer-app`)
8. El reclamo pasa de detalle estático a **chat**: burbujas, envío, adjuntar foto/audio/video,
   estados de envío y no-leídos.

### Out of Scope

- **Push notifications** (v2.C — deuda: requiere FCM/Firebase, pospuesto por el usuario). Sin
  push, el cliente ve las respuestas al abrir la app; el badge de no-leídos lo acompaña.
- Chatwoot / WhatsApp (explícitamente descartado como transporte de esto).
- Mensajería fuera de un ticket (no hay "chat suelto" con el ISP).
- Edición o borrado de mensajes ya enviados.

## Approach

Hexagonal como todo el repo: entidades y reglas de visibilidad en `domain/`, use cases por
archivo, adapters Prisma + in-memory, y las rutas separadas (portal vs admin) con sus guards.
**La invariante que gobierna el diseño**: un comentario `internal` NO PUEDE salir por la
superficie del portal — se filtra en el repositorio (WHERE), no en el mapper, y se prueba con
un test que falla si alguien invierte la condición.
