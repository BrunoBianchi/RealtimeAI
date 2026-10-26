# ONNX Runtime for the optional ONNX adapters (Silero VAD, e5 embeddings).
#
# RTAI_ONNXRUNTIME_ROOT points at an unpacked release (include/ + lib/). When
# empty, the official prebuilt release for this platform is downloaded once at
# configure time. Provides:
#   onnxruntime::onnxruntime   imported headers + import library
#   RTAI_ORT_RUNTIME_DIR       folder holding onnxruntime.dll / .so
include_guard(GLOBAL)

set(RTAI_ORT_VERSION "1.23.2" CACHE STRING "ONNX Runtime release used when RTAI_ONNXRUNTIME_ROOT is empty")
set(RTAI_ONNXRUNTIME_ROOT "" CACHE PATH "Unpacked ONNX Runtime (include/ + lib/). Empty = download the official release")

if (RTAI_ONNXRUNTIME_ROOT)
    set(_rtai_ort_root "${RTAI_ONNXRUNTIME_ROOT}")
else()
    include(FetchContent)
    if (WIN32)
        set(_rtai_ort_pkg "onnxruntime-win-x64-${RTAI_ORT_VERSION}.zip")
    elseif (APPLE)
        set(_rtai_ort_pkg "onnxruntime-osx-universal2-${RTAI_ORT_VERSION}.tgz")
    else()
        set(_rtai_ort_pkg "onnxruntime-linux-x64-${RTAI_ORT_VERSION}.tgz")
    endif()
    FetchContent_Declare(onnxruntime_prebuilt
        URL "https://github.com/microsoft/onnxruntime/releases/download/v${RTAI_ORT_VERSION}/${_rtai_ort_pkg}"
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_MakeAvailable(onnxruntime_prebuilt)
    set(_rtai_ort_root "${onnxruntime_prebuilt_SOURCE_DIR}")
endif()

find_library(RTAI_ORT_LIB NAMES onnxruntime HINTS "${_rtai_ort_root}/lib" NO_DEFAULT_PATH)
if (NOT RTAI_ORT_LIB)
    message(FATAL_ERROR "onnxruntime library not found under ${_rtai_ort_root}/lib")
endif()

add_library(rtai_onnxruntime INTERFACE)
add_library(onnxruntime::onnxruntime ALIAS rtai_onnxruntime)
target_include_directories(rtai_onnxruntime SYSTEM INTERFACE "${_rtai_ort_root}/include")
target_link_libraries(rtai_onnxruntime INTERFACE "${RTAI_ORT_LIB}")

set(RTAI_ORT_RUNTIME_DIR "${_rtai_ort_root}/lib" CACHE INTERNAL "Folder with the ONNX Runtime shared library")
unset(_rtai_ort_root)
unset(_rtai_ort_pkg)
