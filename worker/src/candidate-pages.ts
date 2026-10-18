import { sendMissionEvent } from "./bot";
import { getConfig, journal } from "./db";
import type { Env } from "./env";
import { parseJson } from "./db";
import { type Question, readFiche } from "./fiche";
import type { SourcedProfile } from "./sourcing";
import { followUpQuestions, mergeTalent, type Talent, talentFromForm, talentFromProfile } from "./talent";
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
  profile: string;
  answers: string | null;
  talent: string | null;
  followups: string | null;
}

async function byToken(env: Env, token: string): Promise<AppRow | null> {
  if (!/^t_[\w-]{10,}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT a.id, a.mission_id, a.candidate_id, a.state, a.answers, a.talent, a.followups, m.fiche, m.status, c.full_name, c.profile FROM applications a JOIN missions m ON m.id = a.mission_id JOIN candidates c ON c.id = a.candidate_id WHERE a.token = ?`,
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

/** Bloc « Votre situation » : rubriques de la fiche candidat recueillies en pré-qualification (niveau 2). */
function situationBlock(known: Talent): string {
  const v = (s?: string | null) => (s ? ` value="${esc(s)}"` : "");
  const poste = [known.dernier_poste, known.derniere_entreprise].filter(Boolean).join(" chez ");
  return `
<h2>Votre situation</h2>
<div class="card"><div class="q">Êtes-vous actuellement en poste ?</div><div class="yn"><label><input type="radio" name="t_en_poste" value="oui" required>Oui</label><label><input type="radio" name="t_en_poste" value="non">Non</label></div></div>
<div class="card"><div class="q">Poste actuel (ou dernier poste) et entreprise</div><input type="text" name="t_poste" maxlength="200"${v(poste)} placeholder="Consultant EDI chez …"></div>
<div class="card"><div class="q">Rémunération actuelle</div>
  <div class="row"><select name="t_rem_type" required><option value="">Type…</option><option value="salaire">Salaire brut annuel</option><option value="tjm">TJM (freelance)</option></select>
  <input type="text" name="t_rem_montant" inputmode="numeric" maxlength="12" required placeholder="Montant en €"></div>
  <input type="text" name="t_package" maxlength="300" placeholder="Package : variable, primes, avantages (facultatif)"></div>
<div class="card"><div class="q">Préavis</div>
  <select name="t_preavis" required><option value="">Choisir…</option><option value="aucun">Pas de préavis</option><option value="1 mois">1 mois</option><option value="2 mois">2 mois</option><option value="3 mois">3 mois</option><option value="autre">Autre</option></select>
  <input type="text" name="t_preavis_autre" maxlength="100" placeholder="Si autre : précisez (facultatif)"></div>
<div class="card"><div class="q">Disponible dès le</div><input type="date" name="t_dispo" required></div>
<div class="card"><div class="q">Niveau d'étude et diplôme</div><input type="text" name="t_diplome" maxlength="200"${v(known.diplome)} placeholder="Bac +5, Master … (école)"></div>
<div class="card"><div class="q">Vos compétences principales</div><textarea name="t_competences" maxlength="1500" placeholder="Séparées par des virgules">${esc((known.competences ?? []).join(", "))}</textarea></div>`;
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
${situationBlock(talentFromProfile(parseJson<SourcedProfile>(a.profile, { source: "inconnu" })))}
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
  const talent = mergeTalent(parseJson<Talent>(a.talent, {}), talentFromForm(form));
  await env.DB.prepare("UPDATE applications SET answers = ?, talent = ?, state = 'reponses_recues', next_action_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(answers), JSON.stringify(talent), a.id)
    .run();
  await env.DB.prepare("UPDATE candidates SET last_contact_at = datetime('now') WHERE id = ?").bind(a.candidate_id).run();
  await journal(env, "candidat", "questionnaire_recu", null, { mission: a.mission_id, candidate: a.candidate_id });
  try {
    await sendMissionEvent(env, a.mission_id, "point", { kind: "answers" });
  } catch (e) {
    await notify(env, `📝 Questionnaire reçu (${a.full_name ?? "candidat"}), mais la mission ne répond pas : ${(e as Error).message}`);
  }
  return page(
    "Merci",
    `<div class="ok"><h1>Merci, vos réponses sont bien reçues</h1><p class="muted">Pour gagner du temps lors de notre échange, vous pouvez répondre à deux ou trois questions de précision (1 minute).</p>
<form method="get" action="/q/${esc(token)}/suite"><button type="submit">Répondre aux questions de précision</button></form><p class="note">Facultatif : vous pouvez aussi fermer cette page.</p></div>`,
  );
}

/**
 * Entretien de pré-qualification écrit : questions de précision générées par l'IA (une seule fois), puis réponses.
 * Facultatif pour le candidat ; les réponses complètent la fiche candidat (« précisions »).
 */
export async function followUpPage(env: Env, token: string, req: Request): Promise<Response> {
  const a = await byToken(env, token);
  if (!a || a.status !== "en_cours") return questionnairePage(env, token);
  const f = readFiche(a.fiche);
  const fu = parseJson<{ questions?: string[]; answers?: string[] }>(a.followups, {});
  if (fu.answers?.length) return page("Merci", `<div class="ok"><h1>Merci, c'est complet</h1><p class="muted">Nous revenons vers vous rapidement.</p></div>`);
  if (req.method === "POST") {
    const form = await req.formData();
    const qs = fu.questions ?? [];
    const answers = qs.map((_, i) => String(form.get(`p_${i}`) ?? "").trim().slice(0, 2000));
    const precisions = qs.map((q, i) => (answers[i] ? `${q} → ${answers[i]}` : "")).filter(Boolean).join("\n");
    const talent = mergeTalent(parseJson<Talent>(a.talent, {}), { precisions: precisions || null });
    await env.DB.prepare("UPDATE applications SET followups = ?, talent = ? WHERE id = ?").bind(JSON.stringify({ questions: qs, answers }), JSON.stringify(talent), a.id).run();
    await journal(env, "candidat", "precisions_recues", { questions: qs.length }, { mission: a.mission_id, candidate: a.candidate_id });
    return page("Merci", `<div class="ok"><h1>Merci pour ces précisions</h1><p class="muted">Nous revenons vers vous rapidement.</p></div>`);
  }
  let questions = fu.questions;
  if (!questions) {
    questions = await followUpQuestions(env, f, parseJson<Record<string, string>>(a.answers, {}), parseJson<Talent>(a.talent, {}), a.mission_id);
    await env.DB.prepare("UPDATE applications SET followups = ? WHERE id = ?").bind(JSON.stringify({ questions }), a.id).run();
  }
  if (!questions.length) return page("Merci", `<div class="ok"><h1>Tout est clair, merci</h1><p class="muted">Nous revenons vers vous rapidement.</p></div>`);
  return page(
    f.intitule,
    `<header><h1>Questions de précision</h1><div class="muted">${esc(f.intitule)}</div></header>
<form method="post">
${questions.map((q, i) => `<div class="card"><div class="q">${esc(q)}</div><textarea name="p_${i}" maxlength="2000"></textarea></div>`).join("\n")}
<button type="submit">Envoyer</button></form>`,
  );
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

