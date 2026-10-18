import { configPage, handleAdmin } from "./admin";
import { handleTelegram } from "./bot";
import { followUpPage, questionnairePage, questionnaireSubmit, stopPage } from "./candidate-pages";
import { ensureScheduler, runCron } from "./cron";
import type { Env } from "./env";
import { handleLinkedin } from "./linkedin-api";
import { ensureSchema } from "./migrate";

export { MissionWorkflow, SchedulerWorkflow } from "./workflow";

const text = (t: string, status = 200) => new Response(t, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      await ensureSchema(env);
      ctx.waitUntil(ensureScheduler(env).catch((e) => console.error("planificateur", e)));
      if (path === "/" || path === "/config") return configPage(env);
      if (path === "/sante") return text("ok");
      if (path === "/telegram/webhook" && req.method === "POST") return handleTelegram(env, req, ctx);
      if (path.startsWith("/api/admin/") || path.startsWith("/oauth/")) return handleAdmin(env, req, path);
      if (path.startsWith("/api/linkedin/")) return handleLinkedin(env, req, path);
      const fu = /^\/q\/([\w-]+)\/suite$/.exec(path);
      if (fu) return followUpPage(env, fu[1], req);
      const q = /^\/q\/([\w-]+)$/.exec(path);
      if (q) return req.method === "POST" ? questionnaireSubmit(env, q[1], req) : questionnairePage(env, q[1]);
      const stop = /^\/stop\/([\w-]+)$/.exec(path);
      if (stop) return stopPage(env, stop[1], req);
      return text("Introuvable", 404);
    } catch (e) {
      console.error(e);
      return text("Erreur interne. Réessayez dans un instant.", 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env);
        await runCron(env, event.cron);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
