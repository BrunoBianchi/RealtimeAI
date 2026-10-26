#include "rtai/screen_capture.hpp"

#include <objbase.h>
#include <wincodec.h>

#include <algorithm>
#include <cmath>
#include <string_view>

#include "rtai/settings.hpp" // base64_encode

#ifdef _MSC_VER
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#endif

namespace rtai {

std::optional<CapturedScreen> capture_monitor(HWND anchor, int max_side, std::string* error) {
    auto fail = [&](const char* why) -> std::optional<CapturedScreen> {
        if (error) *error = why;
        return std::nullopt;
    };
    HMONITOR mon = MonitorFromWindow(anchor, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfoW(mon, &mi)) return fail("monitor not found");
    const int sw = mi.rcMonitor.right - mi.rcMonitor.left;
    const int sh = mi.rcMonitor.bottom - mi.rcMonitor.top;
    if (sw <= 0 || sh <= 0) return fail("monitor has no area");
    const double k = std::min(1.0, static_cast<double>(max_side) / std::max(sw, sh));
    const int dw = std::max(1, static_cast<int>(std::lround(sw * k)));
    const int dh = std::max(1, static_cast<int>(std::lround(sh * k)));

    HDC screen = GetDC(nullptr);
    if (!screen) return fail("GetDC failed");
    HDC mem = CreateCompatibleDC(screen);
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = dw;
    bmi.bmiHeader.biHeight = -dh; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP dib = CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    std::optional<CapturedScreen> out;
    if (mem && dib && bits) {
        HGDIOBJ old = SelectObject(mem, dib);
        SetStretchBltMode(mem, HALFTONE);
        SetBrushOrgEx(mem, 0, 0, nullptr);
        const BOOL ok = (dw == sw && dh == sh)
                            ? BitBlt(mem, 0, 0, dw, dh, screen, mi.rcMonitor.left, mi.rcMonitor.top, SRCCOPY | CAPTUREBLT)
                            : StretchBlt(mem, 0, 0, dw, dh, screen, mi.rcMonitor.left, mi.rcMonitor.top, sw, sh,
                                         SRCCOPY | CAPTUREBLT);
        GdiFlush();
        if (ok) {
            CapturedScreen c;
            c.width = dw;
            c.height = dh;
            const auto* p = static_cast<const std::uint8_t*>(bits);
            c.bgra.assign(p, p + static_cast<std::size_t>(dw) * dh * 4);
            for (std::size_t i = 3; i < c.bgra.size(); i += 4) c.bgra[i] = 255; // GDI leaves alpha undefined
            out = std::move(c);
        } else if (error) {
            *error = "BitBlt failed";
        }
        SelectObject(mem, old);
    } else if (error) {
        *error = "CreateDIBSection failed";
    }
    if (dib) DeleteObject(dib);
    if (mem) DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return out;
}

namespace {

template <class T>
struct Com {
    T* p{nullptr};
    ~Com() {
        if (p) p->Release();
    }
    T** put() { return &p; }
    T* operator->() const { return p; }
    explicit operator bool() const { return p != nullptr; }
};

} // namespace

std::optional<std::string> encode_jpeg_data_url(const CapturedScreen& img, float quality, std::string* error) {
    auto fail = [&](const char* why) -> std::optional<std::string> {
        if (error) *error = why;
        return std::nullopt;
    };
    if (img.width <= 0 || img.height <= 0 || img.bgra.size() < static_cast<std::size_t>(img.width) * img.height * 4) {
        return fail("imagem vazia");
    }
    const HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool co_owned = SUCCEEDED(co);
    std::optional<std::string> result;
    {
        Com<IWICImagingFactory> factory;
        Com<IStream> stream;
        Com<IWICBitmapEncoder> encoder;
        Com<IWICBitmapFrameEncode> frame;
        Com<IPropertyBag2> props;
        HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory,
                                      reinterpret_cast<void**>(factory.put()));
        if (SUCCEEDED(hr)) hr = CreateStreamOnHGlobal(nullptr, TRUE, stream.put());
        if (SUCCEEDED(hr)) hr = factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.put());
        if (SUCCEEDED(hr)) hr = encoder->Initialize(stream.p, WICBitmapEncoderNoCache);
        if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(frame.put(), props.put());
        if (SUCCEEDED(hr) && props) {
            PROPBAG2 opt{};
            opt.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
            VARIANT v;
            VariantInit(&v);
            v.vt = VT_R4;
            v.fltVal = quality;
            props->Write(1, &opt, &v); // best effort: default quality otherwise
        }
        if (SUCCEEDED(hr)) hr = frame->Initialize(props.p);
        if (SUCCEEDED(hr)) hr = frame->SetSize(static_cast<UINT>(img.width), static_cast<UINT>(img.height));
        WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
        if (SUCCEEDED(hr)) hr = frame->SetPixelFormat(&fmt);
        if (SUCCEEDED(hr)) {
            // JPEG wants 24bpp BGR: drop the alpha byte row by row.
            const UINT stride = static_cast<UINT>(img.width) * 3;
            std::vector<BYTE> row(stride);
            for (int y = 0; y < img.height && SUCCEEDED(hr); ++y) {
                const std::uint8_t* src = img.bgra.data() + static_cast<std::size_t>(y) * img.width * 4;
                for (int x = 0; x < img.width; ++x) {
                    row[x * 3 + 0] = src[x * 4 + 0];
                    row[x * 3 + 1] = src[x * 4 + 1];
                    row[x * 3 + 2] = src[x * 4 + 2];
                }
                hr = frame->WritePixels(1, stride, stride, row.data());
            }
        }
        if (SUCCEEDED(hr)) hr = frame->Commit();
        if (SUCCEEDED(hr)) hr = encoder->Commit();
        HGLOBAL mem = nullptr;
        if (SUCCEEDED(hr)) hr = GetHGlobalFromStream(stream.p, &mem);
        if (SUCCEEDED(hr) && mem) {
            STATSTG st{};
            stream->Stat(&st, STATFLAG_NONAME);
            const auto size = static_cast<std::size_t>(st.cbSize.QuadPart);
            const void* p = GlobalLock(mem);
            if (p && size > 0) {
                result = "data:image/jpeg;base64," +
                         base64_encode(std::string_view(static_cast<const char*>(p), size));
            }
            if (p) GlobalUnlock(mem);
        }
        if (!result && error) *error = "JPEG encoding (WIC) failed";
    }
    if (co_owned) CoUninitialize();
    return result;
}

} // namespace rtai
