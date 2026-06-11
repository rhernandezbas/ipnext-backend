export interface TicketCommentAttachment {
  id: string;
  commentId: string;
  url: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  authorName: string;
  body: string;
  createdAt: string;
  attachments: TicketCommentAttachment[];
}
