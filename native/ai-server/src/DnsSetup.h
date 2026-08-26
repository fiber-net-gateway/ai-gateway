#ifndef FIBER_AI_SERVER_DNS_SETUP_H
#define FIBER_AI_SERVER_DNS_SETUP_H

#include <fstream>
#include <string>
#include <string_view>

#include <fiber/net/IpAddress.h>
#include <fiber/net/SocketAddress.h>

namespace fiber::ai_server {

// Reads the first usable nameserver from /etc/resolv.conf. Falls back to 8.8.8.8
// when the file is missing or contains no parseable nameserver. Called once at
// startup (never from an event loop thread).
inline net::SocketAddress read_system_nameserver() noexcept {
    std::ifstream file("/etc/resolv.conf");
    std::string line;
    while (std::getline(file, line)) {
        std::size_t pos = 0;
        while (pos < line.size() && (line[pos] == ' ' || line[pos] == '\t')) {
            ++pos;
        }
        if (pos >= line.size() || line[pos] == '#') {
            continue;
        }
        constexpr std::string_view kNameserver = "nameserver";
        if (line.size() - pos < kNameserver.size() || line.compare(pos, kNameserver.size(), kNameserver) != 0) {
            continue;
        }
        pos += kNameserver.size();
        while (pos < line.size() && (line[pos] == ' ' || line[pos] == '\t')) {
            ++pos;
        }
        const std::size_t start = pos;
        while (pos < line.size() && line[pos] != ' ' && line[pos] != '\t' && line[pos] != '#') {
            ++pos;
        }
        net::IpAddress ip;
        if (pos > start && net::IpAddress::parse(std::string_view(line).substr(start, pos - start), ip)) {
            return net::SocketAddress(ip, 53);
        }
    }
    return net::SocketAddress(net::IpAddress::v4({8, 8, 8, 8}), 53);
}

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_DNS_SETUP_H
