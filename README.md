# Lê pra Mim

Leitor de textos em voz alta, em português do Brasil, com uma **voz neural que roda no próprio celular**. É grátis, não tem limite de uso e, depois do primeiro download, funciona até sem internet.

## Como usar no iPhone

1. Abra o endereço do app no **Safari**.
2. Toque em **Compartilhar › Adicionar à Tela de Início**. Assim o app abre em tela cheia e o iPhone não apaga a voz baixada.
3. Cole um texto e toque em **Ouvir**. Na primeira vez ele baixa a voz neural (92 MB). Prefira o Wi-Fi.

Para ouvir com a tela bloqueada ou guardar o áudio, use **Gerar áudio do texto todo**: o app gera tudo, vira um arquivo WAV, e aí dá para ouvir em segundo plano ou salvar em Arquivos.

## O que tem

- Vozes neurais **Dora** (feminina), **Alex** e **Santa** (masculinas), do modelo Kokoro.
- Leitura frase por frase, com a frase atual marcada. Tocar numa frase começa dali.
- Adaptação do texto para a fala: `Sr.` vira senhor, `R$ 12,50` vira 12 reais e 50 centavos, `14h30` vira 14 horas e 30, e `vc` vira você.
- Exportação do texto inteiro em um arquivo de áudio.
- Abre **PDF** e **.txt**. O texto do PDF é extraído no próprio aparelho, já na ordem de leitura:
  - junta as linhas em parágrafos e desfaz a hifenização do fim de linha;
  - tira cabeçalhos, rodapés e números de página;
  - em PDFs longos, você escolhe o intervalo de páginas.

  PDFs digitalizados (só imagem) não têm texto para ler.
- Também usa as vozes do sistema, se você preferir.

## Como funciona

A voz neural roda toda no navegador:

- **Texto → fonemas:** [eSpeak NG](https://github.com/espeak-ng/espeak-ng) compilado para WebAssembly, só com os dados do português. O resultado reproduz o pré-processamento oficial do Kokoro e foi conferido caractere a caractere contra a versão em Python, em 113 frases de teste.
- **Fonemas → áudio:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) em ONNX, versão quantizada (`model_quantized.onnx`) ou completa, rodando com [ONNX Runtime Web](https://github.com/microsoft/onnxruntime).
- **Cache:** o modelo é baixado do Hugging Face numa revisão fixa e guardado no aparelho (Cache Storage).
- **PDF:** [PDF.js](https://github.com/mozilla/pdf.js) extrai o texto (`pdf-texto.js`), sem enviar o arquivo para lugar nenhum.
- **Service worker** (`sw.js`): faz o app abrir sem internet e ativa o isolamento de origem, o que permite usar vários núcleos do processador.

## Rodar localmente

Qualquer servidor de arquivos estáticos serve, por exemplo:

```bash
python3 -m http.server 8000
```

Depois abra `http://localhost:8000`.

## Componentes de terceiros

| Componente | Licença | Onde |
| --- | --- | --- |
| Kokoro-82M (modelo e vozes) | Apache-2.0 | baixado de `onnx-community/Kokoro-82M-v1.0-ONNX` |
| ONNX Runtime Web 1.22.0 | MIT | `vendor/ort/` |
| PDF.js 5.4.296 (build legacy) | Apache-2.0 | `vendor/pdfjs/` |
| eSpeak NG (build Emscripten do projeto Echogarden, só dados do português) | GPL-3.0 | `espeak-pt/`. O código-fonte está em [echogarden-project/espeak-ng](https://github.com/echogarden-project/espeak-ng) |
