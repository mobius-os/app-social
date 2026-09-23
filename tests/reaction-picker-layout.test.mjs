import test from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { CSS } from '../theme.js'

const browserCandidates = [
  process.env.CHROME_BIN,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
].filter(Boolean)

function findBrowser() {
  for (const candidate of browserCandidates) {
    if (!candidate.includes('/')) {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
      if (!probe.error && probe.status === 0) return candidate
      continue
    }
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

const browser = findBrowser()

test('24 counted reactions and the inline picker stay inside a phone viewport', {
  skip: browser ? false : 'headless Chrome is unavailable',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'social-reaction-layout-'))
  const htmlPath = join(directory, 'index.html')
  const reactions = Array.from({ length: 24 }, (_, index) => `
    <button class="cn-reaction-chip" type="button" aria-label="Reaction ${index + 1}, 2000 reactions">
      <span class="cn-reaction-visual"><span class="cn-flat-emoji">👍</span><b>2000</b></span>
    </button>
  `).join('')
  const choices = Array.from({ length: 24 }, (_, index) => `
    <button type="button" aria-label="Choice ${index + 1}">👍</button>
  `).join('')

  const phoneDocument = `<!doctype html>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { --muted: #667; --accent: #4676ee; --border: #ccd; --surface: #fff; --font: sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      .phone { width: 100%; padding: 0 16px; overflow: hidden; }
      ${CSS}
      .cn-post-actions { margin-left: -8px; }
      .cn-reaction-picker { animation: none; }
    </style>
    <main class="phone">
      <div class="cn-post-actions">
        <div class="cn-reactions has-picker" aria-label="Post reactions">
          ${reactions}
          <button class="cn-react cn-add-reaction" aria-label="Add reaction">+</button>
          <div class="cn-reaction-picker" role="group" aria-label="Choose a reaction">
            <span class="cn-reaction-picker-title">Choose a reaction</span>
            <div class="cn-reaction-grid">${choices}</div>
          </div>
        </div>
      </div>
    </main>
  `
  writeFileSync(htmlPath, `<!doctype html>
    <meta charset="utf-8">
    <iframe id="phone" title="320 pixel phone layout" width="320" height="1000" style="border:0"></iframe>
    <pre id="result"></pre>
    <script>
      const frame = document.querySelector('#phone')
      frame.addEventListener('load', () => {
        const view = frame.contentWindow
        const document = frame.contentDocument
        const picker = document.querySelector('.cn-reaction-picker').getBoundingClientRect()
        const chips = [...document.querySelectorAll('.cn-reaction-chip')].map(node => node.getBoundingClientRect())
        const choices = [...document.querySelectorAll('.cn-reaction-grid button')].map(node => node.getBoundingClientRect())
        window.document.querySelector('#result').textContent = JSON.stringify({
          viewportWidth: view.innerWidth,
          picker: { left: picker.left, right: picker.right, top: picker.top, bottom: picker.bottom, width: picker.width },
          firstChipTop: chips[0].top,
          lastChipTop: chips.at(-1).top,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          choiceSizes: choices.map(({ width, height }) => [width, height]),
        })
      })
      frame.srcdoc = ${JSON.stringify(phoneDocument)}
    </script>`, 'utf8')

  try {
    const rendered = spawnSync(browser, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=320,1000',
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(rendered.status, 0, rendered.stderr || rendered.error?.message)
    const match = rendered.stdout.match(/<pre id="result">([^<]+)<\/pre>/)
    assert.ok(match, 'rendered page returned layout measurements')
    const geometry = JSON.parse(match[1].replaceAll('&quot;', '"'))

    assert.equal(geometry.viewportWidth, 320)
    assert.ok(geometry.lastChipTop > geometry.firstChipTop, 'all 24 counted reactions wrap')
    assert.ok(geometry.picker.top >= 0, 'a first-post picker stays below the phone’s top edge')
    assert.ok(geometry.picker.left >= 0, 'picker stays inside the phone’s left edge')
    assert.ok(geometry.picker.right <= geometry.viewportWidth, 'picker stays inside the phone’s right edge')
    assert.equal(geometry.scrollWidth, geometry.clientWidth, 'picker does not create horizontal overflow')
    assert.ok(
      geometry.choiceSizes.every(([width, height]) => width === 44 && height === 44),
      `all picker choices retain 44px targets: ${JSON.stringify(geometry.choiceSizes)}`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
