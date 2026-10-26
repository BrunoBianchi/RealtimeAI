# multilingual-e5 embedder (hybrid RAG) via ONNX Runtime.
#
# ONNX Runtime: RTAI_ONNXRUNTIME_ROOT (unpacked release with include/ and
# lib/) if set, otherwise the official prebuilt release is downloaded once at
# configure time. On Windows onnxruntime.dll is DELAY-LOADED by the app: a
# machine without the DLL (or without the model) still runs, BM25 only.
set(RTAI_ORT_VERSION "1.23.2" CACHE STRING "ONNX Runtime release used when RTAI_ONNXRUNTIME_ROOT is empty")

if (NOT RTAI_ONNXRUNTIME_ROOT)
    include(FetchContent)
    if (WIN32)
        set(_ort_pkg "onnxruntime-win-x64-${RTAI_ORT_VERSION}.zip")
    elseif (APPLE)
        set(_ort_pkg "onnxruntime-osx-universal2-${RTAI_ORT_VERSION}.tgz")
    else()
        set(_ort_pkg "onnxruntime-linux-x64-${RTAI_ORT_VERSION}.tgz")
    endif()
    FetchContent_Declare(onnxruntime_prebuilt
        URL "https://github.com/microsoft/onnxruntime/releases/download/v${RTAI_ORT_VERSION}/${_ort_pkg}"
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_MakeAvailable(onnxruntime_prebuilt)
    set(_ort_root "${onnxruntime_prebuilt_SOURCE_DIR}")
    # Let the optional Silero adapter (RTAI_ENABLE_ONNX) reuse the same runtime.
    set(RTAI_ONNXRUNTIME_ROOT "${_ort_root}" CACHE PATH "Path to ONNX Runtime (include/ + lib/)" FORCE)
else()
    set(_ort_root "${RTAI_ONNXRUNTIME_ROOT}")
endif()

find_library(RTAI_ORT_LIB NAMES onnxruntime HINTS "${_ort_root}/lib" NO_DEFAULT_PATH)
if (NOT RTAI_ORT_LIB)
    message(FATAL_ERROR "onnxruntime library not found under ${_ort_root}/lib")
endif()

add_library(rtai_embed_onnx STATIC src/e5_embedder.cpp)
target_include_directories(rtai_embed_onnx
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
    PRIVATE "${_ort_root}/include")
target_link_libraries(rtai_embed_onnx PUBLIC rtai_core "${RTAI_ORT_LIB}")
set_target_properties(rtai_embed_onnx PROPERTIES FOLDER "adapters")

# Where the runtime DLL/.so lives, for the app to copy next to the exe.
set(RTAI_ORT_RUNTIME_DIR "${_ort_root}/lib" CACHE INTERNAL "")
