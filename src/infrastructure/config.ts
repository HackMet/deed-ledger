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
  /** With devConsole: the simulator store's WhatsApp phone number ID; the console acts as its owner. */
  readonly devStorePhoneNumberId: string;
  /**
   * The pretend engine with its state in D1, for a deployed demo before the real engine lands. The
   * console still needs login, unless devConsole is also on (the simulator's --store).
   */
  readonly pretendEngine: boolean;
  /**
   * Who decides each conversation step: "planner" (a second Muse Spark call per burst, D-45) or
   * "classic" (the engine's own questions). Anything but "planner" is classic.
   */
  readonly conversation: "planner" | "classic";
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
    devStorePhoneNumberId: String(env.DEV_STORE_PHONE_NUMBER_ID ?? ""),
    pretendEngine: String(env.PRETEND_ENGINE ?? "") === "1",
    conversation: String(env.CONVERSATION ?? "") === "planner" ? "planner" : "classic",
    modelApiKey: env.MODEL_API_KEY ?? "",
    publicBaseUrl: String(env.PUBLIC_BASE_URL ?? "").replace(/\/+$/u, ""),
  };
}
