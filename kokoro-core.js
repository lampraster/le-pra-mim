// Núcleo do Kokoro: fonemas -> ids -> modelo ONNX -> áudio (24 kHz, mono, float32).
// Segue kokoro.KPipeline.infer / KModel.forward do pacote Python oficial.

export const SAMPLE_RATE = 24000;
export const STYLE_DIM = 256;
export const MAX_PHONEMES = 510;

export function makeTokenizer(vocab) {
  return function tokenize(ps) {
    const ids = [0];
    for (const ch of ps) {
      const id = vocab[ch];
      if (id !== undefined) ids.push(id);   // símbolos fora do vocabulário são ignorados, como no Python
    }
    ids.push(0);
    return ids;
  };
}

// voice: Float32Array [510 * 256]; o Python usa pack[len(ps) - 1], contando caracteres dos fonemas.
export function styleFor(voice, ps) {
  const n = Math.min(Math.max([...ps].length - 1, 0), MAX_PHONEMES - 1);
  return voice.subarray(n * STYLE_DIM, (n + 1) * STYLE_DIM);
}

export async function synthesize(ort, session, tokenize, voice, ps, speed = 1) {
  let phonemes = ps;
  if ([...phonemes].length > MAX_PHONEMES) phonemes = [...phonemes].slice(0, MAX_PHONEMES).join('');
  const ids = tokenize(phonemes);
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', Float32Array.from(styleFor(voice, phonemes)), [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', Float32Array.from([speed]), [1]),
  };
  const out = await session.run(feeds);
  const first = out[session.outputNames[0]];
  return first.data;   // Float32Array
}
