import m0001 from "../../migrations/0001_init.sql";
import m0002 from "../../migrations/0002_revue.sql";
import m0003 from "../../migrations/0003_talent.sql";
import m0004 from "../../migrations/0004_semantique.sql";
import type { Env } from "./env";

/** Migrations embarquées : la base se crée seule au premier appel, sans commande à lancer. */
const MIGRATIONS: [number, string][] = [
  [1, m0001],
  [2, m0002],
  [3, m0003],
  [4, m0004],
];

let checked = false;

/** Découpe un fichier SQL en instructions (commentaires « -- » retirés). */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function ensureSchema(env: Env): Promise<void> {
  if (checked) return;
  const exists = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").first();
  let current = 0;
  if (exists) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>();
    current = Number(row?.value ?? 1);
  }
  for (const [version, sql] of MIGRATIONS) {
    if (version <= current) continue;
    const stmts = splitSql(sql).map((s) => env.DB.prepare(s));
    stmts.push(
      env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(String(version)),
    );
    await env.DB.batch(stmts);
  }
  checked = true;
}
