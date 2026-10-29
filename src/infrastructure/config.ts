/**
 * Settings read from env bindings only (Cloudflare secrets when deployed, .dev.vars locally).
 * A missing secret reads as "" and the feature that needs it fails closed.
 */
export interface Config {
  readonly whatsappAppSecret: string;
  readonly whatsappVerifyToken: string;
  readonly whatsappToken: string;
  readonly senderHashSalt: string;
  readonly graphApiVersion: string;
}

export function readConfig(env: Env): Config {
  return {
    whatsappAppSecret: env.WHATSAPP_APP_SECRET ?? "",
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
    whatsappToken: env.WHATSAPP_TOKEN ?? "",
    senderHashSalt: env.SENDER_HASH_SALT ?? "",
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION ?? "v26.0",
  };
}
