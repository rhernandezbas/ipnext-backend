export interface VoipCategory {
  id: string;
  name: string;
  prefix: string;
  pricePerMinute: number;
  freeMinutes: number;
  status: 'active' | 'inactive';
}

export interface VoipCdr {
  id: string;
  clientId: string;
  clientName: string;
  callerNumber: string;
  calledNumber: string;
  duration: number;
  categoryId: string;
  categoryName: string;
  cost: number;
  status: 'answered' | 'missed' | 'busy' | 'failed';
  startedAt: string;
}

export interface VoipPlan {
  id: string;
  name: string;
  monthlyPrice: number;
  includedMinutes: number;
  categories: string[];
  status: 'active' | 'inactive';
}
