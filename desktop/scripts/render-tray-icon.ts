// Rasterises the menu-bar template glyph. macOS renders tray images at 18pt tall
// (tray-icon 0.24 hard-codes NSImage height = 18 and scales width by the source
// aspect ratio), so the PNG is authored at 44x38 — the @2x rendition of a 22x19pt
// glyph, 1:1 device pixels on Retina.
//
// Chromium (already a dev dependency via Playwright) does the rasterising:
// neither librsvg, ImageMagick nor cairosvg is installed, and sips cannot read SVG.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../src-tauri/icons/tray-template.svg')
const out = resolve(here, '../src-tauri/icons/tray-template.png')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 44, height: 38 }, deviceScaleFactor: 1 })
await page.setContent(
  `<style>html,body{margin:0;padding:0;background:transparent}</style>${readFileSync(src, 'utf8')}`,
)
writeFileSync(out, await page.screenshot({ omitBackground: true }))
await browser.close()
console.log(`wrote ${out} (44x38 macOS template icon)`)
