import type { MessageKind } from "./processing";

/**
 * Everything the store owner or staff read from this part of the system, in one place for
 * review. Honduran Spanish, short, one decision per message, never blaming the person.
 */

/** The only reply a number that isn't a member of the store ever gets. */
export const UNKNOWN_SENDER_NOTICE = "Este número atiende solo a tiendas registradas.";

/** Placeholder until perception and the engine land. */
export const RECEIVED_PLACEHOLDER = "Recibí tu mensaje. Lo estoy revisando.";

/** Sent when a photo or voice note arrives without anything we can open (no usable media ID). */
export const COULD_NOT_OPEN_MEDIA = "No pude abrir ese archivo. ¿Me lo mandás otra vez?";

/** Sent when a message's photo or audio couldn't be downloaded after every attempt. */
export function couldNotDownload(kind: MessageKind): string {
  switch (kind) {
    case "image":
      return "No pude descargar la foto. ¿Me la mandás otra vez?";
    case "audio":
      return "No pude descargar la nota de voz. ¿Me la mandás otra vez?";
    default:
      return "No pude descargar el archivo. ¿Me lo mandás otra vez?";
  }
}

/** Sent when a message couldn't be processed after every attempt. */
export function couldNotProcess(kind: MessageKind): string {
  switch (kind) {
    case "image":
      return "Perdón, no pude leer tu foto. ¿Me la mandás otra vez?";
    case "audio":
      return "Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez?";
    default:
      return "Perdón, no pude revisar tu mensaje. ¿Me lo mandás otra vez?";
  }
}
