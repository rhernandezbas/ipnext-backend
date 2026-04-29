import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../../config';
import { ClientNotFoundError, SplynxUnavailableError, DomainError } from '@domain/errors';

export class SplynxClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.splynxApiUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.http.interceptors.request.use((req) => {
      req.headers['Authorization'] = `Splynx-EA key=${config.splynxApiKey},secret=${config.splynxApiSecret}`;
      return req;
    });
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.http.get<T>(path, { params });
      return res.data;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    try {
      const res = await this.http.post<T>(path, data);
      return res.data;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private mapError(err: unknown): DomainError {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      if (status === 404) {
        return new ClientNotFoundError('resource');
      }
      if (status === 401 || status === 403) {
        return new SplynxUnavailableError('Splynx authentication failed');
      }
      if (status && status >= 500) {
        return new SplynxUnavailableError(`Splynx returned ${status}`);
      }
    }
    return new SplynxUnavailableError('Unexpected error calling Splynx API');
  }
}
