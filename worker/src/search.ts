import { getConfig, journal, secrets } from "./db";
import type { Env } from "./env";
import { fetchJson, HttpError } from "./outbound";
import { dayUsage, isOpen, monthRequests, recordFailure, recordSuccess } from "./usage";

/** Recherche web de profils publics, avec relais Tavily → Brave → Exa et quotas mensuels. */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export class SearchUnavailable extends Error {
  constructor(readonly retryAt: Date) {
    super("Aucun moteur de recherche disponible");
  }
}

type Engine = "tavily" | "brave" | "exa";

async function tavily(env: Env, key: string, q: string, n: number): Promise<SearchHit[]> {
  const r = await fetchJson<{ results?: { title?: string; url: string; content?: string }[] }>(env, "tavily", "https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: n, search_depth: "basic" }),
  });
  return (r.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url, snippet: x.content ?? "" }));
}

async function brave(env: Env, key: string, q: string, n: number): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(n, 20)}&country=FR&search_lang=fr`;
  const r = await fetchJson<{ web?: { results?: { title?: string; url: string; description?: string }[] } }>(env, "brave", url, {
    headers: { accept: "application/json", "x-subscription-token": key },
  });
  return (r.web?.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url, snippet: (x.description ?? "").replace(/<[^>]+>/g, "") }));
}

async function exa(env: Env, key: string, q: string, n: number): Promise<SearchHit[]> {
  const r = await fetchJson<{ results?: { title?: string; url: string; text?: string }[] }>(env, "exa", "https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query: q, numResults: n, type: "auto", contents: { text: { maxCharacters: 800 } } }),
  });
  return (r.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url, snippet: x.text ?? "" }));
}

export async function webSearch(env: Env, query: string, missionId?: string): Promise<{ engine: string; hits: SearchHit[] }> {
  const cfg = await getConfig(env);
  const keys = await secrets(env);
  const keyOf: Record<Engine, string | undefined> = { tavily: keys.tavily_api_key, brave: keys.brave_api_key, exa: keys.exa_api_key };
  const limits = cfg.search.monthly_limits as Record<string, number>;
  let soonest = Infinity;
  for (const engine of cfg.search.chain as Engine[]) {
    const key = keyOf[engine];
    if (!key) continue;
    const st = await dayUsage(env, `search:${engine}`);
    if (isOpen(st)) {
      soonest = Math.min(soonest, Date.parse(st.openUntil!));
      continue;
    }
    if ((await monthRequests(env, `search:${engine}`)) >= (limits[engine] ?? Infinity)) continue;
    try {
      const n = cfg.search.results_per_query;
      const hits = engine === "tavily" ? await tavily(env, key, query, n) : engine === "brave" ? await brave(env, key, query, n) : await exa(env, key, query, n);
      await recordSuccess(env, `search:${engine}`);
      return { engine, hits };
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      await recordFailure(env, `search:${engine}`, (e as Error).message, { breakerErrors: 2, openMinutes: 30, untilMidnight: status === 401 || status === 403 || status === 432 });
      await journal(env, "recherche", "relais", { moteur: engine, erreur: (e as Error).message.slice(0, 200) }, { mission: missionId });
      soonest = Math.min(soonest, Date.now() + 30 * 60_000);
    }
  }
  throw new SearchUnavailable(new Date(Number.isFinite(soonest) ? soonest : Date.now() + 6 * 3_600_000));
}
