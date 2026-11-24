"""Gera tests/fonemas-referencia.json com o pacote Python oficial do Kokoro.
Uso: pip install "kokoro>=0.9.4" && python tests/gerar-referencia.py frases.txt
"""
import json, sys, pathlib
from misaki import espeak

g2p = espeak.EspeakG2P(language='pt-br')
lines = [l.strip() for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
out = [{'text': t, 'ps': g2p(t)[0]} for t in lines]
dest = pathlib.Path(__file__).with_name('fonemas-referencia.json')
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
print(len(out), 'frases ->', dest)
