import type { Env } from "./env";

/** Compteurs de quotas et coupe-circuit par fournisseur (table usage, jour UTC). */

export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export const month = (d = new Date()) => d.toISOString().slice(0, 7);

export interface ProviderState {
  requests: number;
  errors: number;
  openUntil: string | null;
}

export async function dayUsage(env: Env, provider: string, day = today()): Promise<ProviderState> {
  const r = await env.DB.prepare("SELECT requests, errors, open_until FROM usage WHERE provider = ? AND day = ?")
    .bind(provider, day)
    .first<{ requests: number; errors: number; open_until: string | null }>();
  return { requests: r?.requests ?? 0, errors: r?.errors ?? 0, openUntil: r?.open_until ?? null };
}

export async function monthRequests(env: Env, provider: string, m = month()): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(requests), 0) AS n FROM usage WHERE provider = ? AND day LIKE ?")
    .bind(provider, `${m}-%`)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Le fournisseur est-il écarté par le coupe-circuit ? */
export function isOpen(state: ProviderState, now = new Date()): boolean {
  return !!state.openUntil && Date.parse(state.openUntil) > now.getTime();
}

export async function recordSuccess(env: Env, provider: string, units = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage (provider, day, requests, units, errors) VALUES (?, ?, 1, ?, 0)
     ON CONFLICT(provider, day) DO UPDATE SET requests = requests + 1, units = units + excluded.units, errors = 0`,
  )
    .bind(provider, today(), units)
    .run();
}

/**
 * Enregistre un échec. Après `breakerErrors` échecs de suite, le fournisseur est écarté `openMinutes` minutes.
 * Un quota épuisé (429 persistant) ou une clé refusée l'écarte jusqu'à minuit UTC.
 */
export async function recordFailure(
  env: Env,
  provider: string,
  message: string,
  opts: { breakerErrors: number; openMinutes: number; untilMidnight?: boolean },
): Promise<void> {
  const day = today();
  const st = await dayUsage(env, provider, day);
  const errors = st.errors + 1;
  let openUntil: string | null = st.openUntil;
  if (opts.untilMidnight) {
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    openUntil = d.toISOString();
  } else if (errors >= opts.breakerErrors) {
    openUntil = new Date(Date.now() + opts.openMinutes * 60_000).toISOString();
  }
  await env.DB.prepare(
    `INSERT INTO usage (provider, day, requests, units, errors, last_error, open_until) VALUES (?, ?, 0, 0, ?, ?, ?)
     ON CONFLICT(provider, day) DO UPDATE SET errors = excluded.errors, last_error = excluded.last_error, open_until = excluded.open_until`,
  )
    .bind(provider, day, errors, message.slice(0, 300), openUntil)
    .run();
}

/** État de tous les fournisseurs du jour (page de configuration, commande /etat). */
export async function usageToday(env: Env): Promise<{ provider: string; requests: number; errors: number; last_error: string | null; open_until: string | null }[]> {
  const { results } = await env.DB.prepare("SELECT provider, requests, errors, last_error, open_until FROM usage WHERE day = ? ORDER BY provider")
    .bind(today())
    .all<{ provider: string; requests: number; errors: number; last_error: string | null; open_until: string | null }>();
  return results ?? [];
}
