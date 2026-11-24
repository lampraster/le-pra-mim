// Texto em português do Brasil -> fonemas no formato que o Kokoro espera.
// Reproduz, passo a passo, o caminho do pacote Python oficial:
//   misaki.espeak.EspeakG2P('pt-br') -> phonemizer.EspeakBackend(preserve_punctuation=True,
//   with_stress=True, tie='^', language_switch='remove-flags') -> espeak-ng.

const MARKS = ';:,.!?¡¿—…"«»“”(){}[]';
const MARKS_RE = new RegExp('(\\s*[' + MARKS.replace(/[\\\]\[\-^]/g, '\\$&') + ']+\\s*)+', 'gu');

// misaki: ditongos e africadas viram um símbolo só (ordem alfabética das chaves, como no Python).
const E2M = Object.entries({
  'a^ɪ': 'I', 'a^ʊ': 'W',
  'd^z': 'ʣ', 'd^ʒ': 'ʤ',
  'e^ɪ': 'A',
  'o^ʊ': 'O', 'ə^ʊ': 'Q',
  's^s': 'S',
  't^s': 'ʦ', 't^ʃ': 'ʧ',
  'ɔ^ɪ': 'Y',
}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const IS_LETTER = /^[\p{Ll}\p{Lu}\p{Lo}]$/u;

// O espeak devolve "n_ˈoɪ_tʃ_y" (modo IPA com "_" entre fonemas). O phonemizer usa o modo
// com "tie": sem separadores e com "^" ligando as letras de um fonema composto ("nˈo^ɪt^ʃy").
function tieWord(word) {
  let out = '';
  for (const ph of word.split('_')) {
    if (!ph) continue;
    let seenLetter = false;
    for (const ch of ph) {
      if (IS_LETTER.test(ch)) {
        if (seenLetter) out += '^';
        seenLetter = true;
      }
      out += ch;
    }
  }
  return out;
}

// phonemizer.punctuation.Punctuation._preserve_line
function preserveLine(line) {
  const matches = [...line.matchAll(MARKS_RE)];
  if (!matches.length) return { chunks: [line], marks: [] };
  if (matches.length === 1 && matches[0][0] === line) return { chunks: [], marks: [{ mark: line, position: 'A' }] };
  const marks = matches.map((m, k) => {
    let position = 'I';
    if (k === 0 && line.startsWith(m[0])) position = 'B';
    else if (k === matches.length - 1 && line.endsWith(m[0])) position = 'E';
    return { mark: m[0], position };
  });
  const chunks = [];
  let rest = line;
  for (const { mark } of marks) {
    const split = rest.split(mark);
    chunks.push(split[0]);
    rest = split.slice(1).join(mark);
  }
  chunks.push(rest);
  return { chunks: chunks.filter((c) => c), marks };
}

// phonemizer.punctuation.Punctuation.restore (uma linha, separador de palavra " ", strip=False)
function restore(textIn, marksIn) {
  let text = textIn.slice();
  let marks = marksIn.slice();
  const out = [];
  while (text.length || marks.length) {
    if (!marks.length) {
      for (let line of text) {
        if (!line.endsWith(' ')) line += ' ';
        out.push(line);
      }
      text = [];
    } else if (!text.length) {
      out.push(marks.map((m) => m.mark).join(''));
      marks = [];
    } else {
      const cur = marks[0];
      // Todas as marcas são da linha 0; depois de um "E" ou "A" (pos = 1) nada mais casa.
      if (out.length === 0) {
        marks = marks.slice(1);
        const mark = cur.mark;
        if (text[0].endsWith(' ')) text[0] = text[0].slice(0, -1);
        if (cur.position === 'B') {
          text[0] = mark + text[0];
        } else if (cur.position === 'E') {
          out.push(text[0] + mark + (mark.endsWith(' ') ? '' : ' '));
          text = text.slice(1);
        } else if (cur.position === 'A') {
          out.push(mark + (mark.endsWith(' ') ? '' : ' '));
        } else if (text.length === 1) {
          text[0] = text[0] + mark;
        } else {
          const first = text[0];
          text = text.slice(1);
          text[0] = first + mark + text[0];
        }
      } else {
        out.push(text[0]);
        text = text.slice(1);
      }
    }
  }
  return out;
}

export function createG2P(espeakModule) {
  const worker = new espeakModule.eSpeakNGWorker();
  if (worker.set_voice('pt-BR') !== 0) throw new Error('A voz pt-BR do espeak-ng não carregou.');
  const heap = () => espeakModule.HEAPU8;
  const decoder = new TextDecoder();
  const cstr = (ptr) => {
    const h = heap();
    let end = ptr;
    while (h[end]) end++;
    return decoder.decode(h.subarray(ptr, end));
  };

  // EspeakBackend._phonemize_aux + _postprocess_line para um pedaço sem pontuação.
  function espeakChunk(chunk) {
    const raw = cstr(espeakModule.getPointer(worker.text_to_phonemes(chunk, 1)));
    let line = raw.replace(/ \| /g, ' ').trim().replace(/\n/g, ' ').replace(/ {2}/g, ' ');
    line = line.replace(/\(.+?\)/g, '');                 // language_switch='remove-flags'
    if (!line) return '';
    let out = '';
    for (const word of line.split(' ')) out += tieWord(word.trim()) + ' ';
    return out;
  }

  function phonemizeLine(line) {
    const { chunks, marks } = preserveLine(line);
    const phon = chunks.map(espeakChunk);
    const restored = restore(phon, marks);
    return restored[0] || '';
  }

  // misaki.espeak.EspeakG2P.__call__
  return function g2p(text) {
    let t = String(text).replace(/«/g, '“').replace(/»/g, '”');
    t = t.replace(/\(/g, '«').replace(/\)/g, '»');
    let ps = phonemizeLine(t).trim();
    if (!ps) return '';
    for (const [from, to] of E2M) ps = ps.split(from).join(to);
    ps = ps.replace(/\^/g, '').replace(/-/g, '');
    return ps.replace(/«/g, '(').replace(/»/g, ')');
  };
}
