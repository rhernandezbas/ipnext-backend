import { NewsCategory } from '@domain/entities/news';

export interface NewsCategoryRepository {
  list(): Promise<NewsCategory[]>;
  findById(id: string): Promise<NewsCategory | null>;
  findByName(name: string): Promise<NewsCategory | null>;
  create(input: { name: string; color: string }): Promise<NewsCategory>;
  update(id: string, patch: { name?: string; color?: string }): Promise<NewsCategory | null>;
  delete(id: string): Promise<void>;
  /** How many NewsPost rows reference this category id (delete guard). */
  countPosts(id: string): Promise<number>;
}
