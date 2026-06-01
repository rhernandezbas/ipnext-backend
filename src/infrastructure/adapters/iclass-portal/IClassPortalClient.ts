import { IClassPortalPort } from '@domain/ports/IClassPortalPort';
import { ScrapedOSDetail } from '@domain/entities/iclass-portal';
import { parseSeamOSDetail } from './parseSeamOSDetail';

export interface IClassPortalConfig {
  baseUrl: string; // e.g. https://fs2.iclass.com.br
  user: string;
  password: string;
}

/**
 * SEAM portal client. JSF login is a multi-step handshake (verified):
 *   GET login.seam (→ JSESSIONID + ViewState) → POST credentials
 *   → 302 autologin.seam?application-token=... → 302 panel (authenticated).
 * We follow redirects manually, accumulating cookies, since fetch does not
 * persist Set-Cookie across a redirect chain. The closure-page GET is read-only
 * (verified: it never mutates the OS). Re-logs in transparently on session loss.
 */
export class IClassPortalClient implements IClassPortalPort {
  private readonly cookies = new Map<string, string>();
  private loggedIn = false;

  constructor(private readonly cfg: IClassPortalConfig) {}

  async getOSDetail(osId: string): Promise<ScrapedOSDetail> {
    if (!this.loggedIn) await this.login();
    let html = await this.fetchBaixa(osId);
    if (this.looksLikeLogin(html)) {
      // session expired → re-login once and retry
      this.loggedIn = false;
      this.cookies.clear();
      await this.login();
      html = await this.fetchBaixa(osId);
    }
    return parseSeamOSDetail(html);
  }

  private async fetchBaixa(osId: string): Promise<string> {
    const url =
      `${this.cfg.baseUrl}/iclassfs/restrict/baixa_os_validada.seam` +
      `?osId=${encodeURIComponent(osId)}&transicaoId=47&retornoPriorizacao=false&tetrisOnByAction=false&source=seam`;
    return (await this.follow(url, { method: 'GET' })).body;
  }

  private async login(): Promise<void> {
    const loginUrl = `${this.cfg.baseUrl}/iclassfs/login/login.seam`;
    const page = await this.follow(loginUrl, { method: 'GET' });
    const viewState =
      /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/.exec(page.body)?.[1] ?? 'j_id1';

    const form = new URLSearchParams();
    form.set('login', 'login');
    form.set('login:username', this.cfg.user);
    form.set('login:password', this.cfg.password);
    form.set('login:id_login', 'Entrar');
    form.set('javax.faces.ViewState', viewState);

    const res = await this.follow(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (this.looksLikeLogin(res.body)) {
      throw new Error('IClass portal login failed (check ICLASS_PORTAL_USER/PASSWORD)');
    }
    this.loggedIn = true;
  }

  private looksLikeLogin(html: string): boolean {
    return /name="login:username"/.test(html) || /Wrong login or password/.test(html);
  }

  /** fetch with manual redirect following, accumulating cookies across the chain. */
  private async follow(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    max = 8,
  ): Promise<{ status: number; body: string; url: string }> {
    let current = url;
    let method = init.method;
    let body: string | undefined = init.body;
    let headers = { ...(init.headers ?? {}) };

    for (let i = 0; i < max; i++) {
      const cookie = this.cookieHeader();
      const res = await fetch(current, {
        method,
        body,
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
        redirect: 'manual',
      });
      this.storeCookies(res);

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { status: res.status, body: await res.text(), url: current };
        current = new URL(loc, current).toString();
        method = 'GET';
        body = undefined;
        headers = {};
        continue;
      }
      return { status: res.status, body: await res.text(), url: current };
    }
    throw new Error('IClass portal: too many redirects');
  }

  private cookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private storeCookies(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}
