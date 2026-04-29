export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'proposal_sent' | 'won' | 'lost';
export type LeadSource = 'website' | 'referral' | 'cold_call' | 'social_media' | 'other';

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  source: LeadSource;
  status: LeadStatus;
  assignedTo: string;        // admin name
  assignedToId: string;
  interestedIn: string;      // e.g. "Plan Estándar 100Mbps"
  notes: string;
  followUpDate: string | null;
  createdAt: string;
  convertedAt: string | null;
  convertedClientId: string | null;
}
