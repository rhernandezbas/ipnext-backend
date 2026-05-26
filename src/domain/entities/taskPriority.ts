export interface TaskPriority {
  id: string;
  name: string;
  /** Hex color used for the priority pill/badge in the UI. */
  color: string;
  /** Sort weight — higher means more urgent. Used to order tasks by priority. */
  weight: number;
}
