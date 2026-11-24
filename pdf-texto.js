// Extrai o texto de um PDF no próprio aparelho (PDF.js), já em ordem de leitura:
// junta as linhas em parágrafos, desfaz a hifenização do fim de linha e tira cabeçalhos,
// rodapés e números de página que se repetem.

const PDFJS = new URL('vendor/pdfjs/pdf.min.mjs', import.meta.url).href;
const PDFJS_WORKER = new URL('vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfjsPromise;
}

export function isPdf(file, bytes) {
  if (file && (/pdf/i.test(file.type || '') || /\.pdf$/i.test(file.name || ''))) return true;
  return !!bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export async function openPdf(bytes) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    return await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new Error('Este PDF é protegido por senha.');
    throw new Error('Não consegui abrir esse PDF. O arquivo pode estar corrompido.');
  }
}

const TERMINAL = /[.!?…:;"”»)\]]$/;
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
// Hífen de fim de linha que faz parte da palavra (segunda-feira, disse-lhe) e deve ficar.
const KEEP_HYPHEN_NEXT = /^(me|te|se|lhe|lhes|nos|vos|o|a|os|as|lo|la|los|las|no|na|nas|feira)(?![\p{L}])/u;

function median(values) {
  if (!values.length) return 0;
  const v = values.slice().sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}
function quantile(values, q) {
  if (!values.length) return 0;
  const v = values.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))];
}

function cleanText(s) {
  return s.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] || c).replace(/[\s ]+/g, ' ');
}

// Itens do PDF.js -> linhas {text, x, right, y, size}, na ordem em que aparecem na página.
function pageLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const x = t[4];
    const y = t[5];
    const size = Math.hypot(t[2], t[3]) || it.height || 10;
    const s = cleanText(it.str);
    if (s.trim()) {
      if (cur && Math.abs(y - cur.y) > Math.max(size, cur.size) * 0.6) cur = null;
      if (!cur) {
        cur = { text: '', x, right: x, y, size };
        lines.push(cur);
      } else if (!/\s$/.test(cur.text) && !/^\s/.test(s) && x - cur.right > size * 0.18) {
        cur.text += ' ';
      }
      cur.text += s;
      cur.right = Math.max(cur.right, x + (it.width || 0));
      cur.x = Math.min(cur.x, x);
      cur.size = Math.max(cur.size, size);
    } else if (cur && s && !/\s$/.test(cur.text)) {
      cur.text += ' ';
    }
    if (it.hasEOL) cur = null;
  }
  for (const l of lines) l.text = l.text.replace(/ {2,}/g, ' ').trim();
  return lines.filter((l) => l.text);
}

function joinLines(a, b) {
  const m = a.match(/(\p{L})[-­‐]$/u);
  if (m && /^\p{Ll}/u.test(b)) {
    if (KEEP_HYPHEN_NEXT.test(b)) return a.replace(/[­‐]$/, '-') + b;
    return a.slice(0, -1) + b;                              // trans-\nformação -> transformação
  }
  return a + ' ' + b;
}

// Linhas de uma página -> parágrafos.
function pageParagraphs(lines) {
  const gaps = [];
  for (let k = 1; k < lines.length; k++) {
    const g = (lines[k - 1].y - lines[k].y) / lines[k].size;
    if (g > 0.5 && g < 4) gaps.push(g);
  }
  const typical = median(gaps) || 1.25;
  // Margens de cada coluna: linhas que começam perto (até 4 letras de distância) são da mesma coluna.
  const margins = (l) => {
    const same = lines.filter((o) => Math.abs(o.x - l.x) < l.size * 4);
    return { left: quantile(same.map((o) => o.x), 0.15), right: quantile(same.map((o) => o.right), 0.85) };
  };
  const paras = [];
  let cur = null;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    const prev = lines[k - 1];
    let brk = !cur;
    if (!brk) {
      const g = (prev.y - l.y) / l.size;
      const newColumn = g < -0.5;                                   // subiu: começo de outra coluna
      if (!newColumn && g > typical * 1.45) brk = true;             // espaço maior entre linhas
      else if (Math.abs(l.size - prev.size) > prev.size * 0.18) brk = true; // mudou o tamanho da letra
      else if (TERMINAL.test(prev.text)) {
        const pm = margins(prev);
        const lm = margins(l);
        if (prev.right < pm.right - prev.size * 2 || l.x > lm.left + l.size * 0.8) brk = true;  // linha curta ou recuo
      }
    }
    if (brk) {
      cur = { text: l.text };
      paras.push(cur);
    } else {
      cur.text = joinLines(cur.text, l.text);
    }
  }
  return paras.map((p) => p.text);
}

const PAGE_NUMBER = /^((p(á|a)g(ina)?\.?|page)\s*)?\d{1,4}(\s*(de|\/|of)\s*\d{1,4})?$|^[ivxlcdm]{1,7}$/i;
const runningKey = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

// Tira números de página e cabeçalhos/rodapés repetidos no topo ou no pé das páginas.
function stripRunning(pages) {
  const n = pages.length;
  const min = Math.max(3, Math.ceil(n * 0.4));
  const count = new Map();
  for (const lines of pages) {
    const seen = new Set();
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const k = runningKey(l.text);
      if (seen.has(k)) continue;
      seen.add(k);
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  const repeated = (l) => n >= 3 && (count.get(runningKey(l.text)) || 0) >= min;
  const drop = (l) => PAGE_NUMBER.test(l.text) || repeated(l);
  return pages.map((lines) => {
    let a = 0;
    let b = lines.length;
    while (a < b && a < 2 && drop(lines[a])) a++;
    while (b > a && lines.length - b < 2 && drop(lines[b - 1])) b--;
    return lines.slice(a, b);
  });
}

// Extrai o texto das páginas [from, to] (1 = primeira). onProgress(feitas, total). shouldStop() cancela.
export async function extractText(doc, { from = 1, to = doc.numPages, onProgress, shouldStop } = {}) {
  const first = Math.max(1, Math.min(from, doc.numPages));
  const last = Math.max(first, Math.min(to, doc.numPages));
  const pages = [];
  for (let p = first; p <= last; p++) {
    if (shouldStop && shouldStop()) throw new Error('cancelado');
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(pageLines(content.items));
    page.cleanup();
    if (onProgress) onProgress(p - first + 1, last - first + 1);
  }
  const out = [];
  for (const lines of stripRunning(pages)) {
    const paras = pageParagraphs(lines);
    const tail = out[out.length - 1];
    // Parágrafo que continua na página seguinte: o anterior acaba sem pontuação e não é um título curto.
    if (tail && paras.length && !TERMINAL.test(tail) && (/^\p{Ll}/u.test(paras[0]) || tail.length > 80)) {
      out[out.length - 1] = joinLines(out[out.length - 1], paras.shift());  // parágrafo que continua na página seguinte
    }
    out.push(...paras);
  }
  const text = out.join('\n\n');
  const letters = (text.match(/\p{L}/gu) || []).length;
  return { text, pages: last - first + 1, scanned: letters < 20 * (last - first + 1) };
}
