// Confere o conversor de texto em fonemas (g2p-ptbr.js) contra a referência gerada pelo
// pacote Python oficial do Kokoro (misaki + phonemizer + espeak-ng).
// Uso: node tests/comparar-fonemas.mjs
import fs from 'fs';
import ESpeak from '../espeak-pt/espeak-ng.js';
import { createG2P } from '../g2p-ptbr.js';

const g2p = createG2P(await ESpeak());
const ref = JSON.parse(fs.readFileSync(new URL('./fonemas-referencia.json', import.meta.url), 'utf8'));
let ok = 0;
for (const { text, ps } of ref) {
  const mine = g2p(text);
  if (mine === ps) ok++;
  else console.log('DIFERENTE', JSON.stringify(text), '\n  python:', JSON.stringify(ps), '\n  js:    ', JSON.stringify(mine));
}
console.log(`${ok}/${ref.length} iguais`);
process.exit(ok === ref.length ? 0 : 1);
