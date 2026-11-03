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
export const COULD_NOT_OPEN_MEDIA = "No pude abrir ese archivo. ¿Me lo mandás otra vez o me escribís lo que necesitás?";

/** Sent when a message's photo or audio couldn't be downloaded after every attempt. */
export function couldNotDownload(kind: MessageKind): string {
  switch (kind) {
    case "image":
      return "No pude descargar la foto. ¿Me la mandás otra vez o me escribís lo que necesitás?";
    case "audio":
      return "No pude descargar la nota de voz. ¿Me la mandás otra vez o me escribís lo que necesitás?";
    default:
      return "No pude descargar el archivo. ¿Me lo mandás otra vez o me escribís lo que necesitás?";
  }
}

/**
 * A message we couldn't handle after every attempt, handed to the store (a Pendientes item is
 * raised with it): asking for it again could fail the same way.
 */
export const HANDED_TO_STORE = "Se lo pasé a la tienda para que te ayuden 🙏";

/**
 * Sent when a message couldn't be processed after every attempt. A photo or a voice note may read
 * fine sent again, so it's asked once; anything else goes to the store (HANDED_TO_STORE).
 */
export function couldNotProcess(kind: MessageKind): string {
  switch (kind) {
    case "image":
      return "Perdón, no pude leer tu foto. ¿Me la mandás otra vez o me escribís lo que necesitás?";
    case "audio":
      return "Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez o me escribís lo que necesitás?";
    default:
      return HANDED_TO_STORE;
  }
}
