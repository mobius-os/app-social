const BOARD_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024

// The browser does not know its final federation hostname, id, timestamp, or
// signature. Use their largest valid shapes so passing here guarantees that
// the signed request assembled by the service fits the receiver's cap.
const MAX_HOST = `${'h'.repeat(251)}:65535`
const MAX_ID = '0'.repeat(64)
const SIGNATURE = 'A'.repeat(88)
const MAX_TIMESTAMP = Number.MAX_VALUE

export function boardPostWireBytes({ text = '', attachment, attachments, thumbnails }) {
  const envelope = {
    v: 0,
    type: 'board_post',
    id: MAX_ID,
    from: MAX_HOST,
    text,
    sent_at: MAX_TIMESTAMP,
  }
  if (Array.isArray(attachments) && attachments.length) {
    envelope.attachments = attachments
    envelope.attachment = attachments[0]
  } else if (attachment) {
    envelope.attachment = attachment
  }
  if (Array.isArray(thumbnails) && thumbnails.length) envelope.thumbnails = thumbnails
  envelope.sig = SIGNATURE
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength
}

export function boardPostFitsWireLimit(payload) {
  return boardPostWireBytes(payload) <= BOARD_ENVELOPE_MAX_BYTES
}

export { BOARD_ENVELOPE_MAX_BYTES }
