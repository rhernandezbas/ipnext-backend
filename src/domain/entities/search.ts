export type SearchResultType = 'client' | 'ticket' | 'invoice' | 'device' | 'lead' | 'admin';

export interface SearchResult {
  id: string;
  type: SearchResultType;
  title: string;          // main display text
  subtitle: string;       // secondary info
  href: string;           // frontend URL to navigate to
  icon: string;           // emoji or type indicator
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
}
