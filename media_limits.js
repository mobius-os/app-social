// Originals and their display renditions have separate budgets. GIF originals
// stay byte-exact; ordinary photos can be compressed by the image preparer.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const GIF_MAX_BYTES = 20 * 1024 * 1024
export const GALLERY_MAX_BYTES = 20 * 1024 * 1024
export const THUMBNAIL_MAX_BYTES = 120 * 1024
export const IMAGE_MAX_SIDE = 1600
export const BOARD_ENVELOPE_MAX_BYTES = 60 * 1024 * 1024

export function attachmentBytes(attachment) {
  const encoded = attachment?.data_b64 || ''
  return Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
}

export function galleryFitsMediaLimits(attachments) {
  return attachments.length <= 4 && attachments.every(attachment => (
    attachmentBytes(attachment) <= (attachment.mime === 'image/gif' ? GIF_MAX_BYTES : IMAGE_MAX_BYTES)
  )) && attachments.reduce((total, attachment) => total + attachmentBytes(attachment), 0) <= GALLERY_MAX_BYTES
}
