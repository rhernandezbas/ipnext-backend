/**
 * Ola 4 (inbox-Chatwoot) — respuestas rápidas / macros (canned responses) CRUD.
 * Tests de use case con el port in-memory (NUNCA se mockea Prisma — molde CLAUDE.md
 * "testear con adapters in-memory"). Cubre: normalización del shortcut a slug lowercase,
 * shortcut duplicado → ShortcutTaken, content vacío → ValidationError, listado ordenado,
 * búsqueda por q (shortcut y content), update, delete, NotFound.
 */
import { InMemoryCannedResponseRepository } from '@infrastructure/adapters/in-memory/InMemoryCannedResponseRepository';
import { CreateCannedResponse } from '@application/use-cases/messaging/CreateCannedResponse';
import { UpdateCannedResponse } from '@application/use-cases/messaging/UpdateCannedResponse';
import { DeleteCannedResponse } from '@application/use-cases/messaging/DeleteCannedResponse';
import { ListCannedResponses } from '@application/use-cases/messaging/ListCannedResponses';
import {
  ShortcutTakenError,
  CannedResponseNotFoundError,
  CannedResponseValidationError,
} from '@domain/errors/cannedResponses';

function build() {
  const repo = new InMemoryCannedResponseRepository();
  return {
    repo,
    create: new CreateCannedResponse(repo),
    update: new UpdateCannedResponse(repo),
    del: new DeleteCannedResponse(repo),
    list: new ListCannedResponses(repo),
  };
}

// ─── CreateCannedResponse ────────────────────────────────────────────────────
describe('CreateCannedResponse', () => {
  it('normaliza el shortcut a slug lowercase (mayúsculas + espacios → guiones)', async () => {
    const { create } = build();
    const dto = await create.execute({ shortcut: '  Saludo Cliente ', content: 'Hola, gracias por contactarte' });
    expect(dto.shortcut).toBe('saludo-cliente');
    expect(dto.content).toBe('Hola, gracias por contactarte');
    expect(dto.id).toBeTruthy();
    expect(typeof dto.createdAt).toBe('string');
    expect(typeof dto.updatedAt).toBe('string');
  });

  it('quita la barra inicial que el usuario podría tipear ("/saludo" → "saludo")', async () => {
    const { create } = build();
    const dto = await create.execute({ shortcut: '/Saludo', content: 'texto' });
    expect(dto.shortcut).toBe('saludo');
  });

  it('decodifica acentos/ñ a slug ASCII ("Señal Baja" → "senal-baja")', async () => {
    const { create } = build();
    const dto = await create.execute({ shortcut: 'Señal Baja', content: 'texto' });
    expect(dto.shortcut).toBe('senal-baja');
  });

  it('persiste createdById cuando se provee', async () => {
    const { create } = build();
    const dto = await create.execute({ shortcut: 'demora', content: 'texto', createdById: 'user-1' });
    expect(dto.createdById).toBe('user-1');
  });

  it('createdById es null si no se provee', async () => {
    const { create } = build();
    const dto = await create.execute({ shortcut: 'demora', content: 'texto' });
    expect(dto.createdById).toBeNull();
  });

  it('shortcut duplicado (aun con distinta caja/espacios) → ShortcutTakenError, no crea segundo', async () => {
    const { create, repo } = build();
    await create.execute({ shortcut: 'saludo', content: 'a' });
    await expect(create.execute({ shortcut: ' SALUDO ', content: 'b' })).rejects.toBeInstanceOf(ShortcutTakenError);
    expect(await repo.list()).toHaveLength(1);
  });

  it('content vacío (sólo espacios) → CannedResponseValidationError', async () => {
    const { create } = build();
    await expect(create.execute({ shortcut: 'saludo', content: '   ' })).rejects.toBeInstanceOf(
      CannedResponseValidationError,
    );
  });

  it('shortcut que normaliza a vacío ("///" / "!!!") → CannedResponseValidationError', async () => {
    const { create } = build();
    await expect(create.execute({ shortcut: '///', content: 'texto' })).rejects.toBeInstanceOf(
      CannedResponseValidationError,
    );
  });
});

// ─── ListCannedResponses ─────────────────────────────────────────────────────
describe('ListCannedResponses', () => {
  it('devuelve el catálogo ordenado por shortcut ASC', async () => {
    const { create, list } = build();
    await create.execute({ shortcut: 'zeta', content: 'z' });
    await create.execute({ shortcut: 'alfa', content: 'a' });
    await create.execute({ shortcut: 'media', content: 'm' });
    const all = await list.execute();
    expect(all.map((c) => c.shortcut)).toEqual(['alfa', 'media', 'zeta']);
  });

  it('?q= filtra por shortcut (case-insensitive substring)', async () => {
    const { create, list } = build();
    await create.execute({ shortcut: 'saludo', content: 'Hola' });
    await create.execute({ shortcut: 'despedida', content: 'Chau' });
    const res = await list.execute({ q: 'SAL' });
    expect(res.map((c) => c.shortcut)).toEqual(['saludo']);
  });

  it('?q= también matchea el content', async () => {
    const { create, list } = build();
    await create.execute({ shortcut: 'saludo', content: 'Gracias por contactarte' });
    await create.execute({ shortcut: 'despedida', content: 'Que tengas buen día' });
    const res = await list.execute({ q: 'gracias' });
    expect(res.map((c) => c.shortcut)).toEqual(['saludo']);
  });
});

// ─── UpdateCannedResponse ────────────────────────────────────────────────────
describe('UpdateCannedResponse', () => {
  it('actualiza content y renormaliza el shortcut', async () => {
    const { create, update } = build();
    const created = await create.execute({ shortcut: 'saludo', content: 'viejo' });
    const dto = await update.execute(created.id, { shortcut: 'Nuevo Saludo', content: 'nuevo texto' });
    expect(dto.shortcut).toBe('nuevo-saludo');
    expect(dto.content).toBe('nuevo texto');
  });

  it('update parcial (sólo content) preserva el shortcut', async () => {
    const { create, update } = build();
    const created = await create.execute({ shortcut: 'saludo', content: 'viejo' });
    const dto = await update.execute(created.id, { content: 'solo content' });
    expect(dto.shortcut).toBe('saludo');
    expect(dto.content).toBe('solo content');
  });

  it('renombrar a un shortcut ya tomado por OTRO → ShortcutTakenError', async () => {
    const { create, update } = build();
    await create.execute({ shortcut: 'saludo', content: 'a' });
    const otro = await create.execute({ shortcut: 'despedida', content: 'b' });
    await expect(update.execute(otro.id, { shortcut: 'saludo' })).rejects.toBeInstanceOf(ShortcutTakenError);
  });

  it('renombrar al MISMO shortcut (no cambia) es idempotente, no conflictúa', async () => {
    const { create, update } = build();
    const created = await create.execute({ shortcut: 'saludo', content: 'a' });
    const dto = await update.execute(created.id, { shortcut: 'SALUDO', content: 'b' });
    expect(dto.shortcut).toBe('saludo');
    expect(dto.content).toBe('b');
  });

  it('content vacío en update → CannedResponseValidationError', async () => {
    const { create, update } = build();
    const created = await create.execute({ shortcut: 'saludo', content: 'a' });
    await expect(update.execute(created.id, { content: '  ' })).rejects.toBeInstanceOf(CannedResponseValidationError);
  });

  it('id inexistente → CannedResponseNotFoundError', async () => {
    const { update } = build();
    await expect(update.execute('nope', { content: 'x' })).rejects.toBeInstanceOf(CannedResponseNotFoundError);
  });
});

// ─── DeleteCannedResponse ────────────────────────────────────────────────────
describe('DeleteCannedResponse', () => {
  it('borra la respuesta', async () => {
    const { create, del, repo } = build();
    const created = await create.execute({ shortcut: 'saludo', content: 'a' });
    await del.execute(created.id);
    expect(await repo.list()).toHaveLength(0);
  });

  it('id inexistente → CannedResponseNotFoundError', async () => {
    const { del } = build();
    await expect(del.execute('nope')).rejects.toBeInstanceOf(CannedResponseNotFoundError);
  });
});
