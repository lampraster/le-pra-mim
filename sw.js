// Service worker do Lê pra Mim.
// 1. Acrescenta os cabeçalhos COOP/COEP às respostas do próprio site: com eles o navegador libera
//    SharedArrayBuffer e a voz neural pode usar vários núcleos do processador.
// 2. Guarda os arquivos do app para abrir sem internet (o modelo de voz fica no cache do worker).
// Para o conteúdo do site, busca primeiro na rede (atualizações chegam logo) e usa o cache offline.

const APP_CACHE = 'le-pra-mim-app-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('le-pra-mim-app-') && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // modelo, fontes etc. seguem direto
  event.respondWith((async () => {
    let res;
    try {
      res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(APP_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
    } catch (err) {
      res = await caches.match(req, { ignoreSearch: true });
      if (!res && req.mode === 'navigate') res = await caches.match('./', { ignoreSearch: true });
      if (!res) throw err;
    }
    return isolate(res);
  })());
});
