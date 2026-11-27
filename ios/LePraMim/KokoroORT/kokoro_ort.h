// Camada fina sobre a API em C do ONNX Runtime, só com o que o Kokoro precisa.
// Compila igual no iPhone (onnxruntime.xcframework) e no Linux (libonnxruntime.so), o que permite
// testar este código fora do Xcode.
#ifndef KOKORO_ORT_H
#define KOKORO_ORT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Carrega o modelo. Devolve NULL em caso de erro e, se `error` não for NULL, uma mensagem
/// que deve ser liberada com kort_free.
void *kort_create(const char *model_path, int threads, char **error);

/// Roda o modelo: input_ids [1, n_ids] (int64), style [1, style_len] (float), speed [1] (float).
/// Em caso de sucesso devolve 0 e o áudio (float, 24 kHz) em *samples, que deve ser liberado com kort_free.
int kort_run(void *session, const int64_t *ids, size_t n_ids, const float *style, size_t style_len,
             float speed, float **samples, size_t *n_samples, char **error);

void kort_free(void *pointer);
void kort_destroy(void *session);

#ifdef __cplusplus
}
#endif

#endif
