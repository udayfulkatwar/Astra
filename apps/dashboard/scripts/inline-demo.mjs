/**
 * Turns the demo build (dist-demo/) into one self-contained page, dist-demo/astra-demo.html:
 * the CSS and JS are inlined, and the document skeleton is omitted because the page host adds it.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../dist-demo/', import.meta.url).pathname;
const assets = join(dir, 'assets');
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith('.js'));
const css = files.filter((f) => f.endsWith('.css'));
if (js.length !== 1)
  throw new Error(`expected exactly one JS bundle, found ${js.length}: ${js.join(', ')}`);

// Escape non-ASCII characters so the page renders correctly whatever charset it is served with.
const ascii = (text) =>
  text.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const script = ascii(readFileSync(join(assets, js[0]), 'utf8')).replaceAll(
  '</script',
  '<\\/script',
);
const styles = css
  .map((f) => readFileSync(join(assets, f), 'utf8'))
  .join('\n')
  .replace(/[\u0080-\uffff]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)
  .replaceAll('</style', '<\\/style');
const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');

const page = `<title>ASTRA Command Center</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}">
<style>${styles}</style>
<div id="root"></div>
<script type="module">${script}</script>
`;
writeFileSync(join(dir, 'astra-demo.html'), page);
console.log(`astra-demo.html: ${(page.length / 1024).toFixed(0)} KB`);
