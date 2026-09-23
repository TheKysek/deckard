#include <unistd.h>
#include <charconv>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>

// Linux /proc counterpart of the historical macOS physical-footprint probe:
// resident set (VmRSS), its high-water mark (VmHWM), and CPU time.
int main(int argc, char** argv) {
    int pid = 0;
    if (argc != 2) return 2;
    std::string_view argument(argv[1]);
    auto parsed = std::from_chars(argument.data(), argument.data() + argument.size(), pid);
    if (parsed.ec != std::errc() || parsed.ptr != argument.data() + argument.size() || pid <= 0) return 2;
    const std::string base = "/proc/" + std::to_string(pid);
    std::ifstream status(base + "/status"), stat(base + "/stat");
    unsigned long long rss_kib = 0, peak_kib = 0;
    for (std::string line; std::getline(status, line);) {
        std::istringstream fields(line);
        std::string key;
        fields >> key;
        if (key == "VmRSS:") fields >> rss_kib;
        else if (key == "VmHWM:") fields >> peak_kib;
    }
    std::string contents((std::istreambuf_iterator<char>(stat)), {});
    const auto close = contents.rfind(')');
    if (!rss_kib || close == std::string::npos) {
        std::cerr << "Cannot read native process memory.\n";
        return 1;
    }
    std::istringstream rest(contents.substr(close + 2));
    std::string skip;
    for (int field = 3; field < 14; ++field) rest >> skip;  // state .. cmajflt
    unsigned long long user_ticks = 0, system_ticks = 0;
    rest >> user_ticks >> system_ticks;
    const double tick_ns = 1e9 / static_cast<double>(sysconf(_SC_CLK_TCK));
    std::cout << "{\"physical_footprint_bytes\":" << rss_kib * 1024
              << ",\"peak_physical_footprint_bytes\":" << peak_kib * 1024
              << ",\"user_time_ns\":" << static_cast<unsigned long long>(user_ticks * tick_ns)
              << ",\"system_time_ns\":" << static_cast<unsigned long long>(system_ticks * tick_ns) << "}\n";
}
