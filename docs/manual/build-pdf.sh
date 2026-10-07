#!/usr/bin/env bash
# Builds docs/Flux-AM-documentatie-completa.pdf: illustrated manual (Part I) + technical documentation (Part II).
# Needs pandoc and the Playwright Chromium (pnpm install at the repo root).
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
{
  cat MANUAL-ILUSTRAT.md
  printf '\n\n<div class="part">Partea II<br><span>Documentație tehnică</span></div>\n\n'
  # the technical document lives one level up: shift its links to that location
  sed -e 's#](faza-#](../faza-#g' -e 's#](\.\./#](../../#g' ../DOCUMENTATIE-TEHNICA.md
} > "$work/all.md"
pandoc "$work/all.md" -f gfm -t html5 -s --metadata title="Flux AM – documentație completă" -c style.css -o "$work/body.html"
python3 - "$work/body.html" "$PWD" <<'PY'
import re, sys
p, here = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s = re.sub(r'<header id="title-block-header">.*?</header>', '', s, flags=re.S)
cover = '''<section class="cover">
  <div class="brand">Flux AM</div>
  <div class="cover-title">Documentație completă</div>
  <p class="cover-sub">Manual ilustrat al platformei și documentație tehnică</p>
  <p class="cover-meta">Management electronic al documentelor și fluxurilor pentru Autorități de Management<br>
  și Organisme Intermediare – Agențiile pentru Dezvoltare Regională</p>
  <p class="cover-meta">Versiunea octombrie 2026 · capturi din platforma demonstrativă (date fictive)</p>
</section>'''
s = s.replace('<body>', '<body>\n' + cover, 1)
s = s.replace('src="img/', f'src="file://{here}/img/')
s = s.replace('<link rel="stylesheet" href="style.css" />', f'<link rel="stylesheet" href="file://{here}/style.css" />')
open(p, 'w', encoding='utf-8').write(s)
PY
cp "$work/body.html" "$work/doc.html"
cat > "$work/pdf.mjs" <<'JS'
import { chromium } from '@playwright/test';
const [,, html, out] = process.argv;
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('file://' + html, { waitUntil: 'load' });
await p.pdf({ path: out, format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#6b7480">Flux AM – documentație completă · pagina <span class="pageNumber"></span> din <span class="totalPages"></span></div>',
  margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' } });
await b.close();
JS
cp "$work/pdf.mjs" ../../.build-pdf.tmp.mjs
(cd ../.. && node .build-pdf.tmp.mjs "$work/doc.html" docs/Flux-AM-documentatie-completa.pdf); rm -f ../../.build-pdf.tmp.mjs
rm -rf "$work"
echo "docs/Flux-AM-documentatie-completa.pdf"
