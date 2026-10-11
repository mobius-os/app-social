import test from 'node:test'
import assert from 'node:assert/strict'
import { sendMessage, sendGroupMessage, publishPost, postReply } from '../api.js'

test('every message surface sends its caption and photo in the same request', async () => {
  const photo = { mime: 'image/png', data_b64: 'cGhvdG8=', w: 24, h: 16 }
  const thumbnail = { ...photo, mime: 'image/webp' }
  const sent = []
  globalThis.fetch = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) })
    return { ok: true, async json() { return { status: 'ok' } } }
  }
  try {
    await sendMessage('stable-dm', 'peer.example', 'Caption', null, photo)
    await sendGroupMessage('stable-group', 'group-id', 'Caption', photo)
    await publishPost('Caption', null, [photo], [thumbnail])
    await postReply('post-id', 'Caption', { id: 'stable-reply', attachment: photo, thumbnail })
    assert.equal(sent.length, 4)
    for (const { body } of sent) {
      assert.equal(body.text, 'Caption')
      assert.deepEqual(body.attachment || body.attachments[0], photo)
    }
    assert.equal(sent[1].url, '/api/services/social/groups/group-id/send')
    assert.equal(sent[1].body.id, 'stable-group')
    assert.deepEqual(sent[3].body, {
      post_id: 'post-id', text: 'Caption', id: 'stable-reply', attachment: photo, thumbnail,
    })
  } finally { delete globalThis.fetch }
})
