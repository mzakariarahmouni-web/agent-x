import { journal, nowIso } from "./db";
import type { Env } from "./env";
import { markReplied } from "./outreach";
import { canonLinkedin } from "./sourcing";
import { derivedSecret, safeEqual } from "./security";
import { notify } from "./telegram";

/** API de l'extension Chrome : file d'envoi, envoi confirmé par le recruteur, réponses détectées. */

const cors = { "access-control-allow-origin": "https://www.linkedin.com", "access-control-allow-headers": "content-type, x-agent-x-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", ...cors } });


export async function handleLinkedin(env: Env, req: Request, path: string): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!env.ADMIN_TOKEN) return json({ ok: false }, 503);
  const token = req.headers.get("x-agent-x-token") ?? "";
  if (!safeEqual(token, await derivedSecret(env.ADMIN_TOKEN, "extension"))) return json({ ok: false, error: "jeton invalide" }, 401);

  if (path === "/api/linkedin/queue") {
    const { results } = await env.DB.prepare(
      `SELECT q.id, q.profile_url, q.message, c.full_name, m.title FROM linkedin_queue q JOIN applications a ON a.id = q.application_id
       JOIN candidates c ON c.id = a.candidate_id JOIN missions m ON m.id = a.mission_id
       WHERE q.status = 'a_envoyer' AND q.due_at <= ? ORDER BY q.due_at LIMIT 25`,
    )
      .bind(nowIso())
      .all();
    return json({ ok: true, items: results ?? [] });
  }
  if (path === "/api/linkedin/sent" && req.method === "POST") {
    const { id } = (await req.json()) as { id: string };
    await env.DB.prepare("UPDATE linkedin_queue SET status = 'envoye', sent_at = ? WHERE id = ? AND status = 'a_envoyer'").bind(nowIso(), id).run();
    await journal(env, "recruteur", "linkedin_envoye", { file: id });
    return json({ ok: true });
  }
  if (path === "/api/linkedin/reply" && req.method === "POST") {
    const { profile_url } = (await req.json()) as { profile_url: string };
    const url = canonLinkedin(profile_url ?? "");
    const { results } = await env.DB.prepare(
      `SELECT a.id, c.full_name, m.title FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN missions m ON m.id = a.mission_id
       WHERE a.state = 'contacte' AND c.linkedin_url = ?`,
    )
      .bind(url)
      .all<{ id: string; full_name: string | null; title: string }>();
    for (const r of results ?? []) {
      await markReplied(env, r.id);
      await notify(env, `💬 ${r.full_name ?? "Un candidat"} a répondu sur LinkedIn (${r.title}). Plus de relance ; le questionnaire lui a été proposé.`);
    }
    return json({ ok: true, matched: results?.length ?? 0 });
  }
  return json({ ok: false, error: "introuvable" }, 404);
}
