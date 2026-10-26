// Pure core: minimal http(s) URL parser for configuring endpoints
// (RTAI_LLM_URL). Supports scheme://host[:port][/path]; IPv6 literals are not
// needed here and not supported.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace rtai {

struct ParsedUrl {
    bool ok{false};
    bool secure{true};
    std::string host;
    std::uint16_t port{443};
    std::string path{"/"};
};

inline ParsedUrl parse_url(std::string_view url) {
    ParsedUrl u;
    std::string_view rest;
    if (url.substr(0, 8) == "https://") {
        u.secure = true;
        u.port = 443;
        rest = url.substr(8);
    } else if (url.substr(0, 7) == "http://") {
        u.secure = false;
        u.port = 80;
        rest = url.substr(7);
    } else {
        return u;
    }
    const auto slash = rest.find('/');
    std::string_view authority = rest.substr(0, slash);
    if (slash != std::string_view::npos) u.path = std::string(rest.substr(slash));
    const auto colon = authority.rfind(':');
    if (colon != std::string_view::npos) {
        const std::string_view port = authority.substr(colon + 1);
        if (port.empty() || port.size() > 5) return u;
        unsigned value = 0;
        for (char c : port) {
            if (c < '0' || c > '9') return u;
            value = value * 10 + static_cast<unsigned>(c - '0');
        }
        if (value == 0 || value > 65535) return u;
        u.port = static_cast<std::uint16_t>(value);
        authority = authority.substr(0, colon);
    }
    if (authority.empty()) return u;
    u.host = std::string(authority);
    u.ok = true;
    return u;
}

} // namespace rtai
