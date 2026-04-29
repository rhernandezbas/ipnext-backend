// Shared in-memory data that multiple route modules can read/write
// This is the single source of truth for client and ticket counts

export const sharedClientStore = {
  // Count of seeded active clients (from the seeded data in clients.routes.ts)
  // We maintain a counter here that routes increment/decrement
  activeCount: 12,
  totalCount: 15,
  newThisMonth: 3,
};

export const sharedTicketStore = {
  openCount: 8,
  pendingCount: 4,
};

export function incrementClients() {
  sharedClientStore.totalCount++;
  sharedClientStore.activeCount++;
  sharedClientStore.newThisMonth++;
}

export function decrementClients() {
  sharedClientStore.totalCount = Math.max(0, sharedClientStore.totalCount - 1);
  sharedClientStore.activeCount = Math.max(0, sharedClientStore.activeCount - 1);
}

export function incrementTickets(status: 'open' | 'pending') {
  if (status === 'open') sharedTicketStore.openCount++;
  else sharedTicketStore.pendingCount++;
}

export function decrementTickets(status: 'open' | 'pending') {
  if (status === 'open') sharedTicketStore.openCount = Math.max(0, sharedTicketStore.openCount - 1);
  else sharedTicketStore.pendingCount = Math.max(0, sharedTicketStore.pendingCount - 1);
}
