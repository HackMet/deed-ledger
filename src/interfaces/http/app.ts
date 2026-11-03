import { Hono } from "hono";
import { dispatchUnknownNotice } from "../../application/dispatch";
import { describeError } from "../../application/errors";
import { PRIVACY_PATH } from "../../domain/customer-controls";
import { acceptEvents, type IntakeOutcome } from "../../application/intake";
import type { Deps } from "../../application/ports";
import type { Runtime } from "../../composition";
import { consoleRoutes } from "./console";
import type { HttpEnv } from "./env";
import { privacyRoutes } from "./privacy";
import { parseWebhookPayload } from "../../integrations/whatsapp/payload";
import { verifyTokenMatches, verifyWebhookSignature } from "../../integrations/whatsapp/signature";

/** Meta's webhook payloads are up to 3 MB; anything bigger isn't from Meta. */
const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;

export function createHttpApp(makeRuntime: (env: Env) => Runtime) {
  const app = new Hono<HttpEnv>();

  app.use("*", async (c, next) => {
    c.set("runtime", makeRuntime(c.env));
    await next();
  });

  app.get("/health", (c) => c.text("ok"));

  // Meta's subscription check: echo hub.challenge only when the verify token matches.
  app.get("/webhooks/whatsapp", async (c) => {
    const { config } = c.get("runtime");
    const challenge = c.req.query("hub.challenge");
    const accepted =
      c.req.query("hub.mode") === "subscribe" &&
      challenge !== undefined &&
      challenge.length <= 256 &&
      (await verifyTokenMatches(config.whatsappVerifyToken, c.req.query("hub.verify_token")));
    return accepted ? c.text(challenge, 200) : c.text("Forbidden", 403);
  });

  app.post("/webhooks/whatsapp", async (c) => {
    const { config, deps } = c.get("runtime");
    if (config.whatsappAppSecret === "" || config.senderHashSalt === "") {
      deps.log.error("webhook_config_incomplete");
      return c.text("Not configured", 500);
    }

    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (declaredLength > MAX_WEBHOOK_BYTES) return c.text("Payload too large", 413);
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_WEBHOOK_BYTES) return c.text("Payload too large", 413);

    // The signature covers the exact bytes received, so it is checked before anything is parsed.
    if (!(await verifyWebhookSignature(config.whatsappAppSecret, raw, c.req.header("x-hub-signature-256")))) {
      deps.log.warn("webhook_signature_rejected");
      return c.text("Unauthorized", 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      deps.log.warn("webhook_body_unparseable");
      return c.text("Bad request", 400);
    }
    const parsed = parseWebhookPayload(body);
    if (parsed === null) {
      deps.log.warn("webhook_unexpected_object");
      return c.text("ok", 200);
    }

    let outcome: IntakeOutcome;
    try {
      outcome = await acceptEvents(deps, parsed.events);
    } catch (error) {
      // Nothing is acknowledged unless it was saved: Meta retries on any status other than 200.
      deps.log.error("webhook_intake_failed", { reason: describeError(error) });
      return c.text("Retry later", 500);
    }
    deps.log.info("webhook_accepted", { count: parsed.events.length, outcome: `skipped:${parsed.skipped}` });
    c.executionCtx.waitUntil(afterIntake(deps, outcome));
    return c.text("ok", 200);
  });

  // The simulator's media uploads (`npm run chat` /foto, /audio). Not found outside the simulator.
  app.post("/dev/sim-media", async (c) => {
    const sim = c.get("runtime").simMedia;
    if (sim === null) return c.text("Not found", 404);
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    const id = await sim.upload(type, await c.req.arrayBuffer());
    return id === null ? c.text("Unsupported media", 415) : c.json({ id });
  });

  app.route("/console", consoleRoutes());
  app.route(PRIVACY_PATH, privacyRoutes());

  app.notFound((c) => c.text("Not found", 404));

  app.onError((error, c) => {
    console.error(JSON.stringify({ level: "error", event: "http_unhandled_error", reason: describeError(error) }));
    return c.text("Internal error", 500);
  });

  return app;
}

/**
 * After the 200: ring each conversation's doorbell and send unknown-sender notices. A lost ring is
 * recovered by the cron sweep; a lost notice is not retried (its phone number isn't kept).
 */
async function afterIntake(deps: Deps, outcome: IntakeOutcome): Promise<void> {
  for (const conversation of outcome.conversations) {
    try {
      const startedAt = deps.clock.now();
      await deps.doorbell.ring(conversation);
      // The queue has it: with doorbell_received, this shows how long the queue held it.
      deps.log.info("doorbell_rung", { ...conversation, latencyMs: deps.clock.now() - startedAt });
    } catch (error) {
      deps.log.error("doorbell_ring_failed", { ...conversation, reason: describeError(error) });
    }
  }
  for (const notice of outcome.notices) {
    try {
      await dispatchUnknownNotice(deps, notice);
    } catch (error) {
      deps.log.error("unknown_notice_dispatch_failed", {
        businessId: notice.businessId,
        outboxId: notice.outboxId,
        reason: describeError(error),
      });
    }
  }
}
