#include "rtai/wasapi_capture.hpp"

#include "rtai/copilot_engine.hpp"

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <avrt.h>
#include <combaseapi.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <span>
#include <stdexcept>

#ifdef _MSC_VER
#pragma comment(lib, "avrt.lib")
#endif

namespace rtai {

namespace {

// Defined locally so no INITGUID/ksuser dance is needed on MSVC or MinGW.
// PKEY_Device_FriendlyName {A45C254E-DF1C-4EFD-8020-67D146A850E0}, 14
const PROPERTYKEY kPkeyFriendlyName = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};
// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {00000003-0000-0010-8000-00AA00389B71}
const GUID kSubtypeIeeeFloat = {0x00000003, 0x0000, 0x0010,
                                {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

constexpr REFERENCE_TIME kHns100ms = 1'000'000; // 100 ms in 100-ns units

void throw_if_failed(HRESULT hr, const char* what) {
    if (FAILED(hr)) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), " (0x%08lX)", static_cast<unsigned long>(hr));
        throw std::runtime_error(std::string("WASAPI: ") + what + buf);
    }
}

template <class T>
void safe_release(T*& p) {
    if (p) {
        p->Release();
        p = nullptr;
    }
}

std::string narrow(const wchar_t* w) {
    if (!w) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string s(static_cast<std::size_t>(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
    return s;
}

// Follows "default device changed" notifications (Windows Sound settings,
// plugging a headset...). Called on a system thread: only flips a flag.
class DeviceWatcher final : public IMMNotificationClient {
public:
    DeviceWatcher(EDataFlow flow, std::shared_ptr<std::atomic<bool>> flag)
        : flow_(flow), flag_(std::move(flag)) {}

    ULONG STDMETHODCALLTYPE AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&ref_)); }
    ULONG STDMETHODCALLTYPE Release() override {
        const LONG r = InterlockedDecrement(&ref_);
        if (r == 0) delete this;
        return static_cast<ULONG>(r);
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
            *ppv = static_cast<IMMNotificationClient*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) override {
        // React to our flow changing on either the console/multimedia role or
        // the communications role: meeting apps follow eCommunications, media
        // follows eConsole, and open_stream() re-picks whichever one moved.
        if (flow == flow_ && (role == eConsole || role == eCommunications)) flag_->store(true);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

private:
    ~DeviceWatcher() = default;
    LONG ref_{1};
    EDataFlow flow_;
    std::shared_ptr<std::atomic<bool>> flag_;
};

} // namespace

struct WasapiCaptureSource::Impl {
    IMMDeviceEnumerator* enumerator{nullptr};
    IMMDevice* device{nullptr};
    IAudioClient* client{nullptr};
    IAudioCaptureClient* capture{nullptr};
    WAVEFORMATEX* mix_format{nullptr};
    HANDLE event{nullptr};
    DeviceWatcher* watcher{nullptr};
    std::shared_ptr<std::atomic<bool>> default_changed{std::make_shared<std::atomic<bool>>(false)};
};

WasapiCaptureSource::WasapiCaptureSource(AudioSource source, bool loopback)
    : source_(source), loopback_(loopback), impl_(std::make_unique<Impl>()) {}

WasapiCaptureSource::~WasapiCaptureSource() { stop(); }

AudioFormat WasapiCaptureSource::format() const {
    std::lock_guard<std::mutex> lk(fmt_mu_);
    if (!format_) throw std::runtime_error("WASAPI: format queried before start()");
    return *format_;
}

std::string WasapiCaptureSource::device_name() const {
    std::lock_guard<std::mutex> lk(fmt_mu_);
    return device_name_;
}

void WasapiCaptureSource::status(const std::string& msg) {
    if (status_cb_) {
        try { status_cb_(msg); } catch (...) {}
    }
}

void WasapiCaptureSource::start(FrameCallback cb) {
    if (thread_.joinable()) return;
    cb_ = std::move(cb);
    running_ = true;
    std::promise<void> ready;
    auto fut = ready.get_future();
    thread_ = std::thread([this, p = std::move(ready)]() mutable { thread_main(std::move(p)); });
    try {
        fut.get(); // rethrows the open error, if any
    } catch (...) {
        running_ = false;
        if (thread_.joinable()) thread_.join();
        throw;
    }
}

void WasapiCaptureSource::stop() {
    running_.store(false, std::memory_order_release);
    if (thread_.joinable()) thread_.join();
}

// ---------------------------------------------------------------------------
// Capture thread
// ---------------------------------------------------------------------------

void WasapiCaptureSource::open_stream() {
    const EDataFlow flow = loopback_ ? eRender : eCapture;
    // Meeting apps (Zoom, Teams, Meet, Discord) route to the eCommunications
    // default, which Windows lets the user set independently from the
    // eConsole/eMultimedia default used by media playback. Capturing eConsole
    // while the call plays on the eCommunications device is the "meeting is
    // silent" case: the loopback hears nothing. Prefer the communications
    // default and fall back to eConsole when the two are the same (or none is
    // set). The DeviceWatcher below reacts to either role changing.
    HRESULT ep = impl_->enumerator->GetDefaultAudioEndpoint(flow, eCommunications, &impl_->device);
    if (FAILED(ep) || !impl_->device) {
        ep = impl_->enumerator->GetDefaultAudioEndpoint(flow, eConsole, &impl_->device);
    }
    throw_if_failed(ep, loopback_ ? "no default output device" : "no default microphone");

    std::string name;
    IPropertyStore* props = nullptr;
    if (SUCCEEDED(impl_->device->OpenPropertyStore(STGM_READ, &props))) {
        PROPVARIANT v;
        PropVariantInit(&v);
        if (SUCCEEDED(props->GetValue(kPkeyFriendlyName, &v)) && v.vt == VT_LPWSTR) {
            name = narrow(v.pwszVal);
        }
        PropVariantClear(&v);
        props->Release();
    }

    throw_if_failed(impl_->device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                            reinterpret_cast<void**>(&impl_->client)),
                    "Activate(IAudioClient)");
    throw_if_failed(impl_->client->GetMixFormat(&impl_->mix_format), "GetMixFormat");

    const WAVEFORMATEX* wf = impl_->mix_format;
    bool is_float = wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf);
        is_float = IsEqualGUID(ext->SubFormat, kSubtypeIeeeFloat) != 0;
    }

    DWORD stream_flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    if (loopback_) stream_flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    throw_if_failed(impl_->client->Initialize(AUDCLNT_SHAREMODE_SHARED, stream_flags, kHns100ms, 0,
                                              impl_->mix_format, nullptr),
                    "IAudioClient::Initialize");

    impl_->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!impl_->event) throw std::runtime_error("WASAPI: CreateEvent failed");
    throw_if_failed(impl_->client->SetEventHandle(impl_->event), "SetEventHandle");
    throw_if_failed(impl_->client->GetService(__uuidof(IAudioCaptureClient),
                                              reinterpret_cast<void**>(&impl_->capture)),
                    "GetService(IAudioCaptureClient)");

    device_rate_ = wf->nSamplesPerSec;
    device_channels_ = wf->nChannels;
    device_bits_ = wf->wBitsPerSample;
    device_is_float_ = is_float;
    {
        std::lock_guard<std::mutex> lk(fmt_mu_);
        format_ = AudioFormat{device_rate_, device_channels_, SampleFormat::Float32};
        device_name_ = name;
    }
}

void WasapiCaptureSource::close_stream() {
    if (impl_->client) impl_->client->Stop();
    safe_release(impl_->capture);
    safe_release(impl_->client);
    if (impl_->mix_format) {
        CoTaskMemFree(impl_->mix_format);
        impl_->mix_format = nullptr;
    }
    safe_release(impl_->device);
    if (impl_->event) {
        CloseHandle(impl_->event);
        impl_->event = nullptr;
    }
}

bool WasapiCaptureSource::reopen_stream() {
    close_stream();
    try {
        open_stream();
        throw_if_failed(impl_->client->Start(), "IAudioClient::Start");
        recoveries_.fetch_add(1);
        status(std::string(loopback_ ? "System audio" : "Microphone") + " reopened on: " + device_name());
        return true;
    } catch (const std::exception& e) {
        close_stream();
        last_error_ = e.what();
        return false;
    }
}

void WasapiCaptureSource::thread_main(std::promise<void> ready) {
    const HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_ok = SUCCEEDED(co);

    try {
        throw_if_failed(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                         __uuidof(IMMDeviceEnumerator),
                                         reinterpret_cast<void**>(&impl_->enumerator)),
                        "CoCreateInstance(MMDeviceEnumerator)");
        open_stream();
        throw_if_failed(impl_->client->Start(), "IAudioClient::Start");
    } catch (...) {
        close_stream();
        safe_release(impl_->enumerator);
        if (com_ok) CoUninitialize();
        ready.set_exception(std::current_exception());
        return;
    }

    impl_->watcher = new DeviceWatcher(loopback_ ? eRender : eCapture, impl_->default_changed);
    if (FAILED(impl_->enumerator->RegisterEndpointNotificationCallback(impl_->watcher))) {
        impl_->watcher->Release();
        impl_->watcher = nullptr;
    }
    ready.set_value();

    // Raise thread to Pro Audio MMCSS class for low, consistent latency.
    DWORD task_index = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

    int failures = 0;
    auto try_reopen = [&] {
        if (reopen_stream()) {
            failures = 0;
            return;
        }
        // Report the first failure and then every ~10 s, not every attempt.
        if (failures++ % 20 == 0) status("could not reopen the device: " + last_error_);
        for (int i = 0; i < 10 && running_.load(); ++i) Sleep(50); // 500 ms, interruptible
    };

    while (running_.load(std::memory_order_acquire)) {
        if (impl_->default_changed->exchange(false)) {
            status(std::string("Default ") + (loopback_ ? "output" : "input") +
                   " mudou; trocando...");
            try_reopen();
            continue;
        }
        if (!impl_->client) { // device gone: keep trying until it comes back
            try_reopen();
            continue;
        }
        // Drain on wake-up *and* on timeout: covers drivers/OS versions where
        // the loopback event isn't signaled.
        WaitForSingleObject(impl_->event, 50);
        const HRESULT hr = static_cast<HRESULT>(drain_packets());
        if (FAILED(hr)) {
            status(hr == AUDCLNT_E_DEVICE_INVALIDATED
                       ? std::string("Audio device removed or changed; reopening...")
                       : std::string("Capture error; reopening..."));
            close_stream(); // the next pass reopens on the current default device
        }
    }

    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    close_stream();
    if (impl_->watcher) {
        impl_->enumerator->UnregisterEndpointNotificationCallback(impl_->watcher);
        impl_->watcher->Release();
        impl_->watcher = nullptr;
    }
    safe_release(impl_->enumerator);
    if (com_ok) CoUninitialize();
}

long WasapiCaptureSource::drain_packets() {
    UINT32 packet = 0;
    HRESULT hr = impl_->capture->GetNextPacketSize(&packet);
    if (FAILED(hr)) return hr;
    while (packet != 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = impl_->capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) return hr;

        LARGE_INTEGER c;
        QueryPerformanceCounter(&c);
        deliver(data, frames, flags, static_cast<std::uint64_t>(c.QuadPart));

        hr = impl_->capture->ReleaseBuffer(frames);
        if (FAILED(hr)) return hr;
        hr = impl_->capture->GetNextPacketSize(&packet);
        if (FAILED(hr)) return hr;
    }
    return S_OK;
}

void WasapiCaptureSource::deliver(const unsigned char* data, std::uint32_t frames,
                                  unsigned long flags, std::uint64_t ticks) {
    if (!cb_ || frames == 0) return;
    if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) glitches_.fetch_add(1);

    const std::size_t n = static_cast<std::size_t>(frames) * device_channels_;
    if (float_scratch_.size() < n) float_scratch_.resize(n);

    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        // The buffer content is undefined: emit zeros.
        std::fill_n(float_scratch_.begin(), n, 0.0f);
        const std::span<const float> buf(float_scratch_.data(), n);
        feed_frame_vad(buf);
        cb_(buf, ticks);
        return;
    }
    if (device_is_float_ && device_bits_ == 32) {
        // Zero-copy: hand the device float buffer straight to the callback.
        const std::span<const float> buf(reinterpret_cast<const float*>(data), n);
        feed_frame_vad(buf);
        cb_(buf, ticks);
        return;
    }
    switch (device_bits_) {
        case 16: {
            const auto* p = reinterpret_cast<const std::int16_t*>(data);
            for (std::size_t i = 0; i < n; ++i) float_scratch_[i] = static_cast<float>(p[i]) / 32768.0f;
            break;
        }
        case 24: {
            for (std::size_t i = 0; i < n; ++i) {
                const unsigned char* s = data + i * 3;
                std::int32_t v = (static_cast<std::int32_t>(s[2]) << 24) |
                                 (static_cast<std::int32_t>(s[1]) << 16) |
                                 (static_cast<std::int32_t>(s[0]) << 8);
                float_scratch_[i] = static_cast<float>(v) / 2147483648.0f;
            }
            break;
        }
        case 32: {
            const auto* p = reinterpret_cast<const std::int32_t*>(data);
            for (std::size_t i = 0; i < n; ++i) float_scratch_[i] = static_cast<float>(p[i]) / 2147483648.0f;
            break;
        }
        default:
            std::fill_n(float_scratch_.begin(), n, 0.0f);
            break;
    }
    const std::span<const float> buf(float_scratch_.data(), n);
    feed_frame_vad(buf);
    cb_(buf, ticks);
}

// ---------------------------------------------------------------------------
// Local acoustic VAD (Hot_Path, Req 1.5/1.6/3.1-3.3). Runs on the capture
// thread. Resamples the interleaved device buffer to 16 kHz mono int16 (same
// path SourcePipeline uses), slices it into 20 ms frames (320 samples) and
// feeds the FrameVad. Each edge is dispatched to the engine, which only
// enqueues + notifies, so the capture thread never blocks and the signal is
// independent of any Deepgram event.
// ---------------------------------------------------------------------------
void WasapiCaptureSource::feed_frame_vad(std::span<const float> interleaved) {
    if (!engine_ || interleaved.empty()) return;

    const AudioFormat fmt = format();
    // Build the FrameVad once; a 20 ms frame is 2% of the 16 kHz target rate,
    // i.e. frame_ms * 16000 / 1000 samples regardless of the device format.
    if (!vad_) {
        vad_.emplace(vad_cfg_);
        vad_frame_samples_ = static_cast<std::size_t>(
            static_cast<std::int64_t>(PcmResampler::kTargetRate) * vad_cfg_.frame_ms / 1000);
        if (vad_frame_samples_ == 0) vad_frame_samples_ = 320;
        vad_frame_accum_.clear();
        vad_frame_accum_.reserve(vad_frame_samples_ * 2);
    }
    // (Re)build the resampler on the first buffer and after a device switch.
    if (!vad_resampler_ || vad_resampler_->input_rate() != fmt.sample_rate() ||
        vad_resampler_->input_channels() != fmt.channels()) {
        vad_resampler_.emplace(fmt.sample_rate(), fmt.channels());
        const std::size_t max_in_frames = fmt.sample_rate() / 10; // 100 ms
        vad_pcm_scratch_.assign(vad_resampler_->max_output_samples(max_in_frames) + vad_frame_samples_, 0);
    }

    const std::size_t frames = interleaved.size() / fmt.channels();
    if (frames == 0) return;
    const std::size_t needed = vad_resampler_->max_output_samples(frames);
    if (vad_pcm_scratch_.size() < needed) vad_pcm_scratch_.resize(needed); // rare oversized packet

    const std::size_t produced = vad_resampler_->process(interleaved, vad_pcm_scratch_);

    const AudioSource src = source_;
    for (std::size_t i = 0; i < produced; ++i) {
        vad_frame_accum_.push_back(vad_pcm_scratch_[i]);
        if (vad_frame_accum_.size() < vad_frame_samples_) continue;

        const FrameVadResult r = vad_->on_frame(vad_frame_accum_.data(), vad_frame_accum_.size());
        // Edges are enqueue + notify on the engine: never blocks the capture
        // thread, fires independently of Deepgram (Req 1.5/1.6/3.1/3.3).
        if (r.speculative_edge) {
            engine_->on_vad_speculate(src, static_cast<float>(r.rms));
        }
        if (r.commit_silence_edge) {
            engine_->on_vad_commit_silence(src);
        }
        vad_frame_accum_.clear();
    }
}

} // namespace rtai
