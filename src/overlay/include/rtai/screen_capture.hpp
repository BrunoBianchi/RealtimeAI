// Screen capture for the "Tela" action: grabs the monitor under a window
// (GDI BitBlt, UI thread, a few ms) and encodes it as a JPEG data URL with
// WIC (worker thread). Downscaled so the long side is <= max_side px.
#pragma once

#include <windows.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace rtai {

struct CapturedScreen {
    int width{0}, height{0};
    std::vector<std::uint8_t> bgra; // top-down, 4 bytes per pixel
};

// UI thread: copies the monitor that contains `anchor` (already scaled).
std::optional<CapturedScreen> capture_monitor(HWND anchor, int max_side = 1600, std::string* error = nullptr);

// Any thread (initializes COM for itself): "data:image/jpeg;base64,...".
std::optional<std::string> encode_jpeg_data_url(const CapturedScreen& img, float quality = 0.82f,
                                                std::string* error = nullptr);

} // namespace rtai
