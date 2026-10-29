import type { MediaSource } from "../../application/ports";

/**
 * Stub until the download is verified against a real webhook. Meta documents it as: GET
 * /<version>/<MEDIA_ID>?phone_number_id=<id> with the access token returns a URL valid for
 * 5 minutes; an authorized GET on that URL returns the bytes; webhook media IDs expire after
 * 7 days. https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
 *
 * Returning null leaves the media asset pending: the job retries with backoff, then fails with
 * an honest reply ("No pude descargar…"). Until the real download lands, every photo and voice
 * note ends that way.
 */
export const unavailableMediaSource: MediaSource = {
  async fetch() {
    return null;
  },
};
