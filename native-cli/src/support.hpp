#pragma once
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace aihider {
namespace fs = std::filesystem;
using Json = nlohmann::json;
inline constexpr const char* model_id = "ShantanuT01/gradient-ai-text-detector";
inline constexpr const char* revision = "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f";
inline constexpr const char* host_name = "com.sgoedecke.deckard";
inline constexpr const char* app_version = "0.7.0";
inline constexpr const char* runtime_id = "native-onnx";
inline constexpr const char* default_extension_id = "deckard@thekysek.github.io";
// Release-relative ONNX Runtime, stored under its SONAME (never as a symlink).
inline constexpr const char* onnxruntime_library = "lib/libonnxruntime.so.1";
inline constexpr const char* policy_id = "gradient-q4-two-scale-v1";
inline constexpr double flag_threshold = 0.97;
inline constexpr int protocol_version = 3;
inline constexpr size_t min_words = 50;
inline constexpr const char* packed_sha = "85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98";
inline constexpr const char* tokenizer_sha = "4b4f60231058db4b5794e7b124bb7945bc8ade6719282de4d2e0372ee527b929";

struct Error : std::runtime_error {
    std::string code;
    Error(std::string code, const std::string& message) : std::runtime_error(message), code(std::move(code)) {}
};
fs::path executable_path();
fs::path user_home();
fs::path default_home();
std::string read_text(const fs::path& path, size_t limit = 1024 * 1024);
Json read_json(const fs::path& path, size_t limit = 1024 * 1024);
void write_json(const fs::path& path, const Json& value);
std::string sha256(const fs::path& path);
std::string text_sha256(const std::string& text);
void require_hash(const fs::path& path, const std::string& expected);
void background();
void default_priority();
const Json& model_assets();
std::string model_assets_id();
void verify_model_assets(const fs::path& directory, bool verify_hashes = true);
bool extension_id_valid(const std::string& id);
size_t characters(const std::string& text);
size_t words(const std::string& text);
std::vector<size_t> word_boundaries(const std::string& text);
double sigmoid(double logit);
Json identity();
Json installed_config(const fs::path& home, bool verify);
}
