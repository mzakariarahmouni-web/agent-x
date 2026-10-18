import type { ChatFile } from "./ai/providers";
import { generateCv } from "./cv";
import { getConfig, getSetting, journal, nowIso, parseJson, setSetting } from "./db";
import type { Env } from "./env";
import { buildFiche, buildQuestionnaire, type Fiche, ficheSummary, parseSender, readFiche } from "./fiche";
import { decide, rateAnswers } from "./qualification";
import { eliminationSummary } from "./pool";
import { sendReviewCards } from "./review";
import { addBusinessHours, frDate, nextSlot, type ScheduleConfig } from "./schedule";
import { buildBooleanQueries, enrichFromPublicPages, scoreAndStore, searchCvtheque, sourceRound, type SourcedProfile, type SourcingRound } from "./sourcing";
import { bot, type Button, notify, send, sendDocument } from "./telegram";
import { createValidation, proposeRejection, validationButtons } from "./validations";

/**
 * Étapes métier d'une mission, appelées par le Workflow (workflow.ts). Chaque fonction est rejouable :
 * elle relit l'état en base et ne refait pas ce qui est déjà fait.
 */

export interface MissionRow {
  id: string;
  client_id: string | null;
  title: string;
  raw_text: string;
  fiche: string;
  version: number;
  sender_name: string | null;
  status: string;
  deadline_at: string | null;
}

export async function getMission(env: Env, id: string): Promise<MissionRow> {
  const m = await env.DB.prepare("SELECT id, client_id, title, raw_text, fiche, version, sender_name, status, deadline_at FROM missions WHERE id = ?").bind(id).first<MissionRow>();
  if (!m) throw new Error(`mission ${id} introuvable`);
  return m;
}

async function clientLearned(env: Env, clientId: string | null): Promise<string | undefined> {
  if (!clientId) return undefined;
  const c = await env.DB.prepare("SELECT learned FROM clients WHERE id = ?").bind(clientId).first<{ learned: string }>();
  const l = parseJson<{ evolutions?: string[] }>(c?.learned, {});
  return l.evolutions?.length ? l.evolutions.slice(-10).map((e) => `- ${e}`).join("\n") : undefined;
}

async function missionFile(env: Env, id: string): Promise<ChatFile | undefined> {
  const f = await env.FILES.get<{ mime: string; base64: string }>(`brief:${id}`, "json");
  return f ?? undefined;
}

/** F1 : fiche modèle + questionnaire, enregistrés (version 1). */
export async function analyzeMission(env: Env, id: string): Promise<Fiche> {
  const m = await getMission(env, id);
  const existing = readFiche(m.fiche);
  if (existing.intitule && existing.questionnaire.length) return existing;
  const fiche = await buildFiche(env, { raw: m.raw_text, file: await missionFile(env, id), clientLearned: await clientLearned(env, m.client_id), missionId: id });
  fiche.questionnaire = await buildQuestionnaire(env, fiche, id);
  await saveFiche(env, id, fiche, 1, "fiche initiale");
  return fiche;
}

export async function saveFiche(env: Env, id: string, fiche: Fiche, version: number, reason: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE missions SET fiche = ?, version = ?, title = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(fiche), version, fiche.intitule || "Mission", id),
    env.DB.prepare("INSERT OR REPLACE INTO mission_versions (mission_id, version, fiche, reason) VALUES (?, ?, ?, ?)").bind(id, version, JSON.stringify(fiche), reason),
  ]);
  if (fiche.client) {
    const m = await getMission(env, id);
    if (!m.client_id) {
      const cid = `cl_${fiche.client.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
      await env.DB.prepare("INSERT OR IGNORE INTO clients (id, name) VALUES (?, ?)").bind(cid, fiche.client).run();
      const row = await env.DB.prepare("SELECT id FROM clients WHERE lower(name) = lower(?)").bind(fiche.client).first<{ id: string }>();
      await env.DB.prepare("UPDATE missions SET client_id = ? WHERE id = ?").bind(row?.id ?? cid, id).run();
    }
  }
}

/** Validation n°1 : fiche, questionnaire, nom d'expéditeur. */
export async function sendFicheValidation(env: Env, id: string, reminder = 0): Promise<void> {
  const m = await getMission(env, id);
  const f = readFiche(m.fiche);
  const sender = m.sender_name || (await getSetting(env, "sender_default")) || "(à préciser)";
  const vid = await createValidation(env, "fiche", id, null);
  const q = f.questionnaire.map((x, i) => `${i + 1}. ${x.texte}`).join("\n");
  const text = [
    reminder ? `⏰ Rappel ${reminder} · la mission attend ta validation` : "🆕 Validation n°1 · fiche modèle",
    "",
    ficheSummary(f),
    f.questions_clarification.length ? `\n❓ Questions (réponds avec « Modifier », sinon je garde mes hypothèses) :\n${f.questions_clarification.map((x) => `• ${x}`).join("\n")}` : "",
    `\n📝 Questionnaire candidat :\n${q}`,
    `\n✉️ Expéditeur des messages : ${sender}`,
    "\nPour modifier, touche « Modifier » puis écris la correction (ex. « TJM max 650 », « expéditeur : Zacharie R. », « retire la question 3 »).",
  ]
    .filter(Boolean)
    .join("\n");
  await notify(env, text, validationButtons(vid, { ok: "✅ Valider et lancer", mod: "✏️ Modifier", no: "🗑 Abandonner" }));
}

/** Signature de la mission ; devient aussi la signature par défaut si aucune n'est encore enregistrée. */
export async function setMissionSender(env: Env, id: string, sender: string): Promise<void> {
  await env.DB.prepare("UPDATE missions SET sender_name = ? WHERE id = ?").bind(sender, id).run();
  if (!(await getSetting(env, "sender_default"))) await setSetting(env, "sender_default", sender);
  await journal(env, "recruteur", "signature", { signature: sender }, { mission: id });
}

/** Modification demandée à la validation n°1 (texte libre du recruteur). */
export async function applyFicheChange(env: Env, id: string, instruction: string): Promise<void> {
  const m = await getMission(env, id);
  const { sender, rest } = parseSender(instruction);
  if (sender) await setMissionSender(env, id, sender);
  if (!rest) return;
  const prev = readFiche(m.fiche);
  const removeQ = /retire(?:r)? la question (\d+)/i.exec(rest);
  if (removeQ && rest.replace(removeQ[0], "").trim().length < 3) {
    prev.questionnaire.splice(Number(removeQ[1]) - 1, 1);
    await saveFiche(env, id, prev, m.version, `question ${removeQ[1]} retirée`);
    return;
  }
  const next = await buildFiche(env, { raw: m.raw_text, previous: prev, instruction: rest, clientLearned: await clientLearned(env, m.client_id), missionId: id });
  next.questionnaire = await buildQuestionnaire(env, next, id);
  await saveFiche(env, id, next, m.version, `modification avant lancement : ${rest.slice(0, 200)}`);
}

/** Lancement : statut « en cours » et échéance de 48 h ouvrées. */
export async function startMission(env: Env, id: string, now = new Date()): Promise<string> {
  const cfg = await getConfig(env);
  const deadline = addBusinessHours(now, cfg.schedule.deadline_business_hours, cfg.schedule.extra_holidays);
  const m = await getMission(env, id);
  const sender = m.sender_name || (await getSetting(env, "sender_default"));
  await env.DB.prepare("UPDATE missions SET status = 'en_cours', deadline_at = ?, sender_name = ?, updated_at = datetime('now') WHERE id = ?").bind(nowIso(deadline), sender, id).run();
  await journal(env, "agent", "mission_lancee", { echeance: nowIso(deadline) }, { mission: id });
  return nowIso(deadline);
}

/** F3 (1/2) : CV-thèque d'abord. */
export async function sourceFromCvtheque(env: Env, id: string): Promise<number> {
  const cfg = await getConfig(env);
  const f = readFiche((await getMission(env, id)).fiche);
  const items = (await searchCvtheque(env, f)).map((x) => ({ candidateId: x.id, profile: x.profile }));
  await scoreAndStore(env, id, f, items, cfg.matching.weights, cfg.matching.tjm_tolerance);
  return items.length;
}

/** F3 (2/2) : profils publics, recherche booléenne. Tour 1 toujours ; tour 2 seulement si le vivier est trop maigre. */
export async function sourceFromWeb(env: Env, id: string, round: SourcingRound = 1): Promise<number> {
  const cfg = await getConfig(env);
  const mission = await getMission(env, id);
  if (mission.status !== "en_cours") return 0; // mission clôturée : plus aucune recherche
  const f = readFiche(mission.fiche);
  if (round >= 2) {
    const good = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE mission_id = ? AND state = 'score' AND score >= ?")
      .bind(id, cfg.matching.contact_threshold)
      .first<{ n: number }>();
    if ((good?.n ?? 0) >= cfg.mission.pool_target) return 0;
  }
  const items = await sourceRound(env, id, f, round, Math.ceil(cfg.search.queries_per_mission / 2));
  await scoreAndStore(env, id, f, items, cfg.matching.weights, cfg.matching.tjm_tolerance);
  return items.length;
}

/**
 * F3 (lecture) : pages publiques des meilleurs profils lues sans connexion, profils enrichis puis re-scorés.
 * Seuls les profils proches du seuil ou au-dessus sont lus, pour économiser les quotas.
 */
export async function enrichTopProfiles(env: Env, id: string, max = 10): Promise<number> {
  const cfg = await getConfig(env);
  const f = readFiche((await getMission(env, id)).fiche);
  const { results } = await env.DB.prepare(
    `SELECT a.candidate_id, COALESCE(c.linkedin_url, c.source_url) AS url FROM applications a JOIN candidates c ON c.id = a.candidate_id
     WHERE a.mission_id = ? AND a.state = 'score' AND a.score >= ? AND COALESCE(c.linkedin_url, c.source_url) IS NOT NULL
     ORDER BY a.score DESC LIMIT ?`,
  )
    .bind(id, cfg.mission.review_min_score ?? 30, max)
    .all<{ candidate_id: string; url: string }>();
  const enriched = await enrichFromPublicPages(env, id, (results ?? []).map((r) => ({ candidateId: r.candidate_id, url: r.url })));
  if (enriched.length) await scoreAndStore(env, id, f, enriched, cfg.matching.weights, cfg.matching.tjm_tolerance);
  return enriched.length;
}

/** Vivier de la mission : profils à revoir (au-dessus du seuil), écartés, et profils actifs (Go et au-delà). */
export async function poolStats(env: Env, id: string): Promise<{ toReview: number; eliminated: number; active: number; pending: number }> {
  const cfg = await getConfig(env);
  const r = await env.DB.prepare(
    `SELECT SUM(state = 'score' AND score >= ?) AS review, SUM(state = 'ecarte') AS eliminated, SUM(state = 'en_revue') AS pending,
       SUM(state IN ('go','a_contacter','contacte','repondu','reponses_recues','qualifie','cv_formate','en_attente')) AS active
     FROM applications WHERE mission_id = ?`,
  )
    .bind(cfg.mission.review_min_score ?? 30, id)
    .first<{ review: number | null; eliminated: number | null; pending: number | null; active: number | null }>();
  return { toReview: Math.min(r?.review ?? 0, cfg.mission.review_batch), eliminated: r?.eliminated ?? 0, active: r?.active ?? 0, pending: r?.pending ?? 0 };
}

/** Ancien mode sans revue (conservé pour les tests) : vivier au-dessus du seuil planifié directement. Le Workflow passe désormais par la revue Go / No go. */
export async function planOutreach(env: Env, id: string, now = new Date()): Promise<{ planned: number; scored: number; eliminated: number }> {
  const cfg = await getConfig(env);
  const counts = await env.DB.prepare(
    "SELECT SUM(state = 'score') AS scored, SUM(state = 'ecarte') AS eliminated, SUM(state IN ('a_contacter','contacte','repondu','reponses_recues','qualifie','cv_formate')) AS active FROM applications WHERE mission_id = ?",
  )
    .bind(id)
    .first<{ scored: number; eliminated: number; active: number }>();
  const room = Math.max(0, cfg.mission.pool_target - (counts?.active ?? 0));
  const slot = nextSlot(now, "premier_contact", cfg.schedule as ScheduleConfig);
  const { results } = await env.DB.prepare(
    `SELECT a.id FROM applications a JOIN candidates c ON c.id = a.candidate_id
     WHERE a.mission_id = ? AND a.state = 'score' AND a.score >= ? AND (c.email IS NOT NULL OR c.linkedin_url IS NOT NULL)
     ORDER BY (c.qualified_at IS NOT NULL) DESC, a.score DESC LIMIT ?`,
  )
    .bind(id, cfg.matching.contact_threshold, room)
    .all<{ id: string }>();
  // Envois étalés de 4 minutes pour rester naturels.
  const stmts = (results ?? []).map((r, i) =>
    env.DB.prepare("UPDATE applications SET state = 'a_contacter', next_action_at = ?, updated_at = datetime('now') WHERE id = ?").bind(nowIso(new Date(slot.getTime() + i * 4 * 60_000)), r.id),
  );
  if (stmts.length) await env.DB.batch(stmts);
  return { planned: stmts.length, scored: counts?.scored ?? 0, eliminated: counts?.eliminated ?? 0 };
}

export async function reportSourcing(
  env: Env,
  id: string,
  stats: { cvtheque: number; web: number; widened: number; enriched: number; toReview: number; eliminated: number },
): Promise<void> {
  const m = await getMission(env, id);
  const strict = buildBooleanQueries(readFiche(m.fiche), 1, 1)[0];
  const booleanLine = strict ? strict.boolean : "";
  await notify(
    env,
    [
      `🔎 ${m.title} · sourcing terminé`,
      `CV-thèque : ${stats.cvtheque} profil(s) · Web public (booléen) : ${stats.web} profil(s)${stats.widened ? ` dont ${stats.widened} au tour élargi` : ""}`,
      `Pages publiques lues sans connexion : ${stats.enriched} profil(s) enrichi(s)`,
      `Écartés (critères éliminatoires) : ${stats.eliminated}${stats.eliminated ? ` (${await eliminationSummary(env, id)})` : ""}`,
      stats.toReview
        ? `À revoir : les ${stats.toReview} meilleur(s) profil(s) → cartes Go / No go ci-dessous`
        : "Aucun profil assez proche de la fiche pour l'instant : je relance tout de suite avec d'autres variantes (intitulés, compétences, sites), puis toutes les 6 h.",
      `Échéance shortlist : ${m.deadline_at ? frDate(new Date(m.deadline_at)) : "—"}`,
      booleanLine ? `\nRecherche booléenne principale :\n${booleanLine}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    booleanLine ? [[{ text: "📋 Copier la recherche booléenne", copy: booleanLine }]] : [],
  );
}

interface AnswerRow {
  id: string;
  candidate_id: string;
  answers: string;
  score: number | null;
  full_name: string | null;
  headline: string | null;
}

/** F5 : notation des questionnaires reçus ; qualifié, ou rejet proposé (validation n°2). */
export async function qualifyPending(env: Env, id: string): Promise<{ qualified: number; proposedRejections: number }> {
  const m = await getMission(env, id);
  const f = readFiche(m.fiche);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.candidate_id, a.answers, a.score, c.full_name, c.headline FROM applications a JOIN candidates c ON c.id = a.candidate_id
     WHERE a.mission_id = ? AND a.state = 'reponses_recues' LIMIT 5`,
  )
    .bind(id)
    .all<AnswerRow>();
  let qualified = 0;
  let proposedRejections = 0;
  for (const r of results ?? []) {
    const answers = parseJson<Record<string, string>>(r.answers, {});
    const cv = await env.FILES.get<{ mime: string; base64: string }>(`upload:${r.candidate_id}`, "json");
    let notation;
    try {
      notation = await rateAnswers(env, f, f.questionnaire, answers, cv ?? undefined, id);
    } catch (e) {
      if (!cv) throw e;
      notation = await rateAnswers(env, f, f.questionnaire, answers, undefined, id);
    }
    const q = decide(f.questionnaire, answers, notation, r.score);
    const who = `${r.full_name ?? "Candidat"}${r.headline ? ` · ${r.headline}` : ""}`;
    await env.DB.prepare("UPDATE applications SET answer_score = ?, synthesis = ?, state = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(q.finalScore, JSON.stringify({ ...notation, knockouts: q.knockouts, consent: q.consent, telephone: q.phoneSuggested }), q.decision === "qualifie" ? "qualifie" : "en_attente", r.id)
      .run();
    if (q.decision === "qualifie") {
      qualified++;
      await env.DB.prepare("UPDATE candidates SET qualified_at = datetime('now'), consent_at = CASE WHEN ? THEN datetime('now') ELSE consent_at END WHERE id = ?").bind(q.consent ? 1 : 0, r.candidate_id).run();
      const rows: Button[][] = q.phoneSuggested ? [[{ text: "📞 Préparer l'appel", data: `call:${r.id}` }]] : [];
      await notify(env, `✅ Qualifié · ${who}\nScore ${q.finalScore}/100 (réponses ${q.answerScore})\n${notation.synthese}${q.phoneSuggested ? "\n\n📞 Un appel de 15 min est conseillé (score limite ou posture client à vérifier)." : ""}`, rows);
    } else {
      proposedRejections++;
      const reasons = [...q.knockouts.map((k) => `« ${k} » : non`), ...(q.consent ? [] : ["pas d'accord pour être présenté"]), ...(q.answerScore < 40 ? [`réponses faibles (${q.answerScore}/100)`] : [])];
      await proposeRejection(env, id, r.id, who, reasons);
    }
  }
  return { qualified, proposedRejections };
}

/** F2 : évolution du besoin en cours de mission (nouvelle version, re-scoring, apprentissage client). */
export async function applyEvolution(env: Env, id: string, instruction: string): Promise<string> {
  const cfg = await getConfig(env);
  const m = await getMission(env, id);
  const prev = readFiche(m.fiche);
  const next = await buildFiche(env, { raw: m.raw_text, previous: prev, instruction, missionId: id });
  next.questionnaire = prev.questionnaire;
  await saveFiche(env, id, next, m.version + 1, `évolution : ${instruction.slice(0, 200)}`);
  // Re-scoring du vivier existant avant tout nouveau sourcing.
  const { results } = await env.DB.prepare(
    "SELECT a.candidate_id, a.state, c.profile, c.full_name FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.mission_id = ?",
  )
    .bind(id)
    .all<{ candidate_id: string; state: string; profile: string; full_name: string | null }>();
  const items = (results ?? []).map((r) => ({ candidateId: r.candidate_id, profile: parseJson<SourcedProfile>(r.profile, { source: "cvtheque" }) }));
  const scored = await scoreAndStore(env, id, next, items, cfg.matching.weights, cfg.matching.tjm_tolerance);
  const out = scored.filter((s) => s.match.eliminated).map((s) => s.candidateId);
  const contacted = (results ?? []).filter((r) => out.includes(r.candidate_id) && ["contacte", "repondu", "reponses_recues", "qualifie"].includes(r.state));
  if (contacted.length) {
    await env.DB.batch(
      contacted.map((r) => env.DB.prepare("UPDATE applications SET state = 'hors_perimetre', next_action_at = NULL WHERE mission_id = ? AND candidate_id = ?").bind(id, r.candidate_id)),
    );
  }
  // Apprentissage du comportement client : la trajectoire des évolutions est réutilisée aux missions suivantes.
  if (m.client_id) {
    const c = await env.DB.prepare("SELECT learned FROM clients WHERE id = ?").bind(m.client_id).first<{ learned: string }>();
    const learned = parseJson<{ evolutions?: string[] }>(c?.learned, {});
    learned.evolutions = [...(learned.evolutions ?? []), `${new Date().toISOString().slice(0, 10)} (${next.intitule}) : ${instruction.slice(0, 200)}`].slice(-30);
    await env.DB.prepare("UPDATE clients SET learned = ? WHERE id = ?").bind(JSON.stringify(learned), m.client_id).run();
  }
  // Les nouveaux profils au-dessus du seuil repassent par ta revue (Go / No go) avant tout contact.
  const cards = await sendReviewCards(env, id);
  await journal(env, "agent", "evolution", { instruction, version: m.version + 1, hors_perimetre: contacted.length }, { mission: id });
  return [
    `🔄 ${next.intitule} · version ${m.version + 1}`,
    ficheSummary(next),
    "",
    `Vivier re-scoré : ${items.length} profil(s) · ${cards} nouveau(x) profil(s) à revoir (cartes envoyées).`,
    contacted.length ? `${contacted.length} candidat(s) déjà contacté(s) sortent du périmètre : ils restent en CV-thèque (${contacted.map((c) => c.full_name ?? "?").join(", ")}).` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface MissionProgress {
  qualified: number;
  inProgress: number;
  deadline: string | null;
}

export async function progress(env: Env, id: string): Promise<MissionProgress> {
  const m = await getMission(env, id);
  const r = await env.DB.prepare(
    "SELECT SUM(state IN ('qualifie','cv_formate')) AS q, SUM(state IN ('go','a_contacter','contacte','repondu','reponses_recues','en_attente')) AS p FROM applications WHERE mission_id = ?",
  )
    .bind(id)
    .first<{ q: number | null; p: number | null }>();
  return { qualified: r?.q ?? 0, inProgress: r?.p ?? 0, deadline: m.deadline_at };
}

interface ShortRow {
  id: string;
  candidate_id: string;
  answers: string | null;
  synthesis: string | null;
  answer_score: number | null;
  score: number | null;
  cv_key: string | null;
  profile: string;
  full_name: string | null;
}

/** F6 : CV anonymisés des meilleurs qualifiés (jusqu'à la taille de shortlist). */
export async function buildShortlist(env: Env, id: string, excluded: string[] = []): Promise<string[]> {
  const cfg = await getConfig(env);
  const f = readFiche((await getMission(env, id)).fiche);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.candidate_id, a.answers, a.synthesis, a.answer_score, a.score, a.cv_key, c.profile, c.full_name FROM applications a JOIN candidates c ON c.id = a.candidate_id
     WHERE a.mission_id = ? AND a.state IN ('qualifie', 'cv_formate') ORDER BY COALESCE(a.answer_score, a.score) DESC LIMIT ?`,
  )
    .bind(id, cfg.mission.shortlist_size + excluded.length)
    .all<ShortRow>();
  const chosen = (results ?? []).filter((r) => !excluded.includes(r.id)).slice(0, cfg.mission.shortlist_size);
  for (const r of chosen) {
    if (r.cv_key && (await env.FILES.get(r.cv_key, "arrayBuffer"))) continue;
    const p = { ...parseJson<SourcedProfile>(r.profile, { source: "cvtheque" }), full_name: r.full_name };
    const syn = parseJson<{ synthese?: string }>(r.synthesis, {});
    const upload = await env.FILES.get<{ mime: string; base64: string }>(`upload:${r.candidate_id}`, "json");
    const cv = await generateCv(env, f, p, parseJson<Record<string, string>>(r.answers, {}), syn.synthese ?? "", upload ?? undefined, id);
    const key = `cv:${r.id}`;
    await env.FILES.put(key, cv.bytes, { expirationTtl: cfg.rgpd.files_ttl_days * 86_400, metadata: { filename: cv.filename, coverage: cv.coverage, missing: cv.missing.slice(0, 15), ecarts: cv.ecarts.slice(0, 15) } });
    await env.DB.prepare("UPDATE applications SET cv_key = ?, state = 'cv_formate', updated_at = datetime('now') WHERE id = ?").bind(key, r.id).run();
  }
  return chosen.map((r) => r.id);
}

/** Validations n°3 et 4 : la shortlist et ses CV, envoyés sur Telegram avec les boutons. */
export async function sendShortlistValidation(env: Env, id: string, appIds: string[], reminder = 0): Promise<void> {
  const b = await bot(env);
  if (!b) return;
  const m = await getMission(env, id);
  const lines: string[] = [];
  for (const [i, appId] of appIds.entries()) {
    const r = await env.DB.prepare("SELECT a.answer_score, a.synthesis, a.cv_key, c.full_name, c.headline FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = ?")
      .bind(appId)
      .first<{ answer_score: number | null; synthesis: string | null; cv_key: string | null; full_name: string | null; headline: string | null }>();
    if (!r) continue;
    const syn = parseJson<{ synthese?: string; telephone?: boolean }>(r.synthesis, {});
    lines.push(`${i + 1}. ${r.full_name ?? "?"} · ${r.headline ?? ""} · ${r.answer_score ?? "?"}/100\n   ${syn.synthese ?? ""}`);
    if (r.cv_key && !reminder) {
      const file = await env.FILES.getWithMetadata<{ filename: string; coverage: number; missing: string[]; ecarts: string[] }>(r.cv_key, "arrayBuffer");
      if (file.value) {
        const meta = file.metadata;
        await sendDocument(
          env,
          b,
          new Uint8Array(file.value),
          meta?.filename ?? `CV_${i + 1}.docx`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          `n°${i + 1} · adéquation au descriptif : ${meta?.coverage ?? "?"} %${meta?.missing?.length ? `\nMots-clés sans preuve (non ajoutés) : ${meta.missing.slice(0, 8).join(", ")}` : ""}`,
        );
      }
    }
  }
  const vid = await createValidation(env, "shortlist", id, null, { apps: appIds });
  const deadline = m.deadline_at ? new Date(m.deadline_at) : null;
  const late = deadline && deadline.getTime() - Date.now() < 4 * 3_600_000;
  await send(
    env,
    b,
    [
      reminder ? `⏰ Rappel ${reminder} · shortlist en attente` : `📦 Validations n°3 et 4 · shortlist ${m.title}`,
      late && deadline ? `⚠️ Échéance des 48 h ouvrées : ${frDate(deadline)}` : "",
      "",
      ...lines,
      "",
      "Valider = shortlist approuvée et CV prêts à transmettre au client (anonymisés ; coordonnées sur demande).",
      "Modifier = par exemple « retire 2 ».",
    ]
      .filter(Boolean)
      .join("\n"),
    validationButtons(vid, { ok: "✅ Valider et envoyer", mod: "✏️ Modifier" }),
  );
}

export async function markPresented(env: Env, id: string, appIds: string[]): Promise<void> {
  const b = await bot(env);
  await env.DB.batch([
    ...appIds.map((a) => env.DB.prepare("UPDATE applications SET state = 'presente', updated_at = datetime('now') WHERE id = ?").bind(a)),
    env.DB.prepare("UPDATE missions SET status = 'shortlist_envoyee', updated_at = datetime('now') WHERE id = ?").bind(id),
  ]);
  if (!b) return;
  for (const [i, a] of appIds.entries()) {
    const r = await env.DB.prepare("SELECT c.full_name FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = ?").bind(a).first<{ full_name: string | null }>();
    await send(env, b, `n°${i + 1} · ${r?.full_name ?? "?"} : décision du client ?`, [
      [
        { text: "🏆 Placé", data: `dc:${a}:place` },
        { text: "✖️ Non retenu", data: `dc:${a}:non` },
      ],
    ]);
  }
}

/** Fichier joint à une mission (fiche PDF ou capture envoyée au bot). */
export async function storeBriefFile(env: Env, id: string, bytes: Uint8Array, mime: string): Promise<void> {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await env.FILES.put(`brief:${id}`, JSON.stringify({ mime, base64: btoa(s) }), { expirationTtl: 30 * 86_400 });
}

