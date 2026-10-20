/**
 * Appels sortants vers les API externes.
 * En test local uniquement, MOCK_BASE redirige tous les appels vers un serveur simulé :
 * https://api.exemple.com/chemin devient {MOCK_BASE}/api.exemple.com/chemin.
 */
export interface OutboundEnv {
  MOCK_BASE?: string;
}

export function apiUrl(env: OutboundEnv, url: string): string {
  if (!env.MOCK_BASE) return url;
  const u = new URL(url);
  return `${env.MOCK_BASE.replace(/\/$/, "")}/${u.host}${u.pathname}${u.search}`;
}

export function apiFetch(env: OutboundEnv, url: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(env, url), init);
}

/** Erreur HTTP d'un fournisseur, avec le code pour décider d'un relais (429, 5xx) ou d'un arrêt (401, 403). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly provider: string,
    detail: string,
  ) {
    super(`${provider} ${status}: ${detail.slice(0, 300)}`);
  }
}

export async function fetchJson<T>(env: OutboundEnv, provider: string, url: string, init: RequestInit, timeoutMs = 60_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await apiFetch(env, url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, provider, text);
    return JSON.parse(text) as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new HttpError(504, provider, "délai dépassé");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Limite de l'offre gratuite atteinte : 50 appels sortants par exécution. Ce n'est la faute d'aucun fournisseur :
 * l'étape reprend quelques secondes plus tard, dans une nouvelle exécution, sans écarter personne.
 */
export class BudgetExhausted extends Error {
  readonly retryAt = new Date(Date.now() + 5_000);
  constructor() {
    super("Limite d'appels de l'exécution atteinte, reprise dans quelques secondes");
  }
}

export const isBudgetError = (e: unknown) => e instanceof BudgetExhausted || /too many subrequests|too many api requests/i.test((e as Error)?.message ?? "");
