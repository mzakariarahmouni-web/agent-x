import { ai } from "./ai/router";
import { getConfig, journal, nowIso, parseJson } from "./db";
import type { Env } from "./env";
import { type Fiche, readFiche } from "./fiche";
import { findMissingEmails } from "./hunter";
import { hasSkill } from "./matching";
import { mailReady } from "./mail";
import { nextSlot, type ScheduleConfig } from "./schedule";
import type { SourcedProfile } from "./sourcing";
import { bot, type Button, notify, send } from "./telegram";
import { createValidation, validationButtons } from "./validations";

/**
 * Revue humaine entre le sourcing et le premier contact :
 * cartes Go / No go (avec motif), modèle de message validé, canal choisi (auto, email ou LinkedIn).
 * Rien n'est envoyé sans Go et sans message validé.
 */

export type ChannelMode = "auto" | "email" | "linkedin";

export const NOGO_REASONS: Record<string, string> = {
  n1: "niveau insuffisant",
  n2: "hors budget",
  n3: "déjà connu",
  n4: "autre",
};

interface CardRow {
  id: string;
  score: number | null;
  score_detail: string;
  full_name: string | null;
  email: string | null;
  linkedin_url: string | null;
  source: string;
  source_url: string | null;
  profile: string;
}

/** Texte d'une carte de revue (fonction pure, testée). */
export function cardText(f: Fiche, r: CardRow, rank: number, total: number): string {
  const p = parseJson<SourcedProfile>(r.profile, { source: r.source });
  const detail = parseJson<{ a_verifier?: string[]; couverture_obligatoires?: number } & Record<string, number>>(r.score_detail, {});
  const covered = f.competences_obligatoires.filter((s) => hasSkill([...(p.competences ?? []), p.intitule ?? "", p.resume ?? ""], s));
  const strengths: string[] = [];
  if (covered.length) strengths.push(`${covered.join(", ")} (${covered.length}/${f.competences_obligatoires.length} obligatoires)`);
  if (typeof p.annees_experience === "number") strengths.push(`${p.annees_experience} ans d'expérience`);
  else if (p.secteurs?.length) strengths.push(`secteur ${p.secteurs.slice(0, 2).join(", ")}`);
  const where = [p.intitule, p.entreprise ? `chez ${p.entreprise}` : "", p.localisation].filter(Boolean).join(" · ");
  const link = r.linkedin_url || r.source_url;
  return [
    `👤 ${rank}/${total} · ${r.full_name ?? "Profil"} — ${r.score ?? "?"}/100`,
    where,
    strengths.length ? `✅ ${strengths.slice(0, 2).join(" · ")}` : "",
    detail.a_verifier?.length ? `⚠️ ${detail.a_verifier.join(" ; ")}` : "",
    `📍 Source : ${link ? new URL(link).hostname.replace(/^www\./, "") : r.source} · ✉️ email : ${r.email ? "oui" : "non"}`,
    link ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function cardButtons(appId: string): Button[][] {
  return [
    [{ text: "✅ Go", data: `rv:${appId}:go` }],
    [
      { text: "❌ Niveau", data: `rv:${appId}:n1` },
      { text: "❌ Budget", data: `rv:${appId}:n2` },
      { text: "❌ Déjà connu", data: `rv:${appId}:n3` },
      { text: "❌ Autre", data: `rv:${appId}:n4` },
    ],
  ];
}

/** Envoie les cartes des meilleurs profils pas encore revus (au-dessus du seuil) ; renvoie le nombre de cartes. */
export async function sendReviewCards(env: Env, missionId: string, max?: number): Promise<number> {
  const cfg = await getConfig(env);
  const b = await bot(env);
  const m = await env.DB.prepare("SELECT fiche, title FROM missions WHERE id = ?").bind(missionId).first<{ fiche: string; title: string }>();
  if (!m) return 0;
  const f = readFiche(m.fiche);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.score, a.score_detail, c.full_name, c.email, c.linkedin_url, c.source, c.source_url, c.profile
     FROM applications a JOIN candidates c ON c.id = a.candidate_id
     WHERE a.mission_id = ? AND a.state = 'score' AND a.score >= ? ORDER BY a.score DESC LIMIT ?`,
  )
    .bind(missionId, cfg.matching.contact_threshold, max ?? cfg.mission.review_batch)
    .all<CardRow>();
  const rows = results ?? [];
  if (!rows.length) return 0;
  await env.DB.batch(rows.map((r) => env.DB.prepare("UPDATE applications SET state = 'en_revue', updated_at = datetime('now') WHERE id = ?").bind(r.id)));
  if (!b) return rows.length;
  await send(env, b, `🗂 Revue des profils · ${m.title}\n${rows.length} profil(s), du meilleur score au moins bon. Pour chacun : ✅ Go (à contacter) ou ❌ No go avec le motif (le profil reste en CV-thèque).`);
  for (const [i, r] of rows.entries()) await send(env, b, cardText(f, r, i + 1, rows.length), cardButtons(r.id));
  await send(env, b, "Quand tu as fini :", [
    [{ text: `✅ Go pour les ${Math.min(5, rows.length)} meilleurs restants`, data: `rvall:${missionId}:5` }],
    [{ text: "🏁 Terminer la revue", data: `rvfin:${missionId}` }],
  ]);
  await journal(env, "agent", "revue_envoyee", { profils: rows.length }, { mission: missionId });
  return rows.length;
}

interface MissionChannel {
  message_ok: number;
  channel_mode: ChannelMode | null;
}

/** Choix du canal pour un profil selon le mode retenu ; null si aucun canal possible. */
export function pickChannel(mode: ChannelMode, hasEmail: boolean, hasLinkedin: boolean, mailbox: boolean): "email" | "linkedin" | null {
  const email = hasEmail && mailbox;
  if (mode === "linkedin") return hasLinkedin ? "linkedin" : email ? "email" : null;
  if (mode === "email") return email ? "email" : hasLinkedin ? "linkedin" : null;
  return email ? "email" : hasLinkedin ? "linkedin" : null;
}

/** Planifie le premier contact des profils Go (message déjà validé), au prochain créneau, avec leur canal. */
export async function planGoContacts(env: Env, missionId: string, now = new Date()): Promise<{ planned: number; email: number; linkedin: number; none: number }> {
  const cfg = await getConfig(env);
  const m = await env.DB.prepare("SELECT message_ok, channel_mode FROM missions WHERE id = ?").bind(missionId).first<MissionChannel>();
  const out = { planned: 0, email: 0, linkedin: 0, none: 0 };
  if (!m?.message_ok) return out;
  const mode = (m.channel_mode ?? "auto") as ChannelMode;
  const mailbox = await mailReady(env);
  const { results } = await env.DB.prepare(
    "SELECT a.id, c.email, c.linkedin_url FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.mission_id = ? AND a.state = 'go' ORDER BY a.score DESC",
  )
    .bind(missionId)
    .all<{ id: string; email: string | null; linkedin_url: string | null }>();
  const slot = nextSlot(now, "premier_contact", cfg.schedule as ScheduleConfig);
  const stmts: D1PreparedStatement[] = [];
  for (const [i, r] of (results ?? []).entries()) {
    const ch = pickChannel(mode, !!r.email, !!r.linkedin_url, mailbox);
    if (!ch) {
      out.none++;
      stmts.push(env.DB.prepare("UPDATE applications SET state = 'sans_canal', updated_at = datetime('now') WHERE id = ?").bind(r.id));
      continue;
    }
    out[ch]++;
    out.planned++;
    stmts.push(
      env.DB.prepare("UPDATE applications SET state = 'a_contacter', channel = ?, next_action_at = ?, updated_at = datetime('now') WHERE id = ?").bind(
        ch,
        nowIso(new Date(slot.getTime() + i * 4 * 60_000)),
        r.id,
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return out;
}

/** Décision sur une carte (bouton Telegram). Renvoie le texte de confirmation. */
export async function reviewDecision(env: Env, appId: string, action: string): Promise<{ text: string; missionId: string | null; reviewDone: boolean }> {
  const a = await env.DB.prepare(
    "SELECT a.mission_id, a.state, c.full_name, c.profile FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = ?",
  )
    .bind(appId)
    .first<{ mission_id: string; state: string; full_name: string | null; profile: string }>();
  if (!a) return { text: "Profil introuvable.", missionId: null, reviewDone: false };
  if (a.state !== "en_revue") return { text: "Déjà décidé.", missionId: a.mission_id, reviewDone: false };
  const who = a.full_name ?? "Profil";
  if (action === "go") {
    await env.DB.prepare("UPDATE applications SET state = 'go', updated_at = datetime('now') WHERE id = ?").bind(appId).run();
    await journal(env, "recruteur", "go", null, { mission: a.mission_id });
    // Message déjà validé (revue suivante, sourcing continu) : contact planifié tout de suite.
    const m = await env.DB.prepare("SELECT message_ok, channel_mode FROM missions WHERE id = ?").bind(a.mission_id).first<MissionChannel>();
    if (m?.message_ok) {
      if (m.channel_mode !== "linkedin") await findMissingEmails(env, a.mission_id, [appId]);
      await planGoContacts(env, a.mission_id);
    }
  } else {
    const reason = NOGO_REASONS[action] ?? "autre";
    await env.DB.prepare("UPDATE applications SET state = 'nogo', nogo_reason = ?, updated_at = datetime('now') WHERE id = ?").bind(reason, appId).run();
    const p = parseJson<SourcedProfile>(a.profile, { source: "web" });
    // Le motif nourrit l'apprentissage du tri (voir sourcing.subScores).
    await journal(env, "recruteur", "nogo", { motif: reason, intitule: p.intitule, competences: (p.competences ?? []).slice(0, 8), annees: p.annees_experience }, { mission: a.mission_id });
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE mission_id = ? AND state = 'en_revue'").bind(a.mission_id).first<{ n: number }>();
  return { text: action === "go" ? `✅ Go : ${who}` : `❌ No go (${NOGO_REASONS[action] ?? "autre"}) : ${who}, gardé en CV-thèque`, missionId: a.mission_id, reviewDone: (left?.n ?? 0) === 0 };
}

/** « Go pour les N meilleurs restants ». */
export async function goBest(env: Env, missionId: string, n: number): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id FROM applications WHERE mission_id = ? AND state = 'en_revue' ORDER BY score DESC LIMIT ?").bind(missionId, n).all<{ id: string }>();
  for (const r of results ?? []) await reviewDecision(env, r.id, "go");
  return results?.length ?? 0;
}

/** Fin de revue : les profils non tranchés restent en CV-thèque (non contactés pour cette mission). */
export async function closeReview(env: Env, missionId: string): Promise<{ go: number; nogo: number; skipped: number }> {
  const skipped = await env.DB.prepare("UPDATE applications SET state = 'nogo', nogo_reason = 'non revu' WHERE mission_id = ? AND state = 'en_revue'").bind(missionId).run();
  const c = await env.DB.prepare("SELECT SUM(state = 'go') AS go, SUM(state = 'nogo') AS nogo FROM applications WHERE mission_id = ?").bind(missionId).first<{ go: number; nogo: number }>();
  return { go: c?.go ?? 0, nogo: c?.nogo ?? 0, skipped: skipped.meta?.changes ?? 0 };
}

// ───────────── Modèle de message de premier contact ─────────────

export interface MessageModel {
  objet: string;
  modele: string;
}

export function renderModel(modele: string, vars: { prenom?: string | null; accroche?: string | null }): string {
  return modele
    .replace(/\{prenom\}/g, vars.prenom || "")
    .replace(/\{accroche\}/g, vars.accroche || "")
    .replace(/Bonjour\s+,/g, "Bonjour,")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function draftModel(env: Env, f: Fiche, sender: string, instruction?: string, previous?: MessageModel, missionId?: string): Promise<MessageModel> {
  const { data } = await ai<MessageModel>(env, {
    family: "jugement",
    label: "modèle de premier contact",
    missionId,
    system: `Tu écris le message type de premier contact d'un recruteur à des consultants, en français, vouvoiement, sans emoji ni jargon.
Il sera personnalisé automatiquement : garde exactement les variables {prenom} (prénom du candidat) et {accroche} (une phrase sur son parcours, ajoutée par profil).
Structure : « Bonjour {prenom}, » ; {accroche} ; la mission en une ou deux phrases (secteur, durée, lieu ou télétravail) ; une question simple pour répondre.
350 caractères au maximum hors variables. Pas de lien ni de signature (ajoutés ensuite). « objet » : 6 mots au maximum.
Réponds uniquement en JSON : { "objet": "", "modele": "" }`,
    prompt: previous
      ? `Modèle actuel : ${JSON.stringify(previous)}\nModification demandée par le recruteur : « ${instruction} »\nRenvoie le modèle complet modifié.`
      : `Expéditeur : ${sender}\nMission : ${JSON.stringify({ intitule: f.intitule, secteur: f.secteur, localisation: f.localisation, teletravail: f.teletravail, duree: f.duree, date_debut: f.date_debut, competences: f.competences_obligatoires })}`,
    json: true,
    maxTokens: 800,
    validate: (d) => (!d?.modele ? "modèle vide" : !d.modele.includes("{accroche}") ? "variable {accroche} absente" : null),
  });
  return { objet: (data.objet ?? f.intitule).trim(), modele: data.modele.trim() };
}

/** Phrase personnelle pour un profil (modèle économique), insérée à la place de {accroche}. */
export async function accroche(env: Env, f: Fiche, p: SourcedProfile, missionId?: string): Promise<string> {
  try {
    const { data } = await ai<{ accroche: string }>(env, {
      family: "volume",
      label: "accroche personnalisée",
      missionId,
      system: `Tu écris UNE phrase (160 caractères au maximum) qui relie le parcours réel du candidat à la mission, en vouvoiement, sans flatterie excessive ni information inventée.
Réponds uniquement en JSON : { "accroche": "" }`,
      prompt: `Mission : ${f.intitule} (${f.competences_obligatoires.join(", ")})\nCandidat : ${JSON.stringify({ intitule: p.intitule, entreprise: p.entreprise, competences: p.competences?.slice(0, 8), secteurs: p.secteurs, annees: p.annees_experience })}`,
      json: true,
      maxTokens: 300,
      validate: (d) => (d?.accroche && d.accroche.length <= 220 ? null : "accroche absente ou trop longue"),
    });
    return data.accroche.trim();
  } catch {
    return `Votre expérience de ${p.intitule ?? "consultant"} correspond à une mission que je recrute actuellement.`;
  }
}

/** Validation du message : modèle, 2 exemples personnalisés, choix du canal. */
export async function sendMessageValidation(env: Env, missionId: string, model: MessageModel, reminder = 0): Promise<void> {
  const m = await env.DB.prepare("SELECT fiche, title FROM missions WHERE id = ?").bind(missionId).first<{ fiche: string; title: string }>();
  if (!m) return;
  const f = readFiche(m.fiche);
  const { results } = await env.DB.prepare(
    "SELECT c.full_name, c.profile, c.email FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.mission_id = ? AND a.state = 'go' ORDER BY a.score DESC LIMIT 2",
  )
    .bind(missionId)
    .all<{ full_name: string | null; profile: string; email: string | null }>();
  const examples: string[] = [];
  for (const r of results ?? []) {
    const p = parseJson<SourcedProfile>(r.profile, { source: "web" });
    examples.push(`— ${r.full_name ?? "?"} :\n${renderModel(model.modele, { prenom: (r.full_name ?? "").split(" ")[0], accroche: await accroche(env, f, p, missionId) })}`);
  }
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS go, SUM(c.email IS NOT NULL) AS mail, SUM(c.linkedin_url IS NOT NULL) AS li FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.mission_id = ? AND a.state = 'go'",
  )
    .bind(missionId)
    .first<{ go: number; mail: number | null; li: number | null }>();
  const vid = await createValidation(env, "message", missionId, null, model);
  await notify(
    env,
    [
      reminder ? `⏰ Rappel ${reminder} · message de premier contact en attente` : `✉️ Message de premier contact · ${m.title}`,
      `${counts?.go ?? 0} profil(s) Go · email connu : ${counts?.mail ?? 0} · LinkedIn : ${counts?.li ?? 0}`,
      "",
      `Objet : ${model.objet}`,
      model.modele,
      examples.length ? `\nExemples personnalisés :\n${examples.join("\n\n")}` : "",
      "\nCanal : « Auto » = email si l'adresse est connue, sinon LinkedIn (file de l'extension). Les relances reprennent ce ton automatiquement.",
    ]
      .filter(Boolean)
      .join("\n"),
    [
      [{ text: "✅ Valider (canal auto)", data: `v:${vid}:ok` }],
      [
        { text: "📧 Tout par email", data: `v:${vid}:em` },
        { text: "💼 Tout LinkedIn", data: `v:${vid}:li` },
      ],
      [{ text: "✏️ Modifier", data: `v:${vid}:mod` }],
    ],
  );
}

/** Message validé : enregistré sur la mission avec le canal ; les profils Go sont planifiés. */
export async function applyMessage(env: Env, missionId: string, model: MessageModel, mode: ChannelMode): Promise<{ planned: number; email: number; linkedin: number; none: number }> {
  await env.DB.prepare("UPDATE missions SET message_objet = ?, message_template = ?, channel_mode = ?, message_ok = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(model.objet, model.modele, mode, missionId)
    .run();
  const { results } = await env.DB.prepare("SELECT id FROM applications WHERE mission_id = ? AND state = 'go'").bind(missionId).all<{ id: string }>();
  if (mode !== "linkedin") await findMissingEmails(env, missionId, (results ?? []).map((r) => r.id));
  const out = await planGoContacts(env, missionId);
  await journal(env, "recruteur", "message_valide", { canal: mode, ...out }, { mission: missionId });
  return out;
}

/** Profils récemment écartés (No go) sur la mission : exemples pour affiner le tri (apprentissage par les No go). */
export async function recentNogo(env: Env, missionId: string, limit = 12): Promise<string> {
  const { results } = await env.DB.prepare("SELECT detail FROM journal WHERE action = 'nogo' AND mission_id = ? ORDER BY id DESC LIMIT ?")
    .bind(missionId, limit)
    .all<{ detail: string | null }>();
  return (results ?? [])
    .map((r) => parseJson<{ motif?: string; intitule?: string; competences?: string[]; annees?: number }>(r.detail, {}))
    .filter((d) => d.motif && d.motif !== "non revu")
    .map((d) => `- ${d.intitule ?? "?"} (${(d.competences ?? []).slice(0, 5).join(", ")}${d.annees ? `, ${d.annees} ans` : ""}) → écarté : ${d.motif}`)
    .join("\n");
}


/** Nombre de profils en attente de revue. */
export async function reviewPending(env: Env, missionId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE mission_id = ? AND state = 'en_revue'").bind(missionId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Rappel de revue (toutes les 2 h sans décision). */
export async function remindReview(env: Env, missionId: string, n: number): Promise<void> {
  const left = await reviewPending(env, missionId);
  if (!left) return;
  await notify(env, `⏰ Rappel ${n} · ${left} profil(s) attendent ton Go / No go (cartes plus haut).`, [
    [{ text: `✅ Go pour les ${Math.min(5, left)} meilleurs`, data: `rvall:${missionId}:5` }],
    [{ text: "🏁 Terminer la revue", data: `rvfin:${missionId}` }],
  ]);
}
