/**
 * WhatsApp Cloud API message limits, checked against Meta's docs on October 28, 2026.
 *
 * Text: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages
 * Reply buttons: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
 * Lists: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages
 */
export const WHATSAPP_LIMITS = {
  textBodyChars: 4096,
  replyButtons: {
    maxButtons: 3,
    buttonTitleChars: 20,
    buttonIdChars: 256,
    bodyChars: 1024,
    footerChars: 60,
  },
  list: {
    maxSections: 10,
    maxRowsTotal: 10,
    buttonLabelChars: 20,
    rowTitleChars: 24,
    rowDescriptionChars: 72,
    rowIdChars: 200,
    sectionTitleChars: 24,
    headerTextChars: 60,
    bodyChars: 4096,
    footerChars: 60,
  },
} as const;
