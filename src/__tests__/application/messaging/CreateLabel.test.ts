/**
 * conversation-labels (Ola 5) — CreateLabel: crea una etiqueta del catálogo.
 * Gate messaging:manage (a nivel ruta). Conflicto de nombre case-insensitive
 * (clon de CreateTicketArea).
 */
import { CreateLabel } from '@application/use-cases/messaging/CreateLabel';
import { ConversationLabelNameConflictError } from '@domain/errors/messaging';
import { InMemoryConversationLabelRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationLabelRepository';

describe('CreateLabel', () => {
  let repo: InMemoryConversationLabelRepository;
  let createLabel: CreateLabel;

  beforeEach(() => {
    repo = new InMemoryConversationLabelRepository();
    createLabel = new CreateLabel(repo);
  });

  it('crea la label y la devuelve con id', async () => {
    const label = await createLabel.execute({ name: 'Urgente', color: '#ef4444' });
    expect(label.id).toBeTruthy();
    expect(label.name).toBe('Urgente');
  });

  it('persiste el color', async () => {
    const label = await createLabel.execute({ name: 'Ventas', color: '#22c55e' });
    expect(label.color).toBe('#22c55e');
  });

  it('nombre duplicado → ConversationLabelNameConflictError (409)', async () => {
    await createLabel.execute({ name: 'Urgente', color: '#ef4444' });
    await expect(createLabel.execute({ name: 'Urgente', color: '#000000' })).rejects.toBeInstanceOf(
      ConversationLabelNameConflictError,
    );
  });

  it('el chequeo de nombre es case-insensitive', async () => {
    await createLabel.execute({ name: 'Urgente', color: '#ef4444' });
    await expect(createLabel.execute({ name: 'urgente', color: '#000000' })).rejects.toBeInstanceOf(
      ConversationLabelNameConflictError,
    );
  });
});
