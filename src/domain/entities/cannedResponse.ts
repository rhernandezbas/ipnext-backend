/**
 * Ola 4 (inbox-Chatwoot) — respuestas rápidas / macros (canned responses).
 *
 * Atajos de texto reutilizables para el composer del inbox (ej `/saludo` → "Hola,
 * gracias por contactarte..."). `shortcut` es un slug lowercase ÚNICO (sin la barra);
 * `content` es texto plano (v1 — las variables tipo {{nombre}} quedan para futuro,
 * hoy se guardan verbatim). El BE sólo provee el catálogo CRUD: el envío NO cambia
 * (el FE inserta `content` en el textarea y usa el POST /messages normal).
 */
export interface CannedResponse {
  id: string;
  shortcut: string;
  content: string;
  /** FK soft al RbacUser autor (SetNull → borrar el usuario NO borra la respuesta). */
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
