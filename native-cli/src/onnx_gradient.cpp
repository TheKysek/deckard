#include "onnx_gradient.hpp"
#include "support.hpp"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <mutex>
#include <thread>

namespace aihider {
namespace {
constexpr size_t maximum_length = 512;
constexpr uint32_t vocabulary = 128100;

// Leave half of the machine to the browser; inference is interactive but secondary.
int inference_threads() {
    const unsigned cores = std::max(1u, std::thread::hardware_concurrency());
    return static_cast<int>(std::max(1u, cores / 2));
}
}

struct OnnxGradient::Impl {
    Ort::Env env{ORT_LOGGING_LEVEL_ERROR, "deckard"};
    std::unique_ptr<Ort::Session> session;
    Ort::MemoryInfo memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::mutex mutex;
};

OnnxGradient::OnnxGradient(const fs::path& model_directory) : impl_(std::make_unique<Impl>()) {
    // Hashes are verified before loading; ORT resolves model.onnx.data beside model.onnx.
    verify_model_assets(model_directory);
    const auto model = fs::canonical(model_directory) / model_assets().at("model_file").get<std::string>();
    try {
        Ort::SessionOptions options;
        options.SetIntraOpNumThreads(inference_threads());
        options.SetInterOpNumThreads(1);
        options.SetExecutionMode(ORT_SEQUENTIAL);
        options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        options.DisableProfiling();
        // Idle worker threads must not spin between page requests.
        options.AddConfigEntry("session.intra_op.allow_spinning", "0");
        impl_->session = std::make_unique<Ort::Session>(impl_->env, model.c_str(), options);
    } catch (const Ort::Exception& error) {
        throw Error("onnx_failed", std::string("Cannot load the ONNX model: ") + error.what());
    }
    if (impl_->session->GetInputCount() != 2 || impl_->session->GetOutputCount() != 1)
        throw Error("onnx_failed", "The ONNX model has an unexpected signature.");
}

OnnxGradient::~OnnxGradient() = default;

double OnnxGradient::logit(const std::vector<uint32_t>& ids, const std::vector<uint32_t>& mask) {
    if (ids.empty() || ids.size() > maximum_length || mask.size() != ids.size())
        throw Error("invalid_input", "Gradient requires matching token/mask lengths in 1..512.");
    if (std::any_of(ids.begin(), ids.end(), [](auto id) { return id >= vocabulary; }) ||
        std::any_of(mask.begin(), mask.end(), [](auto value) { return value > 1; }))
        throw Error("invalid_input", "Gradient token IDs must be in vocabulary and masks binary.");
    std::vector<int64_t> input_ids(ids.begin(), ids.end()), attention_mask(mask.begin(), mask.end());
    const std::array<int64_t, 2> shape{1, static_cast<int64_t>(ids.size())};
    std::array<Ort::Value, 2> inputs{
        Ort::Value::CreateTensor<int64_t>(impl_->memory, input_ids.data(), input_ids.size(), shape.data(), shape.size()),
        Ort::Value::CreateTensor<int64_t>(impl_->memory, attention_mask.data(), attention_mask.size(),
                                          shape.data(), shape.size())};
    static constexpr std::array<const char*, 2> input_names{"input_ids", "attention_mask"};
    static constexpr std::array<const char*, 1> output_names{"logits"};
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::vector<Ort::Value> outputs;
    try {
        outputs = impl_->session->Run(Ort::RunOptions{nullptr}, input_names.data(), inputs.data(), inputs.size(),
                                      output_names.data(), output_names.size());
    } catch (const Ort::Exception& error) {
        throw Error("onnx_failed", std::string("ONNX inference failed: ") + error.what());
    }
    if (outputs.size() != 1 || !outputs[0].IsTensor() ||
        outputs[0].GetTensorTypeAndShapeInfo().GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT ||
        outputs[0].GetTensorTypeAndShapeInfo().GetShape() != std::vector<int64_t>{1, 1})
        throw Error("onnx_failed", "The ONNX model produced an invalid output.");
    const double value = outputs[0].GetTensorData<float>()[0];
    if (!std::isfinite(value)) throw Error("invalid_output", "The model returned a non-finite logit.");
    return value;
}

}  // namespace aihider
