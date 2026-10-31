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
  /** Signs the console's CSRF values. Blank: the console's login fails closed. */
  readonly linkSigningSecret: string;
  /** The console without login, on the in-memory pretend engine. Local simulator only. */
  readonly devConsole: boolean;
  /** The Meta Model API key. Blank: model calls fail closed. */
  readonly modelApiKey: string;
  /** The Worker's public origin (https://…), for links customers get. Blank: links are left out. */
  readonly publicBaseUrl: string;
}

export function readConfig(env: Env): Config {
  return {
    whatsappAppSecret: env.WHATSAPP_APP_SECRET ?? "",
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
    whatsappToken: env.WHATSAPP_TOKEN ?? "",
    senderHashSalt: env.SENDER_HASH_SALT ?? "",
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION ?? "v26.0",
    linkSigningSecret: env.LINK_SIGNING_SECRET ?? "",
    devConsole: String(env.DEV_CONSOLE ?? "") === "1",
    modelApiKey: env.MODEL_API_KEY ?? "",
    publicBaseUrl: String(env.PUBLIC_BASE_URL ?? "").replace(/\/+$/u, ""),
  };
}
