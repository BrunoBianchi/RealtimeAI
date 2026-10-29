cmake_minimum_required(VERSION 3.21)

project(RealTimeAI
    VERSION 2.1.0 # x-release-please-version
    DESCRIPTION "Real-time meeting copilot - native C++ audio, resilient STT, LLM suggestions, overlay"
    HOMEPAGE_URL "https://github.com/BrunoBianchi/RealtimeAI"
    LANGUAGES CXX)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

# ---------------------------------------------------------------------------
# Global settings
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set_property(GLOBAL PROPERTY USE_FOLDERS ON)

# All binaries in one place: tests find their assets, the dashboard finds the
# overlay at build/bin/<Config>/rtai_app.exe.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
option(RTAI_BUILD_TESTS "Build unit/integration tests" ON)
option(RTAI_ENABLE_ONNX "Silero VAD adapter via ONNX Runtime" OFF)
option(RTAI_ENABLE_EMBEDDINGS "Hybrid RAG: local multilingual-e5 embeddings via ONNX Runtime" OFF)

include(RtaiCompilerOptions)
include(RtaiVersion)

# ---------------------------------------------------------------------------
# Libraries and the app
# ---------------------------------------------------------------------------
# rtai_core is platform-free (no <windows.h>): it builds and tests anywhere.
add_subdirectory(src/core)

# ONNX adapters first: the app reads their runtime paths.
if (RTAI_ENABLE_ONNX OR RTAI_ENABLE_EMBEDDINGS)
    include(RtaiOnnxRuntime)
endif()
if (RTAI_ENABLE_EMBEDDINGS)
    add_subdirectory(src/embed_onnx)
endif()
if (RTAI_ENABLE_ONNX)
    add_subdirectory(src/vad_onnx)
endif()

if (WIN32)
    add_subdirectory(src/audio_wasapi)
    add_subdirectory(src/net)
    add_subdirectory(src/deepgram)
    add_subdirectory(src/overlay)
    add_subdirectory(src/app)
endif()

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
if (RTAI_BUILD_TESTS)
    enable_testing()
    include(RtaiGoogleTest)
    add_subdirectory(tests/core_tests)
    if (WIN32)
        add_subdirectory(tests/deepgram_tests)
        add_subdirectory(tests/integration)
        add_subdirectory(tests/overlay_tests)
        add_subdirectory(tests/net_tests)
    endif()
endif()
