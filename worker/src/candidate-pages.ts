import { sendMissionEvent } from "./bot";
import { getConfig, journal } from "./db";
import type { Env } from "./env";
import { type Question, readFiche } from "./fiche";
import { markReplied } from "./outreach";
import template from "./pages/questionnaire.html";
import { eraseCandidate } from "./rgpd";
import { notify } from "./telegram";

/** Pages publiques du candidat : questionnaire (lien unique) et désinscription. */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, status = 200): Response {
  return new Response(template.replace("{{TITLE}}", esc(title)).replace("{{BODY}}", body), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" },
  });
}

interface AppRow {
  id: string;
  mission_id: string;
  candidate_id: string;
  state: string;
  fiche: string;
  status: string;
  full_name: string | null;
}

async function byToken(env: Env, token: string): Promise<AppRow | null> {
  if (!/^t_[\w-]{10,}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT a.id, a.mission_id, a.candidate_id, a.state, m.fiche, m.status, c.full_name FROM applications a JOIN missions m ON m.id = a.mission_id JOIN candidates c ON c.id = a.candidate_id WHERE a.token = ?`,
  )
    .bind(token)
    .first<AppRow>();
}

function field(q: Question): string {
  const name = `q_${esc(q.id)}`;
  const input =
    q.type === "oui_non"
      ? `<div class="yn"><label><input type="radio" name="${name}" value="oui" required>Oui</label><label><input type="radio" name="${name}" value="non">Non</label></div>`
      : `<textarea name="${name}" maxlength="3000" ${q.bloc === 2 ? "required" : ""}></textarea>`;
  return `<div class="card"><div class="q">${esc(q.texte)}</div>${input}</div>`;
}

export async function questionnairePage(env: Env, token: string): Promise<Response> {
  const a = await byToken(env, token);
  if (!a) return page("Lien expiré", `<div class="ok"><h1>Ce lien n'est plus valable</h1><p class="muted">La mission est peut-être pourvue. Merci de votre intérêt.</p></div>`, 404);
  if (["reponses_recues", "qualifie", "cv_formate", "presente", "en_attente"].includes(a.state))
    return page("Merci", `<div class="ok"><h1>Vos réponses sont bien reçues</h1><p class="muted">Nous revenons vers vous rapidement.</p></div>`);
  if (a.status !== "en_cours") return page("Mission close", `<div class="ok"><h1>Cette mission est close</h1><p class="muted">Nous gardons votre profil pour les prochaines, si vous le souhaitez.</p></div>`);
  const f = readFiche(a.fiche);
  const first = (a.full_name ?? "").split(" ")[0];
  const body = `
<header>
  <h1>${esc(f.intitule)}</h1>
  <div class="muted">${esc([f.secteur, f.localisation, f.teletravail, f.duree].filter(Boolean).join(" · "))}</div>
</header>
<p>${first ? `Bonjour ${esc(first)}, ` : "Bonjour, "}ces quelques questions (5 minutes environ) nous permettent de vous présenter au client dans les meilleures conditions.</p>
<form method="post" enctype="multipart/form-data">
${f.questionnaire.map(field).join("\n")}
<div class="card"><div class="q">Votre CV (facultatif, PDF, 5 Mo maximum)</div><input type="file" name="cv" accept="application/pdf"></div>
<button type="submit">Envoyer mes réponses</button>
<p class="note">Vos réponses servent uniquement à évaluer votre candidature pour cette mission et les suivantes. Votre CV présenté au client est anonymisé. Vous pouvez demander l'effacement de vos données à tout moment avec le lien « Ne plus être contacté(e) » du message reçu.</p>
</form>`;
  return page(f.intitule, body);
}

export async function questionnaireSubmit(env: Env, token: string, req: Request): Promise<Response> {
  const a = await byToken(env, token);
  if (!a || a.status !== "en_cours") return questionnairePage(env, token);
  if (["reponses_recues", "qualifie", "cv_formate", "presente"].includes(a.state)) return questionnairePage(env, token);
  const f = readFiche(a.fiche);
  const form = await req.formData();
  const answers: Record<string, string> = {};
  for (const q of f.questionnaire) answers[q.id] = String(form.get(`q_${q.id}`) ?? "").slice(0, 3000);
  const cv = form.get("cv");
  if (cv && typeof cv === "object" && "arrayBuffer" in cv && (cv as File).size > 0) {
    const file = cv as File;
    if (file.size <= 5_000_000 && file.type === "application/pdf") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const cfg = await getConfig(env);
      await env.FILES.put(`upload:${a.candidate_id}`, JSON.stringify({ mime: "application/pdf", base64: btoa(s) }), { expirationTtl: cfg.rgpd.retention_days * 86_400 });
    }
  }
  await markReplied(env, a.id);
  await env.DB.prepare("UPDATE applications SET answers = ?, state = 'reponses_recues', next_action_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(answers), a.id).run();
  await env.DB.prepare("UPDATE candidates SET last_contact_at = datetime('now') WHERE id = ?").bind(a.candidate_id).run();
  await journal(env, "candidat", "questionnaire_recu", null, { mission: a.mission_id, candidate: a.candidate_id });
  try {
    await sendMissionEvent(env, a.mission_id, "point", { kind: "answers" });
  } catch (e) {
    await notify(env, `📝 Questionnaire reçu (${a.full_name ?? "candidat"}), mais la mission ne répond pas : ${(e as Error).message}`);
  }
  return page("Merci", `<div class="ok"><h1>Merci, vos réponses sont bien reçues</h1><p class="muted">Nous revenons vers vous rapidement.</p></div>`);
}

export async function stopPage(env: Env, token: string, req: Request): Promise<Response> {
  const a = await byToken(env, token);
  if (!a) return page("Désinscription", `<div class="ok"><h1>C'est fait</h1><p class="muted">Vos données ont déjà été effacées ou ce lien n'est plus valable.</p></div>`);
  if (req.method !== "POST")
    return page(
      "Ne plus être contacté(e)",
      `<div class="ok"><h1>Ne plus être contacté(e)</h1><p class="muted">Vos données (profil, réponses, fichiers) seront effacées et vous ne serez plus contacté(e).</p><form method="post"><button type="submit">Confirmer l'effacement</button></form></div>`,
    );
  await eraseCandidate(env, a.candidate_id, "désinscription par le candidat");
  await notify(env, `🚫 Un candidat s'est désinscrit (mission ${readFiche(a.fiche).intitule}) : données effacées.`);
  return page("Effacement confirmé", `<div class="ok"><h1>Effacement confirmé</h1><p class="muted">Vous ne serez plus contacté(e). Merci et bonne continuation.</p></div>`);
}

