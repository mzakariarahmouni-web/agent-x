import { ai } from "./ai/router";
import { getConfig, getSetting, journal, nowIso, parseJson } from "./db";
import type { Env } from "./env";
import { type Fiche, readFiche } from "./fiche";
import { mailReady, mailRepliesFrom, sendMail } from "./mail";
import type { SourcedProfile } from "./sourcing";
import { addBusinessHours, nextSlot, type ScheduleConfig } from "./schedule";
import { newId } from "./security";
import { notify } from "./telegram";

/** F4 — Prise de contact et relances : email automatique, LinkedIn pré-rempli (extension), créneaux et plafonds. */

export type Channel = "email" | "linkedin";

export interface Draft {
  objet: string;
  message: string;
}

const STEP_INTENT = [
  "Premier contact : qui écrit, la mission en une phrase (secteur, durée, lieu ou télétravail), une référence concrète au parcours du candidat, et une question simple pour répondre.",
  "Relance 1 : très courte, cordiale, rappelle la mission en une ligne.",
  "Relance 2 : apporte une information nouvelle et utile sur la mission (démarrage, contexte, budget si connu).",
  "Relance 3 (message de clôture) : dernière prise de contact, sans pression ; propose de rester en contact pour d'autres missions.",
];

export async function draftMessage(env: Env, f: Fiche, p: SourcedProfile, step: number, channel: Channel, sender: string, maxChars: number, missionId?: string): Promise<Draft> {
  const { data } = await ai<Draft>(env, {
    family: "volume",
    label: `message étape ${step}`,
    missionId,
    system: `Tu écris des messages de recrutement en français, courts, personnalisés, sans jargon commercial ni emoji.
Vouvoiement. Pas de lien, pas de signature (ajoutés ensuite). « message » : ${maxChars} caractères au maximum.
${channel === "email" ? "« objet » : 6 mots au maximum, concret." : "« objet » : chaîne vide (LinkedIn)."}
Réponds uniquement en JSON : { "objet": "", "message": "" }`,
    prompt: `Expéditeur : ${sender}
Étape : ${STEP_INTENT[Math.min(step, 3)]}
Mission : ${JSON.stringify({ intitule: f.intitule, secteur: f.secteur, localisation: f.localisation, teletravail: f.teletravail, duree: f.duree, date_debut: f.date_debut, competences: f.competences_obligatoires })}
Candidat : ${JSON.stringify({ prenom: (p.nom ?? "").split(" ")[0] || null, intitule: p.intitule, competences: p.competences?.slice(0, 8), secteurs: p.secteurs })}`,
    json: true,
    maxTokens: 600,
    validate: (d) => (!d?.message ? "message vide" : d.message.length > maxChars + 40 ? `message trop long (${d.message.length})` : null),
  });
  return { objet: (data.objet ?? "").trim(), message: data.message.trim().slice(0, maxChars + 40) };
}

export function footer(channel: Channel, publicUrl: string, token: string, sender: string): string {
  const q = `${publicUrl}/q/${token}`;
  const stop = `${publicUrl}/stop/${token}`;
  return channel === "email"
    ? `\n\nPour me répondre en 5 minutes : ${q}\n\n${sender}\n—\nVos coordonnées proviennent de votre profil professionnel public. Pour ne plus être contacté(e) et effacer vos données : ${stop}`
    : `\n\nQuestionnaire (5 min) : ${q}\nNe plus être contacté(e) : ${stop}`;
}

async function sentToday(env: Env, channel: Channel): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = ? AND at >= datetime('now', 'start of day')")
    .bind(channel === "email" ? "email_envoye" : "linkedin_prepare")
    .first<{ n: number }>();
  return r?.n ?? 0;
}

interface DueRow {
  id: string;
  mission_id: string;
  candidate_id: string;
  contact_step: number;
  channel: Channel | null;
  token: string | null;
  profile: string;
  email: string | null;
  linkedin_url: string | null;
  fiche: string;
  sender_name: string | null;
  title: string;
}

/** Traite les contacts arrivés à échéance (appelé toutes les 15 minutes). */
export async function processDueContacts(env: Env, now = new Date(), limit = 10): Promise<{ email: number; linkedin: number }> {
  const cfg = await getConfig(env);
  const sched = cfg.schedule as ScheduleConfig;
  const steps = cfg.outreach.steps;
  const publicUrl = (await getSetting(env, "public_url")) || env.PUBLIC_URL || "";
  const mailOk = await mailReady(env);
  const defaultSender = (await getSetting(env, "sender_default")) || "Le recruteur";
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.mission_id, a.candidate_id, a.contact_step, a.channel, a.token, c.profile, c.email, c.linkedin_url, m.fiche, m.sender_name, m.title
     FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN missions m ON m.id = a.mission_id
     WHERE a.state IN ('a_contacter', 'contacte') AND a.next_action_at IS NOT NULL AND a.next_action_at <= ? AND m.status = 'en_cours'
     ORDER BY a.next_action_at LIMIT ?`,
  )
    .bind(nowIso(now), limit)
    .all<DueRow>();
  const counts = { email: 0, linkedin: 0 };
  const newLinkedin: string[] = [];
  for (const r of results ?? []) {
    // Après la dernière relance : délai de grâce écoulé → « sans réponse », le candidat reste en CV-thèque.
    if (r.contact_step >= steps.length) {
      await env.DB.prepare("UPDATE applications SET state = 'sans_reponse', next_action_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(r.id).run();
      continue;
    }
    const step = steps[r.contact_step];
    // Hors créneau : on reporte au prochain créneau ouvré.
    const slot = nextSlot(now, step.slot, sched);
    if (slot.getTime() > now.getTime()) {
      await env.DB.prepare("UPDATE applications SET next_action_at = ? WHERE id = ?").bind(nowIso(slot), r.id).run();
      continue;
    }
    const canEmail = !!r.email && mailOk;
    const canLinkedin = !!r.linkedin_url;
    const principal: Channel | null = r.channel ?? (canEmail ? "email" : canLinkedin ? "linkedin" : null);
    let channel = principal;
    if (step.channel === "autre") channel = principal === "email" && canLinkedin ? "linkedin" : principal === "linkedin" && canEmail ? "email" : principal;
    if (!channel) {
      await env.DB.prepare("UPDATE applications SET state = 'sans_canal', next_action_at = NULL WHERE id = ?").bind(r.id).run();
      continue;
    }
    const cap = channel === "email" ? cfg.outreach.email_daily_cap : cfg.outreach.linkedin_daily_cap;
    if ((await sentToday(env, channel)) >= cap) {
      await env.DB.prepare("UPDATE applications SET next_action_at = ? WHERE id = ?").bind(nowIso(nextSlot(addBusinessHours(now, 12, sched.extra_holidays), step.slot, sched)), r.id).run();
      continue;
    }
    const token = r.token ?? newId("t_");
    const sender = r.sender_name || defaultSender;
    const f = readFiche(r.fiche);
    const p = parseJson<SourcedProfile>(r.profile, { source: "inconnu" });
    const draft = await draftMessage(env, f, p, r.contact_step, channel, sender, cfg.outreach.max_chars, r.mission_id);
    const body = draft.message + footer(channel, publicUrl, token, sender);
    if (channel === "email") {
      await sendMail(env, sender, r.email!, draft.objet || f.intitule, body);
      await journal(env, "contact", "email_envoye", { etape: r.contact_step }, { mission: r.mission_id, candidate: r.candidate_id });
      counts.email++;
    } else {
      const qid = newId("l_");
      await env.DB.prepare("INSERT INTO linkedin_queue (id, application_id, profile_url, message, due_at) VALUES (?, ?, ?, ?, ?)")
        .bind(qid, r.id, r.linkedin_url, body, nowIso(now))
        .run();
      await journal(env, "contact", "linkedin_prepare", { etape: r.contact_step }, { mission: r.mission_id, candidate: r.candidate_id });
      newLinkedin.push(qid);
      counts.linkedin++;
    }
    const nextStep = steps[r.contact_step + 1];
    const wait = nextStep ? nextStep.after_business_hours - step.after_business_hours : 24;
    const nextAt = nextStep ? nextSlot(addBusinessHours(now, wait, sched.extra_holidays), nextStep.slot, sched) : addBusinessHours(now, wait, sched.extra_holidays);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE applications SET state = 'contacte', channel = ?, token = ?, contact_step = contact_step + 1, next_action_at = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(principal, token, nowIso(nextAt), r.id),
      env.DB.prepare("UPDATE candidates SET last_contact_at = datetime('now') WHERE id = ?").bind(r.candidate_id),
    ]);
  }
  if (newLinkedin.length) await notifyLinkedinQueue(env, newLinkedin.length);
  return counts;
}

/** Prévient le recruteur : file LinkedIn prête (extension sur ordinateur, ou boutons sur mobile via /linkedin). */
export async function notifyLinkedinQueue(env: Env, added: number): Promise<void> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM linkedin_queue WHERE status = 'a_envoyer'").first<{ n: number }>();
  await notify(env, `💼 ${added} message(s) LinkedIn prêt(s) (${r?.n ?? added} en file).\nSur ordinateur : extension Agent X → « Ouvrir la file ». Sur mobile : /linkedin.`, [
    [{ text: "📱 Voir la file ici", data: "li:list" }],
  ]);
}

/** Réponses reçues par email (toutes les 15 minutes) : le candidat passe en « répondu ». */
export async function checkEmailReplies(env: Env): Promise<number> {
  if (!(await mailReady(env))) return 0;
  const { results } = await env.DB.prepare(
    `SELECT a.id, lower(c.email) AS email, a.mission_id, c.full_name, m.title FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN missions m ON m.id = a.mission_id
     WHERE a.state = 'contacte' AND a.channel = 'email' AND c.email IS NOT NULL`,
  ).all<{ id: string; email: string; mission_id: string; full_name: string | null; title: string }>();
  const rows = results ?? [];
  const replied = await mailRepliesFrom(env, [...new Set(rows.map((r) => r.email))]);
  let n = 0;
  for (const r of rows.filter((x) => replied.has(x.email))) {
    await markReplied(env, r.id);
    await notify(env, `✉️ ${r.full_name ?? "Un candidat"} a répondu par email (${r.title}). Le questionnaire lui est déjà proposé ; je suis la suite.`);
    n++;
  }
  return n;
}

/** Le candidat a répondu : plus de relance ; il reste à remplir le questionnaire. */
export async function markReplied(env: Env, applicationId: string): Promise<void> {
  await env.DB.prepare("UPDATE applications SET state = 'repondu', next_action_at = NULL, updated_at = datetime('now') WHERE id = ? AND state IN ('contacte', 'a_contacter')")
    .bind(applicationId)
    .run();
}
