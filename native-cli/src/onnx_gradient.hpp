#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <vector>

namespace aihider {

// The pinned Gradient q4 ONNX export, batch one, ONNX Runtime CPU only.
// Inputs include special tokens and are scored unpadded (1..512 positions).
class OnnxGradient {
 public:
  explicit OnnxGradient(const std::filesystem::path& model_directory);
  ~OnnxGradient();
  OnnxGradient(const OnnxGradient&) = delete;
  OnnxGradient& operator=(const OnnxGradient&) = delete;

  double logit(const std::vector<std::uint32_t>& ids,
               const std::vector<std::uint32_t>& mask);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace aihider
