import { getSetting, parseJson } from "./db";
import type { Env } from "./env";
import { frDate, parisParts } from "./schedule";
import { notify } from "./telegram";

/**
 * Suivi et pilotage : entonnoir par mission, indicateurs du sourceur (réponse, intérêt, précision de recherche,
 * délai brief → shortlist, acceptation client, part par source), ce qui t'attend et les incidents.
 * Sert au tableau de bord web (/tableau) et au bilan quotidien sur Telegram (8 h, ou /bilan).
 */

const BEYOND_GO = ["go", "a_contacter", "contacte", "repondu", "reponses_recues", "en_attente", "qualifie", "cv_formate", "presente", "place", "non_retenu", "sans_reponse", "sans_canal"];
const CONTACTED = ["contacte", "repondu", "reponses_recues", "en_attente", "qualifie", "cv_formate", "presente", "place", "non_retenu", "sans_reponse"];
const REPLIED = ["repondu", "reponses_recues", "en_attente", "qualifie", "cv_formate", "presente", "place", "non_retenu"];
const QUALIFIED = ["qualifie", "cv_formate", "presente", "place", "non_retenu"];
const PRESENTED = ["presente", "place", "non_retenu"];

export interface Funnel {
  sources: number;
  aRevoir: number;
  go: number;
  contactes: number;
  repondu: number;
  qualifies: number;
  presentes: number;
  places: number;
}

export interface MissionView {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  deadline: string | null;
  funnel: Funnel;
  waiting: string[];
}

export interface Stats {
  missions: MissionView[];
  kpis: { label: string; value: string; target: string; help: string }[];
  sources: { source: string; presentes: number; places: number }[];
  incidents: string[];
  journal: { at: string; action: string; detail: string }[];
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : "—");
const count = (states: Record<string, number>, list: string[]) => list.reduce((a, s) => a + (states[s] ?? 0), 0);

const ACTIONS: Record<string, string> = {
  fiche_recue: "Fiche reçue",
  mission_lancee: "Mission lancée",
  revue_envoyee: "Cartes envoyées",
  go: "Go",
  nogo: "No go",
  email_envoye: "Email envoyé",
  linkedin_prepare: "Message LinkedIn préparé",
  questionnaire_recu: "Questionnaire reçu",
  evolution: "Évolution appliquée",
  shortlist_envoyee: "Shortlist envoyée",
  decision_client: "Décision client",
  mission_cloturee: "Mission clôturée",
  message_valide: "Message validé",
  compte_rendu_entretien: "Compte rendu d'entretien",
};

export async function collectStats(env: Env, now = new Date()): Promise<Stats> {
  const { results: ms } = await env.DB.prepare(
    "SELECT id, title, status, created_at, deadline_at FROM missions WHERE status NOT IN ('abandonnee') ORDER BY created_at DESC LIMIT 15",
  ).all<{ id: string; title: string; status: string; created_at: string; deadline_at: string | null }>();
  const { results: grouped } = await env.DB.prepare("SELECT mission_id, state, COUNT(*) AS n FROM applications GROUP BY mission_id, state").all<{ mission_id: string; state: string; n: number }>();
  const byMission = new Map<string, Record<string, number>>();
  for (const g of grouped ?? []) {
    const m = byMission.get(g.mission_id) ?? {};
    m[g.state] = g.n;
    byMission.set(g.mission_id, m);
  }
  const { results: pending } = await env.DB.prepare("SELECT mission_id, kind, COUNT(*) AS n FROM validations WHERE status = 'en_attente' GROUP BY mission_id, kind").all<{ mission_id: string | null; kind: string; n: number }>();
  const KIND: Record<string, string> = { fiche: "validation de la fiche", rejet: "rejet(s) proposé(s)", shortlist: "shortlist à valider", message: "message de premier contact à valider" };

  const missions: MissionView[] = (ms ?? []).map((m) => {
    const st = byMission.get(m.id) ?? {};
    const funnel: Funnel = {
      sources: Object.values(st).reduce((a, b) => a + b, 0),
      aRevoir: st.en_revue ?? 0,
      go: count(st, BEYOND_GO),
      contactes: count(st, CONTACTED),
      repondu: count(st, REPLIED),
      qualifies: count(st, QUALIFIED),
      presentes: count(st, PRESENTED),
      places: st.place ?? 0,
    };
    const waiting: string[] = [];
    if (m.status !== "terminee") {
      if (funnel.aRevoir) waiting.push(`${funnel.aRevoir} carte(s) Go / No go`);
      for (const p of (pending ?? []).filter((x) => x.mission_id === m.id)) waiting.push(p.kind === "rejet" ? `${p.n} ${KIND.rejet}` : KIND[p.kind] ?? p.kind);
    }
    return { id: m.id, title: m.title, status: m.status, createdAt: m.created_at, deadline: m.deadline_at, funnel, waiting };
  });

  // Indicateurs sur 30 jours.
  const { results: chan } = await env.DB.prepare(
    `SELECT channel, SUM(state IN (${CONTACTED.map(() => "?").join(",")})) AS contactes, SUM(state IN (${REPLIED.map(() => "?").join(",")})) AS repondu
     FROM applications WHERE channel IS NOT NULL AND updated_at >= datetime('now', '-30 days') GROUP BY channel`,
  )
    .bind(...CONTACTED, ...REPLIED)
    .all<{ channel: string; contactes: number; repondu: number }>();
  const email = (chan ?? []).find((c) => c.channel === "email");
  const li = (chan ?? []).find((c) => c.channel === "linkedin");
  const totalC = (email?.contactes ?? 0) + (li?.contactes ?? 0);
  const totalR = (email?.repondu ?? 0) + (li?.repondu ?? 0);

  const { results: prec } = await env.DB.prepare("SELECT detail FROM journal WHERE action = 'precision' AND at >= datetime('now', '-30 days')").all<{ detail: string }>();
  const precisions = (prec ?? []).map((r) => parseJson<{ precision?: number | null; trouves?: number }>(r.detail, {})).filter((d) => typeof d.precision === "number" && (d.trouves ?? 0) > 0);
  const avgPrec = precisions.length ? Math.round(precisions.reduce((a, d) => a + (d.precision as number), 0) / precisions.length) : null;

  const { results: sl } = await env.DB.prepare(
    "SELECT m.created_at AS c, MIN(j.at) AS s FROM journal j JOIN missions m ON m.id = j.mission_id WHERE j.action = 'shortlist_envoyee' AND j.at >= datetime('now', '-90 days') GROUP BY m.id",
  ).all<{ c: string; s: string }>();
  const delays = (sl ?? []).map((r) => (Date.parse(`${r.s.replace(" ", "T")}Z`) - Date.parse(`${r.c.replace(" ", "T")}Z`)) / 3_600_000).filter((h) => h >= 0);
  const avgDelay = delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null;

  const dec = await env.DB.prepare("SELECT SUM(client_decision = 'place') AS p, SUM(client_decision = 'non_retenu') AS n FROM applications WHERE client_decision IS NOT NULL").first<{ p: number | null; n: number | null }>();
  const placed = dec?.p ?? 0;
  const refused = dec?.n ?? 0;

  const kpis = [
    { label: "Taux de réponse email", value: pct(email?.repondu ?? 0, email?.contactes ?? 0), target: "≈ 5 %", help: `${email?.repondu ?? 0} / ${email?.contactes ?? 0} contactés (30 j)` },
    { label: "Taux de réponse LinkedIn", value: pct(li?.repondu ?? 0, li?.contactes ?? 0), target: "≈ 17 %", help: `${li?.repondu ?? 0} / ${li?.contactes ?? 0} contactés (30 j)` },
    { label: "Taux d'intérêt", value: pct(totalR, totalC), target: "≈ 8 %", help: "intéressés / contactés, tous canaux" },
    { label: "Précision de recherche", value: avgPrec == null ? "—" : `${avgPrec} %`, target: "≥ 50 %", help: `profils pertinents / trouvés, moyenne de ${precisions.length} requête(s)` },
    { label: "Délai fiche → shortlist", value: avgDelay == null ? "—" : `${avgDelay} h`, target: "48 h ouvrées", help: `${delays.length} shortlist(s) sur 90 jours` },
    { label: "Acceptation client", value: pct(placed, placed + refused), target: "≥ 50 %", help: `${placed} placé(s), ${refused} non retenu(s)` },
  ];

  const { results: src } = await env.DB.prepare(
    `SELECT c.source AS source, SUM(a.state IN ('presente','place','non_retenu')) AS presentes, SUM(a.state = 'place') AS places
     FROM applications a JOIN candidates c ON c.id = a.candidate_id GROUP BY c.source HAVING presentes > 0 ORDER BY presentes DESC LIMIT 8`,
  ).all<{ source: string; presentes: number; places: number }>();

  const incidents: string[] = [];
  const { results: paused } = await env.DB.prepare("SELECT provider, open_until, last_error FROM usage WHERE day = date('now') AND open_until > ?").bind(now.toISOString()).all<{ provider: string; open_until: string; last_error: string | null }>();
  for (const p of paused ?? []) incidents.push(`⏸ ${p.provider} en pause jusqu'à ${frDate(new Date(p.open_until))}${p.last_error ? ` (${p.last_error.slice(0, 80)})` : ""}`);
  const cronLast = await getSetting(env, "cron_last");
  if (!cronLast || now.getTime() - Date.parse(`${cronLast.replace(" ", "T")}Z`) > 40 * 60_000) incidents.push(`⚠️ Planificateur (envois, relances) : ${cronLast ? `dernier passage ${cronLast} UTC` : "jamais vu"}`);
  const err = await env.DB.prepare("SELECT COUNT(*) AS n FROM journal WHERE actor = 'cron' AND action = 'erreur' AND at >= datetime('now', '-1 day')").first<{ n: number }>();
  if (err?.n) incidents.push(`⚠️ ${err.n} erreur(s) du planificateur sur 24 h`);
  const relais = await env.DB.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = 'relais' AND at >= datetime('now', '-1 day')").first<{ n: number }>();
  const rep = await env.DB.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = 'reprise' AND at >= datetime('now', '-1 day')").first<{ n: number }>();
  if (rep?.n) incidents.push(`🔧 ${rep.n} relance(s) automatique(s) de mission sur 24 h`);
  for (const m of missions.filter((x) => x.status === "en_cours" && !x.waiting.length)) {
    const last = await env.DB.prepare("SELECT MAX(at) AS at FROM journal WHERE mission_id = ?").bind(m.id).first<{ at: string | null }>();
    if (last?.at && now.getTime() - Date.parse(`${last.at.replace(" ", "T")}Z`) > 4 * 3_600_000 && m.funnel.go === 0) incidents.push(`⚠️ « ${m.title} » : aucune activité depuis ${last.at} UTC alors que rien ne t'attend (relance automatique au prochain passage)`);
  }
  if ((relais?.n ?? 0) > 20) incidents.push(`ℹ️ ${relais?.n} bascules d'IA sur 24 h (quotas gratuits sollicités)`);

  const { results: jr } = await env.DB.prepare(
    `SELECT at, action, detail FROM journal WHERE action IN (${Object.keys(ACTIONS).map(() => "?").join(",")}) ORDER BY id DESC LIMIT 20`,
  )
    .bind(...Object.keys(ACTIONS))
    .all<{ at: string; action: string; detail: string | null }>();
  const journal = (jr ?? []).map((r) => ({ at: r.at, action: ACTIONS[r.action] ?? r.action, detail: (r.detail ?? "").replace(/[{}"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) }));

  return { missions, kpis, sources: src ?? [], incidents, journal };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS: Record<string, string> = { analyse: "Analyse de la fiche", brouillon: "Fiche à valider", en_cours: "En cours", shortlist_envoyee: "Shortlist envoyée", terminee: "Close" };
const ACTIVE = ["analyse", "brouillon", "en_cours", "shortlist_envoyee"];

/** Tableau de bord web (protégé par la session de la page de configuration). */
export function dashboardHtml(s: Stats, now = new Date()): string {
  const steps: [keyof Funnel, string][] = [
    ["sources", "Sourcés"],
    ["aRevoir", "À revoir"],
    ["go", "Go"],
    ["contactes", "Contactés"],
    ["repondu", "Répondu"],
    ["qualifies", "Qualifiés"],
    ["presentes", "Présentés"],
    ["places", "Placés"],
  ];
  const active = s.missions.filter((m) => ACTIVE.includes(m.status));
  const funnelRow = (m: MissionView) => {
    const max = Math.max(1, m.funnel.sources);
    return steps
      .map(([k, label]) => `<div class="step"><div class="bar"><span style="width:${Math.round((m.funnel[k] / max) * 100)}%"></span></div><div class="n">${m.funnel[k]}</div><div class="l">${label}</div></div>`)
      .join("");
  };
  const missionCard = (m: MissionView) => `
<article class="mission">
  <header><h3>${esc(m.title)}</h3><span class="tag ${ACTIVE.includes(m.status) ? "live" : ""}">${esc(STATUS[m.status] ?? m.status)}</span></header>
  <div class="meta">Créée le ${esc(frDate(new Date(`${m.createdAt.replace(" ", "T")}Z`)))}${m.deadline ? ` · échéance ${esc(frDate(new Date(m.deadline)))}` : ""}</div>
  <div class="funnel">${funnelRow(m)}</div>
  ${m.waiting.length ? `<div class="waiting">À faire : ${m.waiting.map(esc).join(" · ")}</div>` : ""}
</article>`;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Agent X · Tableau de bord</title>
<style>
:root { --ink:#1b2130; --muted:#5f6878; --line:#e1e5ec; --bg:#f5f6f8; --card:#fff; --accent:#2f5bd3; --ok:#1d8a5b; --warn:#b4570b; }
@media (prefers-color-scheme: dark) { :root { --ink:#e7eaf0; --muted:#a2aab8; --line:#2b3341; --bg:#11151c; --card:#1a1f28; --accent:#7ea2ff; --ok:#5fd1a0; --warn:#f0a35e; } }
* { box-sizing:border-box } body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg) }
main { max-width:1100px; margin:0 auto; padding:20px 16px 60px } h1 { font-size:1.4rem; margin:0 } h2 { font-size:1.05rem; margin:28px 0 10px } h3 { font-size:1rem; margin:0 }
.top { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap } .muted, .meta { color:var(--muted); font-size:.88rem }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px }
.kpi, .mission, .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px }
.kpi .v { font-size:1.5rem; font-weight:650 } .kpi .t { color:var(--muted); font-size:.8rem }
.mission { margin-bottom:10px } .mission header { display:flex; justify-content:space-between; gap:8px; align-items:center }
.tag { font-size:.75rem; border:1px solid var(--line); border-radius:999px; padding:2px 8px; color:var(--muted) } .tag.live { color:var(--ok); border-color:var(--ok) }
.funnel { display:grid; grid-template-columns:repeat(8,1fr); gap:6px; margin-top:10px } .step { text-align:center; min-width:0 }
.bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden } .bar span { display:block; height:100%; background:var(--accent) }
.n { font-weight:650; margin-top:4px } .l { font-size:.72rem; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.waiting { margin-top:10px; color:var(--warn); font-size:.9rem }
table { width:100%; border-collapse:collapse; font-size:.9rem } td, th { text-align:left; padding:6px 4px; border-bottom:1px solid var(--line); vertical-align:top } th { color:var(--muted); font-weight:500 }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px } @media (max-width:760px) { .grid2 { grid-template-columns:1fr } .funnel { grid-template-columns:repeat(4,1fr) } }
ul { margin:0; padding-left:18px }
</style></head><body><main>
<div class="top"><h1>Agent X · Tableau de bord</h1><span class="muted">Mis à jour ${esc(frDate(now))} · <a href="/config">Configuration</a></span></div>
<h2>Indicateurs</h2>
<div class="kpis">${s.kpis.map((k) => `<div class="kpi"><div class="t">${esc(k.label)}</div><div class="v">${esc(k.value)}</div><div class="t">Cible ${esc(k.target)} · ${esc(k.help)}</div></div>`).join("")}</div>
<h2>Missions en cours (${active.length})</h2>
${active.length ? active.map(missionCard).join("") : `<p class="muted">Aucune mission en cours. Colle une fiche de poste dans Telegram pour en lancer une.</p>`}
<div class="grid2">
  <section class="panel"><h2 style="margin-top:0">Incidents</h2>${s.incidents.length ? `<ul>${s.incidents.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">Aucun incident : IA, recherche et planificateur fonctionnent.</p>`}</section>
  <section class="panel"><h2 style="margin-top:0">Profils présentés par source</h2>${s.sources.length ? `<table><tr><th>Source</th><th>Présentés</th><th>Placés</th></tr>${s.sources.map((r) => `<tr><td>${esc(r.source)}</td><td>${r.presentes}</td><td>${r.places}</td></tr>`).join("")}</table>` : `<p class="muted">Pas encore de profil présenté.</p>`}</section>
</div>
<h2>Activité récente</h2>
<section class="panel"><table><tr><th>Quand (UTC)</th><th>Action</th><th>Détail</th></tr>${s.journal.map((j) => `<tr><td>${esc(j.at)}</td><td>${esc(j.action)}</td><td class="muted">${esc(j.detail)}</td></tr>`).join("")}</table></section>
${s.missions.filter((m) => !active.includes(m)).length ? `<h2>Missions closes</h2>${s.missions.filter((m) => !active.includes(m)).map(missionCard).join("")}` : ""}
</main></body></html>`;
}

/** Bilan Telegram : ce qui a avancé, ce qui t'attend, les incidents. */
export function bilanText(s: Stats, publicUrl: string): string {
  const active = s.missions.filter((m) => ACTIVE.includes(m.status));
  const lines = [`☀️ Bilan Agent X · ${active.length} mission(s) en cours`];
  for (const m of active) {
    const f = m.funnel;
    lines.push("", `📁 ${m.title}`, `Sourcés ${f.sources} · à revoir ${f.aRevoir} · Go ${f.go} · contactés ${f.contactes} · répondu ${f.repondu} · qualifiés ${f.qualifies} · présentés ${f.presentes}`);
    if (m.deadline) lines.push(`Échéance : ${frDate(new Date(m.deadline))}`);
    if (m.waiting.length) lines.push(`👉 À faire : ${m.waiting.join(" · ")}`);
  }
  const k = s.kpis.filter((x) => x.value !== "—");
  if (k.length) lines.push("", `📊 ${k.map((x) => `${x.label} ${x.value}`).join(" · ")}`);
  lines.push("", s.incidents.length ? `⚠️ Incidents :\n${s.incidents.join("\n")}` : "✅ Aucun incident.");
  if (publicUrl) lines.push("", `Tableau de bord : ${publicUrl}/tableau`);
  return lines.join("\n");
}

/** Bilan quotidien à 8 h (heure de Paris), une fois par jour, appelé par le planificateur. */
export async function dailyBilan(env: Env, now = new Date()): Promise<boolean> {
  const p = parisParts(now);
  if (p.hh !== 8) return false;
  const today = `${p.y}-${p.m}-${p.d}`;
  if ((await getSetting(env, "bilan_last")) === today) return false;
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bilan_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(today).run();
  const s = await collectStats(env, now);
  if (!s.missions.some((m) => ACTIVE.includes(m.status)) && !s.incidents.length) return false;
  await notify(env, bilanText(s, (await getSetting(env, "public_url")) || env.PUBLIC_URL || ""));
  return true;
}
