#include "kokoro_ort.h"

#include <stdlib.h>
#include <string.h>

#if __has_include(<onnxruntime/onnxruntime_c_api.h>)
#include <onnxruntime/onnxruntime_c_api.h>
#else
#include "onnxruntime_c_api.h"
#endif

typedef struct {
    OrtEnv *env;
    OrtSession *session;
    OrtMemoryInfo *memory;
} KortSession;

static const OrtApi *api(void) {
    static const OrtApi *cached = NULL;
    if (!cached) cached = OrtGetApiBase()->GetApi(ORT_API_VERSION);
    return cached;
}

static char *copy_string(const char *text) {
    size_t n = strlen(text ? text : "");
    char *out = malloc(n + 1);
    if (out) memcpy(out, text ? text : "", n + 1);
    return out;
}

// Guarda a mensagem de erro (se pedida) e libera o status.
static int failed(OrtStatus *status, char **error) {
    if (!status) return 0;
    if (error && !*error) *error = copy_string(api()->GetErrorMessage(status));
    api()->ReleaseStatus(status);
    return 1;
}

void kort_free(void *pointer) { free(pointer); }

void kort_destroy(void *handle) {
    KortSession *s = handle;
    if (!s) return;
    if (s->memory) api()->ReleaseMemoryInfo(s->memory);
    if (s->session) api()->ReleaseSession(s->session);
    if (s->env) api()->ReleaseEnv(s->env);
    free(s);
}

void *kort_create(const char *model_path, int threads, char **error) {
    if (error) *error = NULL;
    const OrtApi *ort = api();
    if (!ort) {
        if (error) *error = copy_string("ONNX Runtime incompatível com este app.");
        return NULL;
    }
    KortSession *s = calloc(1, sizeof *s);
    OrtSessionOptions *options = NULL;
    if (!s) return NULL;
    if (failed(ort->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "lepramim", &s->env), error)) goto fail;
    if (failed(ort->CreateSessionOptions(&options), error)) goto fail;
    if (failed(ort->SetIntraOpNumThreads(options, threads > 0 ? threads : 1), error)) goto fail;
    if (failed(ort->SetSessionGraphOptimizationLevel(options, ORT_ENABLE_ALL), error)) goto fail;
    if (failed(ort->CreateSession(s->env, model_path, options, &s->session), error)) goto fail;
    if (failed(ort->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &s->memory), error)) goto fail;
    ort->ReleaseSessionOptions(options);
    return s;
fail:
    if (options) ort->ReleaseSessionOptions(options);
    kort_destroy(s);
    return NULL;
}

int kort_run(void *handle, const int64_t *ids, size_t n_ids, const float *style, size_t style_len,
             float speed, float **samples, size_t *n_samples, char **error) {
    if (error) *error = NULL;
    *samples = NULL;
    *n_samples = 0;
    KortSession *s = handle;
    const OrtApi *ort = api();
    if (!s || !s->session) {
        if (error) *error = copy_string("O modelo não está carregado.");
        return -1;
    }
    OrtValue *in_ids = NULL, *in_style = NULL, *in_speed = NULL, *output = NULL;
    OrtTensorTypeAndShapeInfo *shape_info = NULL;
    int64_t ids_shape[2] = {1, (int64_t)n_ids};
    int64_t style_shape[2] = {1, (int64_t)style_len};
    int64_t speed_shape[1] = {1};
    float speed_value = speed;
    int result = -1;

    if (failed(ort->CreateTensorWithDataAsOrtValue(s->memory, (void *)ids, n_ids * sizeof(int64_t), ids_shape, 2,
                                                   ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &in_ids), error)) goto done;
    if (failed(ort->CreateTensorWithDataAsOrtValue(s->memory, (void *)style, style_len * sizeof(float), style_shape, 2,
                                                   ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &in_style), error)) goto done;
    if (failed(ort->CreateTensorWithDataAsOrtValue(s->memory, &speed_value, sizeof(float), speed_shape, 1,
                                                   ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &in_speed), error)) goto done;

    const char *input_names[] = {"input_ids", "style", "speed"};
    const char *output_names[] = {"waveform"};
    const OrtValue *inputs[] = {in_ids, in_style, in_speed};
    if (failed(ort->Run(s->session, NULL, input_names, inputs, 3, output_names, 1, &output), error)) goto done;

    float *data = NULL;
    size_t count = 0;
    if (failed(ort->GetTensorMutableData(output, (void **)&data), error)) goto done;
    if (failed(ort->GetTensorTypeAndShape(output, &shape_info), error)) goto done;
    if (failed(ort->GetTensorShapeElementCount(shape_info, &count), error)) goto done;

    *samples = malloc(count * sizeof(float) + 1);
    if (!*samples) {
        if (error) *error = copy_string("Sem memória para o áudio.");
        goto done;
    }
    if (count) memcpy(*samples, data, count * sizeof(float));
    *n_samples = count;
    result = 0;

done:
    if (shape_info) ort->ReleaseTensorTypeAndShapeInfo(shape_info);
    if (output) ort->ReleaseValue(output);
    if (in_speed) ort->ReleaseValue(in_speed);
    if (in_style) ort->ReleaseValue(in_style);
    if (in_ids) ort->ReleaseValue(in_ids);
    return result;
}
