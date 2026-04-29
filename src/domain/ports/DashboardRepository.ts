import { DashboardStats, DashboardShortcut, RecentActivity } from '@domain/entities/dashboard';

export interface DashboardRepository {
  getStats(): Promise<DashboardStats>;
  getShortcuts(): Promise<DashboardShortcut[]>;
  getRecentActivity(): Promise<RecentActivity[]>;
}
