export type MessageStatus = 'unread' | 'read' | 'sent' | 'draft';
export type MessageChannel = 'internal' | 'email' | 'sms';

export interface Message {
  id: string;
  subject: string;
  body: string;
  fromId: string;
  fromName: string;
  toId: string | null;       // null = broadcast
  toName: string | null;
  clientId: string | null;
  channel: MessageChannel;
  status: MessageStatus;
  sentAt: string | null;
  createdAt: string;
  threadId: string | null;   // for replies
}
