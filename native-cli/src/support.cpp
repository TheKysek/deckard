#include "support.hpp"
#include "model_assets.hpp"
#include <sys/resource.h>
#include <unistd.h>
#include <array>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <regex>
#include <sstream>
#include <set>

namespace aihider {
namespace {
std::string hex(const unsigned char* bytes, size_t count) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (size_t i = 0; i < count; ++i) out << std::setw(2) << static_cast<unsigned>(bytes[i]);
    return out.str();
}
std::vector<uint32_t> codepoints(const std::string& value) {
    std::vector<uint32_t> result;
    for (size_t i = 0; i < value.size();) {
        auto lead = static_cast<unsigned char>(value[i++]);
        uint32_t cp = lead;
        unsigned more = 0;
        uint32_t minimum = 0;
        if (lead < 0x80) {}
        else if (lead >= 0xc2 && lead <= 0xdf) { cp = lead & 0x1f; more = 1; minimum = 0x80; }
        else if (lead >= 0xe0 && lead <= 0xef) { cp = lead & 0x0f; more = 2; minimum = 0x800; }
        else if (lead >= 0xf0 && lead <= 0xf4) { cp = lead & 7; more = 3; minimum = 0x10000; }
        else throw Error("invalid_text", "Text is not valid UTF-8.");
        if (more > value.size() - i) throw Error("invalid_text", "Text is not valid UTF-8.");
        for (unsigned j = 0; j < more; ++j) {
            auto next = static_cast<unsigned char>(value[i++]);
            if ((next & 0xc0) != 0x80) throw Error("invalid_text", "Text is not valid UTF-8.");
            cp = (cp << 6) | (next & 0x3f);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
            throw Error("invalid_text", "Text is not valid UTF-8.");
        result.push_back(cp);
    }
    return result;
}
bool whitespace(uint32_t cp) {
    return (cp >= 9 && cp <= 13) || (cp >= 0x1c && cp <= 0x20) || cp == 0x85 ||
        cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
        cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000;
}
// FIPS 180-4 SHA-256; small enough to avoid a crypto library dependency.
class Sha256 {
public:
    void update(const unsigned char* data, size_t size) {
        length_ += static_cast<uint64_t>(size) * 8;
        while (size) {
            size_t take = std::min(size, block_.size() - used_);
            std::memcpy(block_.data() + used_, data, take);
            used_ += take; data += take; size -= take;
            if (used_ == block_.size()) { compress(); used_ = 0; }
        }
    }
    std::string finish() {
        const uint64_t bits = length_;
        const unsigned char pad = 0x80, zero = 0;
        update(&pad, 1);
        while (used_ != 56) update(&zero, 1);
        unsigned char tail[8];
        for (int i = 0; i < 8; ++i) tail[i] = static_cast<unsigned char>(bits >> (56 - 8 * i));
        update(tail, 8);
        unsigned char digest[32];
        for (int i = 0; i < 8; ++i)
            for (int j = 0; j < 4; ++j) digest[4 * i + j] = static_cast<unsigned char>(state_[i] >> (24 - 8 * j));
        return hex(digest, sizeof(digest));
    }
private:
    static uint32_t rotate(uint32_t value, int count) { return (value >> count) | (value << (32 - count)); }
    void compress() {
        static constexpr uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i)
            w[i] = uint32_t(block_[4 * i]) << 24 | uint32_t(block_[4 * i + 1]) << 16 |
                   uint32_t(block_[4 * i + 2]) << 8 | uint32_t(block_[4 * i + 3]);
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3],
                 e = state_[4], f = state_[5], g = state_[6], h = state_[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
            uint32_t t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
            h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        state_[0] += a; state_[1] += b; state_[2] += c; state_[3] += d;
        state_[4] += e; state_[5] += f; state_[6] += g; state_[7] += h;
    }
    std::array<uint32_t, 8> state_{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    std::array<unsigned char, 64> block_{};
    size_t used_ = 0;
    uint64_t length_ = 0;
};
}

fs::path executable_path() {
    std::error_code error;
    auto path = fs::canonical("/proc/self/exe", error);
    if (error) throw Error("runtime_path", "Cannot locate the executable.");
    return path;
}
fs::path user_home() {
    const char* home = std::getenv("HOME");
    if (!home || !*home || !fs::path(home).is_absolute()) throw Error("home_missing", "An absolute HOME is required.");
    return home;
}
fs::path default_home() {
    const char* override_path = std::getenv("DECKARD_HOME");
    if (override_path && *override_path) return fs::absolute(override_path);
    auto bundled = executable_path().parent_path().parent_path();
    if (fs::is_regular_file(bundled / "install.json")) return bundled;
    return user_home() / "Deckard/current";
}
std::string read_text(const fs::path& path, size_t limit) {
    if (!fs::is_regular_file(path) || fs::file_size(path) > limit)
        throw Error("invalid_file", "Required file is missing or exceeds its size limit.");
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw Error("file_read", "Cannot read a required file.");
    std::string data((std::istreambuf_iterator<char>(stream)), {});
    if (stream.bad() || data.size() > limit) throw Error("file_read", "Cannot read a required file.");
    return data;
}
Json read_json(const fs::path& path, size_t limit) {
    auto result = Json::parse(read_text(path, limit), nullptr, false);
    if (result.is_discarded()) throw Error("invalid_json", "Required JSON file is invalid.");
    return result;
}
void write_json(const fs::path& path, const Json& value) {
    auto temporary = path;
    temporary += ".writing-" + std::to_string(getpid()) + "-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    auto body = value.dump(2) + "\n";
    int descriptor = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (descriptor < 0) throw Error("file_write", "Cannot create installation metadata.");
    try {
        size_t offset = 0;
        while (offset < body.size()) {
            ssize_t count = write(descriptor, body.data() + offset, body.size() - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) throw Error("file_write", "Cannot write installation metadata.");
            offset += static_cast<size_t>(count);
        }
        if (fsync(descriptor)) throw Error("file_write", "Cannot flush installation metadata.");
        int closed = close(descriptor);
        descriptor = -1;
        if (closed) throw Error("file_write", "Cannot finish installation metadata.");
        fs::rename(temporary, path);
    } catch (...) {
        if (descriptor >= 0) close(descriptor);
        std::error_code error;
        fs::remove(temporary, error);
        if (error) std::cerr << "Deckard: metadata_cleanup_failed\n";
        throw;
    }
}
std::string sha256(const fs::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw Error("missing_assets", "Required asset is missing or unreadable.");
    Sha256 context;
    std::array<char, 65536> buffer{};
    while (stream) {
        stream.read(buffer.data(), buffer.size());
        context.update(reinterpret_cast<const unsigned char*>(buffer.data()), static_cast<size_t>(stream.gcount()));
    }
    if (!stream.eof()) throw Error("asset_read", "Failed while reading an asset.");
    return context.finish();
}
std::string text_sha256(const std::string& text) {
    Sha256 context;
    context.update(reinterpret_cast<const unsigned char*>(text.data()), text.size());
    return context.finish();
}
void require_hash(const fs::path& path, const std::string& expected) {
    if (expected.size() != 64 || sha256(path) != expected)
        throw Error("asset_mismatch", "An asset does not match its pinned SHA256.");
}
// Installation work yields to interactive processes; inference uses normal priority.
void background() {
    if (setpriority(PRIO_PROCESS, 0, 10) != 0)
        throw Error("scheduling_failed", "Cannot enable background scheduling.");
}
void default_priority() {
    errno = 0;
    const int current = getpriority(PRIO_PROCESS, 0);
    // An unprivileged process cannot lower its niceness; keep an inherited nicer value.
    if (errno == 0 && current < 0 && setpriority(PRIO_PROCESS, 0, 0) != 0)
        throw Error("scheduling_failed", "Cannot enable default-priority inference.");
}
const Json& model_assets() {
    static const auto assets = Json::parse(model_assets_json);
    return assets;
}
std::string model_assets_id() { return model_assets_sha256; }
void verify_model_assets(const fs::path& directory, bool verify_hashes) {
    std::error_code error;
    const auto root = fs::canonical(directory, error);
    if (error) throw Error("missing_assets", "Model assets are missing. Install the Deckard release bundle.");
    const auto& files = model_assets().at("files");
    for (auto it = files.begin(); it != files.end(); ++it) {
        const auto status = fs::symlink_status(root / it.key());
        if (status.type() == fs::file_type::not_found)
            throw Error("missing_assets", "Model assets are missing. Install the Deckard release bundle.");
        if (!fs::is_regular_file(status))
            throw Error("asset_mismatch", "Model assets must be ordinary files, not links.");
        if (verify_hashes) require_hash(root / it.key(), it.value().get<std::string>());
    }
    // ONNX Runtime resolves external data beside the model: never allow unpinned neighbours.
    for (const auto& entry : fs::directory_iterator(root))
        if (!files.contains(entry.path().filename().string()))
            throw Error("asset_mismatch", "The model directory contains unexpected assets.");
}
// Firefox add-on IDs: email-like ("name@domain") or a braced GUID.
bool extension_id_valid(const std::string& id) {
    static const std::regex email(R"(^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*$)");
    static const std::regex guid(R"(^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$)");
    return id.size() <= 80 && (std::regex_match(id, email) || std::regex_match(id, guid));
}
size_t characters(const std::string& text) { return codepoints(text).size(); }
size_t words(const std::string& text) {
    size_t count = 0;
    bool previous_space = true;
    for (auto cp : codepoints(text)) {
        bool space = whitespace(cp);
        if (!space && previous_space) ++count;
        previous_space = space;
    }
    return count;
}
double sigmoid(double value) {
    if (!std::isfinite(value)) throw Error("invalid_output", "The model returned a non-finite logit.");
    return value >= 0 ? 1 / (1 + std::exp(-value)) : std::exp(value) / (1 + std::exp(value));
}
std::vector<size_t> word_boundaries(const std::string& text) {
    std::vector<size_t> result;
    size_t offset = 0;
    bool previous_space = true;
    for (auto cp : codepoints(text)) {
        bool space = whitespace(cp) || cp == 0xfeff;
        if (!space && previous_space) result.push_back(offset);
        previous_space = space;
        offset += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    if (!result.empty()) result[0] = 0;
    result.push_back(text.size());
    return result;
}
Json identity() {
    return {{"protocol_version", protocol_version}, {"model", model_id}, {"revision", revision},
            {"policy", policy_id}, {"flag_threshold", flag_threshold}, {"experimental", true},
            {"min_words", min_words}};
}
Json installed_config(const fs::path& home, bool verify) {
    auto config = read_json(home / "install.json");
    if (!config.is_object() || config.value("format", Json()) != 1 ||
        config.value("product", Json()) != "Deckard" || config.value("version", Json()) != app_version ||
        config.value("model", Json()) != model_id || config.value("revision", Json()) != revision ||
        config.value("policy", Json()) != policy_id || config.value("flag_threshold", Json()) != flag_threshold ||
        config.value("experimental", Json()) != true ||
        config.value("runtime", Json()) != runtime_id ||
        config.value("source", Json()) != "verified-onnx-export" ||
        config.value("weights_sha256", Json()) != packed_sha ||
        config.value("tokenizer_sha256", Json()) != tokenizer_sha ||
        config.value("model_assets_sha256", Json()) != model_assets_id() ||
        config.value("model_files", Json()) != model_assets().at("files") ||
        !config.value("onnxruntime_sha256", Json()).is_string())
        throw Error("invalid_installation", "Installation metadata is incompatible. Install the Deckard release bundle.");
    const auto models = fs::canonical(home) / "models";
    if (!fs::is_directory(fs::symlink_status(models)))
        throw Error("missing_assets", "Model assets are missing or redirected. Run deckard install.");
    verify_model_assets(models, verify);
    if (verify) require_hash(fs::canonical(home) / onnxruntime_library, config["onnxruntime_sha256"].get<std::string>());
    return config;
}
}
