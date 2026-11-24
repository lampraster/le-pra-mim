// Worker da voz neural (Kokoro). Roda fora da tela principal para não travar a página.
// Mensagens recebidas:
//   {type:'init', quality:'q8'|'fp32', cachedOnly?}
//   {type:'generate', id, text, voice}          text = frase já adaptada para a fala
// Mensagens enviadas:
//   {type:'progress', stage, loaded, total}     download do modelo
//   {type:'ready', device, quality, cached}
//   {type:'audio', id, samples:Float32Array, phonemes, ms}
//   {type:'error', id?, message}

import { createG2P } from './g2p-ptbr.js';
import { makeTokenizer, synthesize, MAX_PHONEMES } from './kokoro-core.js';

// onnxruntime-web 1.22.0 servido junto com o app (vendor/ort); modelo e vozes vêm do Hugging Face,
// numa revisão fixa, e ficam guardados no aparelho depois do primeiro download.
const ORT_BASE = new URL('./vendor/ort/', import.meta.url).href;
let MODEL_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/';
const MODEL_FILES = { q8: 'onnx/model_quantized.onnx', fp32: 'onnx/model.onnx' };
const CACHE_NAME = 'le-pra-mim-voz-neural-v1';

let ort = null;
let session = null;
let tokenize = null;
let g2p = null;
let state = { device: '', quality: '' };
let cachedOnly = false;   // ao abrir o app: só carrega se o modelo já estiver guardado
const voices = new Map();

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch (e) { return null; }
}

// Baixa uma vez e guarda no aparelho (Cache Storage). Informa o progresso.
async function fetchCached(url, stage) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      post({ type: 'progress', stage, loaded: buf.byteLength, total: buf.byteLength, cached: true });
      return buf;
    }
  }
  if (cachedOnly) throw new Error('NOT_CACHED');
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Download falhou (${res.status}) em ${stage}.`);
  const total = Number(res.headers.get('content-length')) || 0;
  // Junta os pedaços num Blob (o navegador pode mantê-lo fora da memória do JavaScript),
  // guarda esse Blob e só então cria o ArrayBuffer: evita ter três cópias do modelo ao mesmo tempo,
  // o que importa num iPhone com 4 GB de RAM.
  let blob;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    let parts = [];
    let loaded = 0;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      const now = Date.now();
      if (now - last > 150) { last = now; post({ type: 'progress', stage, loaded, total }); }
    }
    blob = new Blob(parts, { type: 'application/octet-stream' });
    parts = null;
  } else {
    blob = await res.blob();
  }
  post({ type: 'progress', stage, loaded: blob.size, total: blob.size });
  if (cache) {
    try { await cache.put(url, new Response(blob, { headers: { 'content-type': 'application/octet-stream' } })); }
    catch (e) { /* sem espaço ou modo privado: segue sem guardar */ }
  }
  return blob.arrayBuffer();
}

async function loadVoice(name) {
  if (voices.has(name)) return voices.get(name);
  const buf = await fetchCached(MODEL_BASE + `voices/${name}.bin`, 'voz');
  const arr = new Float32Array(buf);
  voices.set(name, arr);
  return arr;
}

async function init({ quality = 'q8', modelBase, cachedOnly: onlyCached = false, g2pOnly = false }) {
  if (modelBase) MODEL_BASE = modelBase;
  cachedOnly = onlyCached;
  // Fonemas: espeak-ng (só os dados do português) + regras do Kokoro.
  if (!g2p) {
    const { default: ESpeak } = await import('./espeak-pt/espeak-ng.js');
    g2p = createG2P(await ESpeak());
  }
  if (!tokenize) {
    const tk = JSON.parse(new TextDecoder().decode(await fetchCached(MODEL_BASE + 'tokenizer.json', 'vocabulário')));
    tokenize = makeTokenizer(tk.model.vocab);
  }
  // No app de iPhone o modelo roda em código nativo: aqui fica só texto -> fonemas -> tokens.
  if (g2pOnly) {
    cachedOnly = false;
    post({ type: 'ready', device: 'native', quality });
    return;
  }
  // Só processador (WebAssembly): no caminho WebGPU o modelo leve gera ruído e o completo não pôde ser
  // conferido, então a GPU fica de fora. Com isolamento de origem, usa vários núcleos.
  if (!ort) {
    ort = await import(ORT_BASE + 'ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  }
  const model = await fetchCached(MODEL_BASE + MODEL_FILES[quality], 'modelo');
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  state = { device: 'wasm', quality };
  await loadVoice('pf_dora');
  cachedOnly = false;
  post({ type: 'ready', ...state, threads: ort.env.wasm.numThreads });
}

async function generate({ id, text, voice }) {
  const ps = g2p(text);
  if (!ps) { post({ type: 'audio', id, samples: new Float32Array(0), phonemes: '', ms: 0 }); return; }
  const v = await loadVoice(voice);
  const t0 = performance.now();
  const audio = await synthesize(ort, session, tokenize, v, ps, 1);
  const samples = new Float32Array(audio);           // cópia própria para transferir
  post({ type: 'audio', id, samples, phonemes: ps, ms: performance.now() - t0 }, [samples.buffer]);
}

// Uma geração por vez, na ordem em que chegam.
let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data || {};
  queue = queue.then(async () => {
    try {
      if (msg.type === 'init') await init(msg);
      else if (msg.type === 'generate') await generate(msg);
      else if (msg.type === 'phonemize') post({ type: 'phonemes', id: msg.id, phonemes: g2p ? g2p(msg.text) : '' });
      else if (msg.type === 'prep') {
        // Para o motor nativo: os mesmos tokens e o mesmo tamanho de fonemas que synthesize() usaria.
        let ps = g2p(msg.text);
        if ([...ps].length > MAX_PHONEMES) ps = [...ps].slice(0, MAX_PHONEMES).join('');
        post({ type: 'prep', id: msg.id, ids: ps ? tokenize(ps) : [], count: [...ps].length, phonemes: ps });
      }
    } catch (err) {
      post({ type: 'error', id: msg.id, message: String(err && err.message || err) });
    }
  });
};
