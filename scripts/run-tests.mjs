// Tests d'Agent X : calendrier et 48 h ouvrées, matching, relais IA, .docx, qualification,
// puis parcours complet d'une mission avec base SQLite locale et API simulées (aucun appel réel, aucune dépense).
// Usage : node scripts/run-tests.mjs
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.removeAllListeners("warning");
const dir = mkdtempSync(join(tmpdir(), "agentx-"));
const out = join(dir, "bundle.mjs");
await build({
  entryPoints: ["scripts/test-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "error",
  loader: { ".html": "text", ".sql": "text" },
  plugins: [
    {
      name: "cloudflare-workers-stub",
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cf", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class WorkflowEntrypoint { constructor(ctx, env) { this.env = env; } }", loader: "js" }));
      },
    },
  ],
});
const X = await import(out);
const SCHEMA = readFileSync("migrations/0001_init.sql", "utf8");

// ───────────── Outils de test ─────────────
let failed = 0;
let passed = 0;
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("✅", name);
  } catch (e) {
    failed++;
    console.log("❌", name, "→", e.stack?.split("\n").slice(0, 3).join(" | ") ?? e);
  }
}

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...a) {
    return new Stmt(this.db, this.sql, a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)));
  }
  _s() {
    return this.db.prepare(this.sql);
  }
  async first(col) {
    const r = this._s().get(...this.args);
    if (!r) return null;
    const o = { ...r };
    return col ? o[col] : o;
  }
  async all() {
    return { results: this._s().all(...this.args).map((r) => ({ ...r })), success: true };
  }
  async run() {
    const r = this._s().run(...this.args);
    return { success: true, meta: { changes: r.changes } };
  }
}
class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const res = [];
      for (const s of stmts) res.push(await s.run());
      this.db.exec("COMMIT");
      return res;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
class FakeKV {
  constructor() {
    this.m = new Map();
  }
  async get(k, t) {
    const type = typeof t === "object" ? t.type : t;
    const e = this.m.get(k);
    if (!e) return null;
    if (type === "json") return JSON.parse(typeof e.v === "string" ? e.v : new TextDecoder().decode(e.v));
    if (type === "arrayBuffer") return typeof e.v === "string" ? new TextEncoder().encode(e.v).buffer : e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength);
    return typeof e.v === "string" ? e.v : new TextDecoder().decode(e.v);
  }
  async getWithMetadata(k, t) {
    return { value: await this.get(k, t), metadata: this.m.get(k)?.meta ?? null };
  }
  async put(k, v, o = {}) {
    this.m.set(k, { v: v instanceof ArrayBuffer ? new Uint8Array(v) : v, meta: o.metadata });
  }
  async delete(k) {
    this.m.delete(k);
  }
}

// Réponses simulées des modèles, selon la tâche demandée.
const FICHE = {
  intitule: "Chef de projet AMOA",
  client: "Banque Exemple",
  secteur: "Banque",
  contexte: "Refonte du SI de paiements",
  missions: ["Recueil des besoins", "Pilotage de la recette"],
  localisation: "Paris",
  teletravail: "2 jours par semaine",
  date_debut: "15 novembre",
  duree: "12 mois",
  statuts_acceptes: ["freelance"],
  budget: { tjm_min: 550, tjm_max: 650, salaire_min: null, salaire_max: null },
  seniorite_min_annees: 5,
  competences_obligatoires: ["AMOA", "recette", "SAP"],
  competences_souhaitees: ["Jira", "paiements"],
  langues: ["anglais"],
  soft_skills: ["communication"],
  eliminatoires: [{ critere: "Freelance uniquement", type: "statut", valeur: "freelance" }],
  mots_cles: ["AMOA", "recette", "SAP", "Jira", "paiements", "banque"],
  synonymes: ["MOA", "Business Analyst"],
  niveau_elargi: { intitules_proches: ["Business Analyst"], competences_adjacentes: ["MOA"], seniorite_min_annees: 4 },
  niveau_exigeant: { criteres_durcis: ["Expérience SEPA"] },
  questions_clarification: ["Date de démarrage ferme ?"],
  hypotheses: ["Démarrage mi-novembre"],
};

function respond(system, prompt) {
  if (/fiche modèle structurée/.test(system)) return FICHE;
  if (/questionnaires de pré-qualification/.test(system))
    return {
      questions: [
        { id: "b2_1", bloc: 2, texte: "Décrivez une mission AMOA : contexte, rôle, résultat.", type: "texte", ancrage: "Fait précis et chiffré" },
        { id: "b2_2", bloc: 2, texte: "Décrivez une recette que vous avez pilotée.", type: "texte", ancrage: "Plan de tests, anomalies" },
        { id: "b2_3", bloc: 2, texte: "Votre expérience SAP ?", type: "texte", ancrage: "Modules et projets" },
        { id: "b3_1", bloc: 3, texte: "Pourquoi cette mission ?", type: "texte" },
        { id: "b3_2", bloc: 3, texte: "Processus en cours ou préavis ?", type: "texte" },
      ],
    };
  if (/extrais des profils/.test(system)) {
    const items = [...prompt.matchAll(/^\[(\d+)\] (.+)\n(.+)$/gm)];
    return {
      profils: items
        .filter((m) => /\/in\//.test(m[3]))
        .map((m) => ({
          index: Number(m[1]),
          nom: m[2].split(" - ")[0],
          intitule: "Chef de projet AMOA",
          localisation: "Paris",
          competences: ["AMOA", "recette", "SAP", "Jira"],
          annees_experience: 8,
          secteurs: ["banque"],
          langues: ["anglais"],
          statut: "freelance",
          resume: "AMOA paiements",
          email: /Martin/.test(m[2]) ? "b.martin@exemple.fr" : undefined,
        })),
    };
  }
  if (/notes l'adéquation/.test(system)) {
    const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
    return { scores: Array.from({ length: n }, (_, i) => ({ index: i, competences_souhaitees: 80, seniorite: 85, secteur: 90, langues: 70, soft_skills: 60 })) };
  }
  if (/messages de recrutement/.test(system)) return { objet: "Mission AMOA banque", message: "Bonjour, je recrute un chef de projet AMOA pour une banque à Paris (12 mois). Votre expérience SAP correspond. Seriez-vous ouvert à en discuter ?" };
  if (/évalues des réponses/.test(system))
    return {
      notes: [...prompt.matchAll(/^\[(b\d_\d)\]/gm)].map((m) => ({ id: m[1], note: 4, commentaire: "Précis" })),
      synthese: "Profil solide en AMOA bancaire.",
      points_forts: ["SAP", "recette"],
      doutes: ["Posture comité de direction"],
      posture_a_verifier: false,
    };
  if (/dossiers de compétences/.test(system))
    return {
      titre: "Chef de projet AMOA",
      annees_experience: 8,
      disponibilite: "15 novembre",
      synthese: "Jean Dupont, joignable à jean.dupont@mail.com ou 06 12 34 56 78, pilote des projets AMOA et la recette SAP en banque (paiements).",
      adequation: [{ critere: "AMOA", preuve: "8 ans en AMOA bancaire" }],
      competences: { techniques: ["SAP"], fonctionnelles: ["AMOA", "recette", "paiements"], outils: ["Jira"], methodes: ["Agile"] },
      experiences: [{ client_ou_secteur: "Banque de détail", dates: "2021-2026", role: "Chef de projet AMOA", contexte: "Refonte paiements", realisations: ["Recette de 400 cas de test"], environnement: "SAP, Jira" }],
      formations: ["Master MIAGE"],
      certifications: [],
      langues: ["Anglais courant"],
      ecarts: ["banque"],
    };
  return { ok: true };
}

const calls = [];
let geminiMode = "ok";
let lastGemini = null;
let lastGroq = null;
let groqMode = "ok";
const tgSent = [];
let existingWebhook = "";
const fakeFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  if (u.host === "generativelanguage.googleapis.com") {
    calls.push("gemini");
    if (geminiMode === "429") return new Response('{"error":"quota"}', { status: 429 });
    if (geminiMode === "garbage") return ok({ candidates: [{ content: { parts: [{ text: "pas du json" }] } }] });
    const b = JSON.parse(init.body);
    lastGemini = b;
    const prompt = b.contents[0].parts.at(-1).text;
    return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(respond(b.systemInstruction.parts[0].text, prompt)) }] } }], usageMetadata: { candidatesTokenCount: 100 } });
  }
  if (u.host === "api.groq.com") {
    calls.push("groq");
    if (groqMode === "500") return new Response("boom", { status: 500 });
    const b = JSON.parse(init.body);
    lastGroq = b;
    if (groqMode === "json400" && b.response_format) return new Response('{"error":{"message":"Failed to validate JSON","code":"json_validate_failed"}}', { status: 400 });
    return ok({ choices: [{ message: { content: JSON.stringify(respond(b.messages[0].content, b.messages[1].content)) } }], usage: { completion_tokens: 50 } });
  }
  if (u.host === "api.tavily.com") {
    calls.push("tavily");
    return ok({
      results: [
        { title: "Jean Dupont - Chef de projet AMOA | LinkedIn", url: "https://fr.linkedin.com/in/jean-dupont-amoa?trk=x", content: "AMOA, recette, SAP, banque" },
        { title: "Brigitte Martin - Business Analyst | LinkedIn", url: "https://www.linkedin.com/in/brigitte-martin/", content: "MOA paiements SAP" },
        { title: "Offre : Chef de projet AMOA H/F", url: "https://www.exemple-emploi.fr/offre/123", content: "Nous recrutons" },
      ],
    });
  }
  if (u.host === "api.telegram.org") {
    const method = u.pathname.split("/").pop();
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body ?? "{}");
    tgSent.push({ method, body });
    if (method === "getMe") return ok({ ok: true, result: { username: "agentx_test_bot" } });
    if (method === "getWebhookInfo") return ok({ ok: true, result: { url: existingWebhook } });
    return ok({ ok: true, result: { message_id: tgSent.length } });
  }
  if (u.host === "oauth2.googleapis.com") return ok({ access_token: "at" });
  if (u.host === "gmail.googleapis.com") {
    if (u.pathname.endsWith("/messages/send")) {
      calls.push("gmail_send");
      return ok({ id: "g1" });
    }
    return ok({ messages: [] });
  }
  return new Response("non simulé : " + u.host, { status: 599 });
};
globalThis.fetch = fakeFetch;

let aiMode = "ok";
const fakeAI = {
  async run(model, input) {
    calls.push("workersai");
    if (aiMode === "down") throw new Error("3040: Out of capacity");
    return { response: JSON.stringify(respond(input.messages[0].content, input.messages[1].content)) };
  },
};

const events = [];
async function makeEnv() {
  const DB = new FakeD1();
  for (const s of X.migrate.splitSql(SCHEMA)) DB.db.exec(s);
  DB.db.exec("INSERT INTO settings (key, value) VALUES ('schema_version', '1')");
  const env = {
    DB,
    FILES: new FakeKV(),
    AI: fakeAI,
    ADMIN_TOKEN: "mot-de-passe-test",
    PUBLIC_URL: "https://agent-x.test.workers.dev",
    MISSION: {
      async create({ id }) {
        events.push({ id, type: "create" });
        return { id };
      },
      async get(id) {
        return { id, sendEvent: async (e) => events.push({ id, ...e }) };
      },
    },
  };
  for (const [k, v] of Object.entries({ gemini_api_key: "g", groq_api_key: "q", tavily_api_key: "t", telegram_bot_token: "123:abc", google_client_id: "cid", google_client_secret: "cs", google_refresh_token: "rt" }))
    await X.db.setSetting(env, k, v, true);
  await X.db.setSetting(env, "telegram_chat_id", "42");
  await X.db.setSetting(env, "gmail_address", "recruteur@exemple.fr");
  await X.db.setSetting(env, "public_url", "https://agent-x.test.workers.dev");
  await X.db.setSetting(env, "sender_default", "Zacharie R.");
  return env;
}

const S = X.schedule;
const paris = (y, m, d, h = 0, min = 0) => S.parisToUtc(y, m, d, h, min);
const hhmm = (date) => {
  const p = S.parisParts(date);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
};
const sched = JSON.parse(readFileSync("config/defaults.json", "utf8")).schedule;

// ───────────── Calendrier ─────────────
await test("jours fériés 2026 calculés (Pâques, Ascension, Pentecôte)", () => {
  const h = S.frenchHolidays(2026);
  for (const d of ["2026-04-06", "2026-05-14", "2026-05-25", "2026-07-14", "2026-11-11"]) assert(h.has(d), `${d} manquant`);
  assert(S.frenchHolidays(2027).has("2027-03-29"), "lundi de Pâques 2027");
});
await test("48 h ouvrées : vendredi 16 h → mardi 16 h", () => {
  const r = S.addBusinessHours(paris(2026, 10, 16, 16), 48);
  assert(hhmm(r) === "2026-10-20 16:00", hhmm(r));
});
await test("48 h ouvrées : le 11 novembre (mercredi férié) ne compte pas", () => {
  const r = S.addBusinessHours(paris(2026, 11, 10, 10), 48);
  assert(hhmm(r) === "2026-11-13 10:00", hhmm(r));
});
await test("créneaux : vendredi 15 h → lundi 8 h ; samedi → lundi 8 h ; mardi 9 h → tout de suite", () => {
  assert(hhmm(S.nextSlot(paris(2026, 10, 16, 15), "premier_contact", sched)) === "2026-10-19 08:00", "vendredi");
  assert(hhmm(S.nextSlot(paris(2026, 10, 17, 11), "premier_contact", sched)) === "2026-10-19 08:00", "samedi");
  const t = paris(2026, 10, 20, 9, 5);
  assert(S.nextSlot(t, "premier_contact", sched).getTime() === t.getTime(), "mardi dans le créneau");
});
await test("créneaux : relance mardi 11 h → mardi 17 h 30 ; premier contact mardi 10 h 30 → 12 h 30", () => {
  assert(hhmm(S.nextSlot(paris(2026, 10, 20, 11), "relance", sched)) === "2026-10-20 17:30", "relance");
  assert(hhmm(S.nextSlot(paris(2026, 10, 20, 10, 30), "premier_contact", sched)) === "2026-10-20 12:30", "midi");
});
await test("créneaux : veille de l'Ascension jeudi férié → vendredi 8 h", () => {
  assert(hhmm(S.nextSlot(paris(2026, 5, 13, 19), "premier_contact", sched)) === "2026-05-15 08:00", hhmm(S.nextSlot(paris(2026, 5, 13, 19), "premier_contact", sched)));
});

// ───────────── Matching ─────────────
const fiche = () => X.mission && JSON.parse(JSON.stringify({ ...FICHE, questionnaire: [] }));
const weights = { competences_souhaitees: 30, seniorite: 25, secteur: 20, langues: 10, soft_skills: 15 };
await test("matching : TJM au-dessus du budget (+10 %) éliminé ; TJM inconnu à vérifier", () => {
  const f = fiche();
  const base = { competences: ["AMOA", "recette", "SAP"], annees_experience: 8, statut: "freelance" };
  assert(X.matching.evaluate(f, { ...base, tjm: 800 }, {}, weights).eliminated, "800 € devait éliminer");
  const r = X.matching.evaluate(f, base, {}, weights);
  assert(!r.eliminated && r.toVerify.includes("TJM à vérifier"), JSON.stringify(r));
});
await test("matching : statut salarié refusé ; séniorité sous le niveau élargi refusée", () => {
  const f = fiche();
  assert(X.matching.evaluate(f, { statut: "salarié", competences: ["AMOA"] }, {}, weights).eliminated, "statut");
  assert(X.matching.evaluate(f, { annees_experience: 2, competences: ["AMOA"] }, {}, weights).eliminated, "séniorité");
});
await test("matching : une donnée absente n'élimine pas, la couverture pèse sur le score", () => {
  const f = fiche();
  const full = X.matching.evaluate(f, { competences: ["AMOA", "recette", "SAP"] }, { competences_souhaitees: 80, seniorite: 80, secteur: 80, langues: 80, soft_skills: 80 }, weights);
  const thin = X.matching.evaluate(f, { competences: ["AMOA"] }, { competences_souhaitees: 80, seniorite: 80, secteur: 80, langues: 80, soft_skills: 80 }, weights);
  assert(!thin.eliminated, "profil pauvre éliminé à tort");
  assert(full.score === 80 && thin.score < full.score, `${full.score} / ${thin.score}`);
});
await test("matching : compétences courtes reconnues sans faux positif (« C » ≠ « CI »)", () => {
  assert(X.matching.hasSkill(["Java, C, SQL"], "C"), "C");
  assert(!X.matching.hasSkill(["CI/CD, Java"], "C"), "faux positif");
  assert(X.matching.hasSkill(["Développeur C#"], "C#"), "C#");
});

// ───────────── Relais IA ─────────────
await test("IA : Gemini en quota (429) → relais Groq, sans erreur", async () => {
  const env = await makeEnv();
  geminiMode = "429";
  calls.length = 0;
  const r = await X.router.ai(env, { family: "jugement", system: "Réponds uniquement en JSON.", prompt: "x", json: true });
  geminiMode = "ok";
  assert(r.provider.startsWith("groq:") && calls.join() === "gemini,groq", calls.join());
});
await test("IA : réponse illisible → fournisseur suivant", async () => {
  const env = await makeEnv();
  geminiMode = "garbage";
  const r = await X.router.ai(env, { family: "jugement", system: "Réponds uniquement en JSON.", prompt: "x", json: true });
  geminiMode = "ok";
  assert(r.provider.startsWith("groq:"), r.provider);
});
await test("IA : quota du jour presque atteint → bascule avant le blocage", async () => {
  const env = await makeEnv();
  await env.DB.prepare("INSERT INTO usage (provider, day, requests) VALUES (?, ?, ?)").bind("gemini:gemini-3.8-flash", new Date().toISOString().slice(0, 10), 1300).run();
  calls.length = 0;
  const r = await X.router.ai(env, { family: "jugement", system: "Réponds uniquement en JSON.", prompt: "x", json: true });
  assert(r.provider.startsWith("groq:") && !calls.includes("gemini"), calls.join());
});
await test("IA : tout en panne → AllProvidersDown avec heure de reprise (jamais d'arrêt brutal)", async () => {
  const env = await makeEnv();
  geminiMode = "429";
  groqMode = "500";
  aiMode = "down";
  let err;
  try {
    await X.router.ai(env, { family: "jugement", system: "s", prompt: "x", json: true });
  } catch (e) {
    err = e;
  }
  geminiMode = "ok";
  groqMode = "ok";
  aiMode = "ok";
  assert(err instanceof X.router.AllProvidersDown, String(err));
  assert(err.retryAt.getTime() > Date.now(), "retryAt");
});
await test("IA : un PDF n'est jamais envoyé à un modèle qui ne sait pas le lire", async () => {
  const env = await makeEnv();
  geminiMode = "429";
  calls.length = 0;
  let err;
  try {
    await X.router.ai(env, { family: "jugement", system: "s", prompt: "x", json: true, file: { mime: "application/pdf", base64: "JVBERi0=" } });
  } catch (e) {
    err = e;
  }
  geminiMode = "ok";
  assert(err instanceof X.router.AllProvidersDown && !calls.includes("groq") && !calls.includes("workersai"), calls.join());
});
await test("IA : réflexion basse et marge de sortie minimale (pas de réponse vide sur un petit test)", async () => {
  const env = await makeEnv();
  await X.router.ai(env, { family: "jugement", system: "Réponds uniquement en JSON.", prompt: "x", json: true, maxTokens: 50 });
  assert(lastGemini.generationConfig.maxOutputTokens >= 2048, `${lastGemini.generationConfig.maxOutputTokens}`);
  assert(lastGemini.generationConfig.thinkingConfig?.thinkingLevel === "low", JSON.stringify(lastGemini.generationConfig));
});
await test("IA : Groq refuse le mode JSON strict → nouvel essai en texte libre, sans changer de fournisseur", async () => {
  const env = await makeEnv();
  geminiMode = "429";
  groqMode = "json400";
  const r = await X.router.ai(env, { family: "jugement", system: "Réponds uniquement en JSON.", prompt: "x", json: true });
  geminiMode = "ok";
  groqMode = "ok";
  assert(r.provider.startsWith("groq:") && !lastGroq.response_format && lastGroq.reasoning_effort === "low", JSON.stringify(lastGroq));
});
await test("IA : extraction du JSON entouré de texte ou de ```json", () => {
  assert(X.router.extractJson('Voici :\n```json\n{"a":1}\n```').a === 1, "bloc");
  assert(X.router.extractJson('ok {"b":[1,2]} fin').b.length === 2, "texte");
});

// ───────────── Qualification ─────────────
await test("qualification : « non » à une question éliminatoire → rejet proposé (validation n°2)", () => {
  const qs = [
    { id: "b1_dispo", bloc: 1, type: "oui_non", texte: "Dispo ?", attendu: "oui" },
    { id: "b2_1", bloc: 2, type: "texte", texte: "x" },
    { id: "b4_accord", bloc: 4, type: "oui_non", texte: "Accord ?" },
  ];
  const n = { notes: [{ id: "b2_1", note: 5 }], synthese: "", points_forts: [], doutes: [], posture_a_verifier: false };
  assert(X.qualification.decide(qs, { b1_dispo: "non", b4_accord: "oui" }, n, 80).decision === "rejet_propose", "dispo");
  assert(X.qualification.decide(qs, { b1_dispo: "oui", b4_accord: "non" }, n, 80).decision === "rejet_propose", "accord");
  const ok = X.qualification.decide(qs, { b1_dispo: "oui", b4_accord: "oui" }, n, 80);
  assert(ok.decision === "qualifie" && ok.finalScore === 92, JSON.stringify(ok));
});

// ───────────── CV ─────────────
await test("CV : anonymisation (nom, email, téléphone, liens)", () => {
  const t = X.cv.anonymize("Jean Dupont — jean.dupont@mail.com — 06 12 34 56 78 — https://linkedin.com/in/jd", "Jean Dupont");
  assert(!/Jean|Dupont|@|06 12|linkedin/.test(t), t);
  assert(X.cv.initials("Jean Dupont") === "J. D.", X.cv.initials("Jean Dupont"));
});
await test(".docx : archive ZIP valide, parties Word présentes", () => {
  const bytes = X.docx.buildDocx([{ kind: "title", text: "J. D. — Chef de projet" }, { kind: "bullet", text: "Recette & SAP <ok>" }], { font: "Calibri", color: "1F3864" }, "Test");
  assert(bytes[0] === 0x50 && bytes[1] === 0x4b, "signature PK");
  const s = new TextDecoder().decode(bytes);
  for (const p of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "Recette &amp; SAP &lt;ok&gt;"]) assert(s.includes(p), p);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6) { eocd = i; break; }
  assert(eocd > 0 && new DataView(bytes.buffer, bytes.byteOffset).getUint16(eocd + 10, true) === 7, "7 fichiers");
});

// ───────────── Parcours complet d'une mission ─────────────
const env = await makeEnv();
let missionId;
let tokenA;
let tokenB;
const tue = paris(2026, 10, 20, 8, 30);

await test("mission : fiche brute → fiche modèle + questionnaire (F1) + validation n°1 envoyée", async () => {
  missionId = await X.bot.createMission(env, "Chef de projet AMOA pour une banque à Paris, 12 mois, SAP, recette, AMOA, freelance, TJM 650. ".repeat(3));
  assert(events.some((e) => e.type === "create" && e.id === missionId), "Workflow non créé");
  const f = await X.mission.analyzeMission(env, missionId);
  assert(f.intitule === "Chef de projet AMOA" && f.questionnaire.length >= 6, `questionnaire ${f.questionnaire.length}`);
  assert(f.questionnaire[0].bloc === 1 && f.questionnaire.at(-1).bloc === 4, "ordre des blocs");
  tgSent.length = 0;
  await X.mission.sendFicheValidation(env, missionId);
  const msg = tgSent.find((m) => m.method === "sendMessage");
  assert(/Validation n°1/.test(msg.body.text) && /Zacharie R\./.test(msg.body.text), msg?.body.text);
  assert(msg.body.reply_markup.inline_keyboard[0][0].callback_data.startsWith("v:"), "boutons");
});

await test("mission : modification « expéditeur : … » appliquée sans appel IA", async () => {
  calls.length = 0;
  await X.mission.applyFicheChange(env, missionId, "expéditeur : Zacharie, Cabinet ZR");
  const m = await X.mission.getMission(env, missionId);
  assert(m.sender_name === "Zacharie, Cabinet ZR" && calls.length === 0, `${m.sender_name} ${calls}`);
});

await test("mission : lancement, échéance = 48 h ouvrées", async () => {
  const deadline = await X.mission.startMission(env, missionId, paris(2026, 10, 16, 16));
  assert(hhmm(new Date(deadline)) === "2026-10-20 16:00", hhmm(new Date(deadline)));
});

await test("sourcing : web public → 2 profils (l'offre d'emploi est ignorée), URL LinkedIn normalisées", async () => {
  const n = await X.mission.sourceFromWeb(env, missionId);
  assert(n === 2, `${n} profils`);
  const urls = (await env.DB.prepare("SELECT linkedin_url FROM candidates ORDER BY linkedin_url").all()).results.map((r) => r.linkedin_url);
  assert(urls.join() === "https://www.linkedin.com/in/brigitte-martin,https://www.linkedin.com/in/jean-dupont-amoa", urls.join());
  const sc = (await env.DB.prepare("SELECT state, score FROM applications").all()).results;
  assert(sc.every((r) => r.state === "score" && r.score >= 55), JSON.stringify(sc));
});

await test("sourcing : relancé deux fois, aucun doublon (CV-thèque dédoublonnée)", async () => {
  await X.mission.sourceFromWeb(env, missionId);
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidates").first("n");
  const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications").first("n");
  assert(c === 2 && a === 2, `${c} candidats, ${a} candidatures`);
});

await test("CV-thèque : recherche plein texte (accents et casse ignorés)", async () => {
  const hits = await X.sourcing.searchCvtheque(env, { ...fiche(), intitule: "chef de projet amoa", competences_obligatoires: ["sap"], mots_cles: [] });
  assert(hits.length === 2, `${hits.length}`);
});

await test("contacts : planifiés au créneau, email automatique et file LinkedIn", async () => {
  const p = await X.mission.planOutreach(env, missionId, tue);
  assert(p.planned === 2, JSON.stringify(p));
  calls.length = 0;
  tgSent.length = 0;
  const r = await X.outreach.processDueContacts(env, new Date(tue.getTime() + 10 * 60_000));
  assert(r.email === 1 && r.linkedin === 1, JSON.stringify(r));
  assert(calls.includes("gmail_send"), "Gmail non appelé");
  const q = await env.DB.prepare("SELECT message FROM linkedin_queue").first();
  assert(/agent-x\.test\.workers\.dev\/q\/t_/.test(q.message) && /\/stop\/t_/.test(q.message), q.message);
  assert(tgSent.some((m) => /LinkedIn prêt/.test(m.body.text ?? "")), "notification LinkedIn");
  const apps = (await env.DB.prepare("SELECT a.token, a.state, a.contact_step, a.next_action_at, c.email FROM applications a JOIN candidates c ON c.id = a.candidate_id").all()).results;
  assert(apps.every((a) => a.state === "contacte" && a.contact_step === 1), JSON.stringify(apps));
  tokenA = apps.find((a) => !a.email).token;
  tokenB = apps.find((a) => a.email).token;
  const next = new Date(apps[0].next_action_at);
  assert(hhmm(next) === "2026-10-20 17:30", `relance 1 à ${hhmm(next)}`);
});

await test("contacts : hors créneau (samedi), rien n'est envoyé, report au lundi", async () => {
  await env.DB.prepare("UPDATE applications SET next_action_at = ? WHERE token = ?").bind(paris(2026, 10, 24, 9).toISOString(), tokenA).run();
  const r = await X.outreach.processDueContacts(env, paris(2026, 10, 24, 9, 10));
  const next = await env.DB.prepare("SELECT next_action_at FROM applications WHERE token = ?").bind(tokenA).first("next_action_at");
  assert(r.email + r.linkedin === 0 && hhmm(new Date(next)) === "2026-10-26 17:30", `${JSON.stringify(r)} ${hhmm(new Date(next))}`);
});

await test("questionnaire : page, envoi des réponses + CV, Workflow réveillé", async () => {
  const page = await X.pages.questionnairePage(env, tokenA);
  const html = await page.text();
  assert(page.status === 200 && html.includes("Chef de projet AMOA") && html.includes("name=\"q_b2_1\""), "page");
  assert(!html.includes("Banque Exemple"), "le nom du client ne doit pas apparaître");
  const fd = new FormData();
  for (const [k, v] of Object.entries({ q_b1_dispo: "oui", q_b1_statut: "oui", q_b1_tjm: "oui", q_b2_1: "Refonte des paiements SEPA, 400 cas de test", q_b2_2: "Recette SAP", q_b2_3: "SAP FI 5 ans", q_b3_1: "Le secteur", q_b3_2: "Aucun", q_b4_accord: "oui" })) fd.set(k, v);
  fd.set("cv", new File([new Uint8Array([37, 80, 68, 70])], "cv.pdf", { type: "application/pdf" }));
  events.length = 0;
  const res = await X.pages.questionnaireSubmit(env, tokenA, new Request("https://x/q/" + tokenA, { method: "POST", body: fd }));
  assert(res.status === 200, "réponse");
  assert(events.some((e) => e.type === "point" && e.payload.kind === "answers"), "événement point");
  const a = await env.DB.prepare("SELECT state, next_action_at FROM applications WHERE token = ?").bind(tokenA).first();
  assert(a.state === "reponses_recues" && a.next_action_at === null, JSON.stringify(a));
  const cand = await env.DB.prepare("SELECT candidate_id FROM applications WHERE token = ?").bind(tokenA).first("candidate_id");
  assert(await env.FILES.get(`upload:${cand}`, "json"), "CV stocké");
});

await test("qualification : candidat A qualifié ; candidat B (non disponible) → rejet proposé, jamais automatique", async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ q_b1_dispo: "non", q_b1_statut: "oui", q_b1_tjm: "oui", q_b2_1: "x", q_b2_2: "y", q_b2_3: "z", q_b3_1: "a", q_b3_2: "b", q_b4_accord: "oui" })) fd.set(k, v);
  await X.pages.questionnaireSubmit(env, tokenB, new Request("https://x", { method: "POST", body: fd }));
  tgSent.length = 0;
  const r = await X.mission.qualifyPending(env, missionId);
  assert(r.qualified === 1 && r.proposedRejections === 1, JSON.stringify(r));
  const states = Object.fromEntries((await env.DB.prepare("SELECT token, state FROM applications").all()).results.map((x) => [x.token, x.state]));
  assert(states[tokenA] === "qualifie" && states[tokenB] === "en_attente", JSON.stringify(states));
  assert(tgSent.some((m) => /Validation n°2/.test(m.body.text ?? "")), "validation n°2");
});

await test("shortlist : CV .docx anonymisé, adéquation mesurée, envoyé sur Telegram (n°3 et 4)", async () => {
  const apps = await X.mission.buildShortlist(env, missionId);
  assert(apps.length === 1, `${apps.length}`);
  const file = await env.FILES.getWithMetadata(`cv:${apps[0]}`, "arrayBuffer");
  const text = new TextDecoder().decode(new Uint8Array(file.value));
  assert(text.includes("word/document.xml"), "docx");
  assert(!/Dupont|jean\.dupont|06 12 34/.test(text), "données personnelles présentes dans le CV");
  assert(file.metadata.coverage >= 80, `adéquation ${file.metadata.coverage}`);
  if (process.env.DOCX_OUT) (await import("node:fs")).writeFileSync(process.env.DOCX_OUT, new Uint8Array(file.value));
  tgSent.length = 0;
  await X.mission.sendShortlistValidation(env, missionId, apps);
  assert(tgSent.some((m) => m.method === "sendDocument"), "CV non envoyé");
  assert(tgSent.some((m) => /Validations n°3 et 4/.test(m.body.text ?? "")), "message de validation");
  await X.mission.markPresented(env, missionId, apps);
  const st = await env.DB.prepare("SELECT state FROM applications WHERE id = ?").bind(apps[0]).first("state");
  assert(st === "presente", st);
});

await test("évolution du besoin (F2) : nouvelle version, re-scoring, apprentissage du client", async () => {
  await env.DB.prepare("UPDATE missions SET status = 'en_cours' WHERE id = ?").bind(missionId).run();
  const msg = await X.mission.applyEvolution(env, missionId, "Le client veut aussi l'anglais courant");
  const m = await X.mission.getMission(env, missionId);
  assert(m.version === 2 && /version 2/.test(msg), msg);
  const learned = await env.DB.prepare("SELECT learned FROM clients WHERE id = ?").bind(m.client_id).first("learned");
  assert(/anglais courant/.test(learned), learned);
});

await test("Telegram : liaison par /start <code>, inconnu refusé, bouton de validation → événement du Workflow", async () => {
  const secret = await X.security.derivedSecret(env.ADMIN_TOKEN, "telegram");
  const code = (await X.security.derivedSecret(env.ADMIN_TOKEN, "telegram-link")).slice(0, 16);
  const ctx = { waitUntil() {} };
  const post = (update, s = secret) => X.worker.fetch(new Request("https://x/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": s }, body: JSON.stringify(update) }), env, ctx);
  assert((await post({}, "faux")).status === 403, "secret non vérifié");
  await post({ message: { message_id: 1, chat: { id: 99 }, text: "/start " + code } });
  assert((await X.db.getSetting(env, "telegram_chat_id")) === "99", "liaison");
  tgSent.length = 0;
  await post({ message: { message_id: 2, chat: { id: 7 }, text: "bonjour" } });
  assert(tgSent.some((m) => /privé/.test(m.body.text ?? "") && m.body.chat_id === "7"), "intrus non refusé");
  const vid = await env.DB.prepare("SELECT id FROM validations WHERE kind = 'fiche' ORDER BY created_at DESC LIMIT 1").first("id");
  events.length = 0;
  await post({ callback_query: { id: "cb1", data: `v:${vid}:ok`, message: { message_id: 3, chat: { id: 99 } } } });
  assert(events.some((e) => e.type === "v1" && e.payload.action === "ok"), JSON.stringify(events));
});

await test("RGPD : désinscription → données effacées, jamais recontacté ensuite", async () => {
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidates").first("n");
  const page = await X.pages.stopPage(env, tokenB, new Request("https://x", { method: "POST" }));
  assert(page.status === 200, "page");
  const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidates").first("n");
  assert(after === before - 1, `${before} → ${after}`);
  assert(await X.rgpd.isOptedOut(env, "B.Martin@exemple.fr", null), "liste d'opposition (email)");
  assert(await X.rgpd.isOptedOut(env, null, "https://www.linkedin.com/in/brigitte-martin"), "liste d'opposition (URL)");
  await X.mission.sourceFromWeb(env, missionId);
  const again = await env.DB.prepare("SELECT COUNT(*) AS n FROM candidates WHERE email = 'b.martin@exemple.fr'").first("n");
  assert(again === 0, "recontactée après désinscription");
});

await test("pages : configuration servie, lien de questionnaire inconnu → 404, extension protégée", async () => {
  const ctx = { waitUntil() {} };
  const c = await X.worker.fetch(new Request("https://x/config"), env, ctx);
  assert(c.status === 200 && (await c.text()).includes("Agent X"), "config");
  const q = await X.worker.fetch(new Request("https://x/q/t_inconnu12345"), env, ctx);
  assert(q.status === 404, `${q.status}`);
  const l = await X.worker.fetch(new Request("https://x/api/linkedin/queue", { headers: { "x-agent-x-token": "faux" } }), env, ctx);
  assert(l.status === 401, `${l.status}`);
  const tok = await X.security.derivedSecret(env.ADMIN_TOKEN, "extension");
  const ok = await X.worker.fetch(new Request("https://x/api/linkedin/queue", { headers: { "x-agent-x-token": tok } }), env, ctx);
  assert(ok.status === 200 && (await ok.json()).ok, "file");
});

await test("Telegram : un bot déjà utilisé par un autre projet (boutique) n'est jamais détourné", async () => {
  const hook = "https://agent-x.test.workers.dev/telegram/webhook";
  existingWebhook = "https://atelier-ecrin.exemple.workers.dev/telegram";
  tgSent.length = 0;
  let err;
  try {
    await X.telegram.setupBot(env, "123:abc", hook, "s");
  } catch (e) {
    err = e;
  }
  assert(err && /déjà utilisé par un autre projet/.test(err.message), String(err));
  assert(!tgSent.some((m) => m.method === "setWebhook"), "webhook de la boutique écrasé");
  existingWebhook = hook;
  await X.telegram.setupBot(env, "123:abc", hook, "s");
  existingWebhook = "";
  await X.telegram.setupBot(env, "123:abc", hook, "s");
  assert(tgSent.filter((m) => m.method === "setWebhook").length === 2, "bot dédié non relié");
});

await test("secrets : chiffrés en base (jamais en clair)", async () => {
  const raw = await env.DB.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").first("value");
  assert(raw.startsWith("v1.") && raw !== "g", raw);
  assert((await X.db.getSetting(env, "gemini_api_key")) === "g", "déchiffrement");
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
