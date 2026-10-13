import { ai } from "./ai/router";
import type { ChatFile } from "./ai/providers";
import type { Fiche, Question } from "./fiche";

/** F5 — Notation des réponses au questionnaire (grille commune) et décision proposée. */

export interface Notation {
  notes: { id: string; note: number; commentaire: string }[];
  synthese: string;
  points_forts: string[];
  doutes: string[];
  posture_a_verifier: boolean;
}

export interface Qualification {
  answerScore: number;
  finalScore: number;
  knockouts: string[];
  consent: boolean;
  decision: "qualifie" | "rejet_propose";
  phoneSuggested: boolean;
  notation: Notation;
}

const yes = (v: string | undefined) => /^(oui|yes|o|y|true)$/i.test((v ?? "").trim());

export function knockoutFailures(questions: Question[], answers: Record<string, string>): string[] {
  return questions
    .filter((q) => q.bloc === 1 && q.type === "oui_non")
    .filter((q) => (q.attendu ?? "oui") === "oui" ? !yes(answers[q.id]) : yes(answers[q.id]))
    .map((q) => q.texte);
}

export function decide(questions: Question[], answers: Record<string, string>, notation: Notation, matchScore: number | null): Qualification {
  const knockouts = knockoutFailures(questions, answers);
  const consentQ = questions.find((q) => q.bloc === 4);
  const consent = consentQ ? yes(answers[consentQ.id]) : true;
  const bloc2 = questions.filter((q) => q.bloc === 2).map((q) => q.id);
  const notes = notation.notes.filter((n) => bloc2.includes(n.id)).map((n) => Math.min(5, Math.max(1, Math.round(n.note))));
  const answerScore = notes.length ? Math.round((notes.reduce((a, b) => a + b, 0) / notes.length) * 20) : 0;
  const finalScore = Math.round(matchScore == null ? answerScore : 0.6 * answerScore + 0.4 * matchScore);
  const decision = knockouts.length || !consent || answerScore < 40 ? "rejet_propose" : "qualifie";
  const phoneSuggested = decision === "qualifie" && (finalScore < 70 || notation.posture_a_verifier);
  return { answerScore, finalScore, knockouts, consent, decision, phoneSuggested, notation };
}

export async function rateAnswers(env: import("./env").Env, f: Fiche, questions: Question[], answers: Record<string, string>, cv?: ChatFile, missionId?: string): Promise<Notation> {
  const qa = questions
    .filter((q) => q.bloc === 2 || q.bloc === 3)
    .map((q) => `[${q.id}] (bloc ${q.bloc}) ${q.texte}${q.ancrage ? `\nRéponse à 5/5 : ${q.ancrage}` : ""}\nRéponse : ${(answers[q.id] ?? "").slice(0, 2500) || "(vide)"}`)
    .join("\n\n");
  const { data } = await ai<Notation>(env, {
    family: "jugement",
    label: "notation questionnaire",
    missionId,
    system: `Tu évalues des réponses de candidats consultants avec une grille commune, de façon juste et sans complaisance.
Note chaque question de 1 à 5 selon l'ancrage fourni ; une réponse vague ou sans fait concret ne dépasse pas 2.
Les faits et exemples précis comptent plus que les affirmations.${cv ? " Le CV joint sert à vérifier la cohérence des réponses." : ""}
Réponds uniquement en JSON : { "notes": [{ "id": "", "note": 1, "commentaire": "" }], "synthese": "", "points_forts": [""], "doutes": [""], "posture_a_verifier": false }`,
    prompt: `Mission : ${f.intitule} — obligatoire : ${f.competences_obligatoires.join(", ")} ; soft skills : ${f.soft_skills.join(", ")}\n\n${qa}`,
    json: true,
    file: cv,
    maxTokens: 2500,
    validate: (d) => (Array.isArray(d?.notes) && typeof d.synthese === "string" ? null : "notation incomplète"),
  });
  return {
    notes: data.notes.map((n) => ({ id: String(n.id), note: Number(n.note) || 1, commentaire: String(n.commentaire ?? "") })),
    synthese: data.synthese,
    points_forts: Array.isArray(data.points_forts) ? data.points_forts : [],
    doutes: Array.isArray(data.doutes) ? data.doutes : [],
    posture_a_verifier: !!data.posture_a_verifier,
  };
}
