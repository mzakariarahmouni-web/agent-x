import type { MissionParams } from "./workflow";

/** Liaisons et variables du Worker (voir wrangler.toml). */
export interface Env {
  DB: D1Database;
  FILES: KVNamespace;
  AI?: Ai;
  MISSION: Workflow<MissionParams>;
  PLANIFICATEUR?: Workflow<Record<string, never>>;
  PUBLIC_URL?: string;
  /** Mot de passe de la page de configuration ; sert aussi à dériver la clé de chiffrement des secrets. */
  ADMIN_TOKEN?: string;
  /** Tests locaux uniquement : redirige les appels sortants vers un serveur simulé. */
  MOCK_BASE?: string;
}
