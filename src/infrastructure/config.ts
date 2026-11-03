/**
 * Settings read from env bindings only (Cloudflare secrets when deployed, .dev.vars locally).
 * A missing secret reads as "" and the feature that needs it fails closed.
 */
import {
  isPromptCacheRetention,
  isReasoningEffort,
  type ModelCallSettings,
  type ReasoningEffort,
} from "../application/model-settings";

/**
 * Each call's reasoning effort when its variable is blank, on the planner path: measured on Nov 2,
 * 2026 (docs/handoffs/2026-11-02-latency.md). Reader "low" read the same lines as the model's own
 * effort in about a third of the time ("minimal" misread a count); planner "minimal" made the same
 * moves as "low", faster, while the model's own effort once reasoned past its 6,144-token cap.
 * The classic path's reader (with catalog picks) wasn't measured, so it keeps the model's own.
 */
export const DEFAULT_READER_EFFORT: ReasoningEffort | "default" = "low";
export const DEFAULT_PLANNER_EFFORT: ReasoningEffort | "default" = "minimal";

/**
 * The one-call text path (D-52, measured Nov 2): on by default in planner mode, at "minimal". At
 * "low" the combined call reasoned 1,300-2,100 tokens (14.5-24.3 s, slower than the two calls it
 * replaces); at "minimal", 350-570 tokens and 5.7-9.0 s, with the same outcomes on the same messages.
 */
export const DEFAULT_FAST_TEXT_EFFORT: ReasoningEffort | "default" = "minimal";
/** Whether the planner path reads and plans a text-only burst in one call when PLANNER_FAST_TEXT is blank. */
export const DEFAULT_FAST_TEXT = true;

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
  /** The real order engine (OrderEngine, on D1) with perception's reads: DEED_ENGINE "1". Off by default. */
  readonly deedEngine: boolean;
  /**
   * Who decides each conversation step: "planner" (a second Muse Spark call per burst, D-45) or
   * "classic" (the engine's own questions). Anything but "planner" is classic.
   */
  readonly conversation: "planner" | "classic";
  /** The Meta Model API key. Blank: model calls fail closed. */
  readonly modelApiKey: string;
  /**
   * The reader's and the planner's Muse Spark settings. READER_REASONING_EFFORT and
   * PLANNER_REASONING_EFFORT: one of Meta's efforts, or "default" to send none; blank or anything
   * else (even "none", which Muse Spark refuses) is the measured default above (the classic
   * reader's is "default").
   * PROMPT_CACHE_RETENTION: "in_memory" or "24h"; blank or anything else sends none (Meta's default).
   */
  readonly readerModel: ModelCallSettings;
  readonly plannerModel: ModelCallSettings;
  /**
   * Planner path only: a burst of text only is read and planned in one call (PLANNER_FAST_TEXT "1";
   * "0" off; blank DEFAULT_FAST_TEXT), with FAST_TEXT_REASONING_EFFORT like the efforts above.
   */
  readonly fastText: boolean;
  readonly fastTextModel: ModelCallSettings;
  /** The Worker's public origin (https://…), for links customers get. Blank: links are left out. */
  readonly publicBaseUrl: string;
  /**
   * WhatsApp test commands (/new, /help) for the store's own members: TEST_COMMANDS "1". Only for
   * testing on a number whose store has no real customers, unless the owner wants it.
   */
  readonly testCommands: boolean;
}

export function readConfig(env: Env): Config {
  const conversation = String(env.CONVERSATION ?? "") === "planner" ? "planner" : "classic";
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
    deedEngine: String(env.DEED_ENGINE ?? "") === "1",
    conversation,
    modelApiKey: env.MODEL_API_KEY ?? "",
    readerModel: modelSettings(env.READER_REASONING_EFFORT, conversation === "planner" ? DEFAULT_READER_EFFORT : "default", env.PROMPT_CACHE_RETENTION),
    plannerModel: modelSettings(env.PLANNER_REASONING_EFFORT, DEFAULT_PLANNER_EFFORT, env.PROMPT_CACHE_RETENTION),
    fastText: conversation === "planner" && fastText(env.PLANNER_FAST_TEXT),
    fastTextModel: modelSettings(env.FAST_TEXT_REASONING_EFFORT, DEFAULT_FAST_TEXT_EFFORT, env.PROMPT_CACHE_RETENTION),
    publicBaseUrl: String(env.PUBLIC_BASE_URL ?? "").replace(/\/+$/u, ""),
    testCommands: String(env.TEST_COMMANDS ?? "") === "1",
  };
}

function fastText(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  return raw === "1" ? true : raw === "0" ? false : DEFAULT_FAST_TEXT;
}

function modelSettings(effort: unknown, fallback: ReasoningEffort | "default", retention: unknown): ModelCallSettings {
  const raw = String(effort ?? "").trim();
  const chosen = raw === "default" || isReasoningEffort(raw) ? raw : fallback;
  const kept = String(retention ?? "").trim();
  return {
    ...(chosen === "default" ? {} : { reasoningEffort: chosen }),
    ...(isPromptCacheRetention(kept) ? { promptCacheRetention: kept } : {}),
  };
}
