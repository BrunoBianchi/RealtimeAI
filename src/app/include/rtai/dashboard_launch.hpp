// Opens the Electron dashboard on its Settings page. The dashboard is the one
// place to configure the app, also when the engine was started on its own. It
// is single-instance: a dashboard that is already running just comes forward.
#pragma once

#include <windows.h>

#include <array>
#include <filesystem>
#include <string>
#include <system_error>

namespace rtai::dashboard {

namespace fs = std::filesystem;

inline fs::path own_exe_dir() {
    std::array<wchar_t, 32768> buf{};
    const DWORD n = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    return fs::path(std::wstring(buf.data(), n)).parent_path();
}

inline bool spawn_detached(const fs::path& exe, const std::wstring& args, const fs::path& cwd) {
    std::wstring cmd = L"\"" + exe.wstring() + L"\" " + args;
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, FALSE, DETACHED_PROCESS, nullptr,
                        cwd.c_str(), &si, &pi)) {
        return false;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

// Installed: <app>\resources\native\rtai_app.exe next to <app>\Cue.exe.
// From source: build\bin\Release\rtai_app.exe under the repo, with the
// dashboard run by its local Electron.
inline bool open_settings(const std::wstring& section = L"general") {
    std::error_code ec;
    const std::wstring flag = L"--open-settings=" + section;
    const fs::path dir = own_exe_dir();

    const fs::path app_root = dir.parent_path().parent_path();
    const fs::path installed = app_root / L"Cue.exe";
    if (fs::exists(installed, ec)) return spawn_detached(installed, flag, app_root);

    for (fs::path p = dir; !p.empty(); p = p.parent_path()) {
        const fs::path app = p / L"apps" / L"dashboard";
        const fs::path electron = app / L"node_modules" / L"electron" / L"dist" / L"electron.exe";
        if (fs::exists(electron, ec)) {
            // Set by some shells; it would make Electron run as plain Node.
            SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", nullptr);
            return spawn_detached(electron, L"\"" + app.wstring() + L"\" " + flag, app);
        }
        if (p == p.parent_path()) break;
    }
    return false;
}

}  // namespace rtai::dashboard
