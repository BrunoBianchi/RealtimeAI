cmake_minimum_required(VERSION 3.21)

project(RealTimeAI
    VERSION 2.0.0 # x-release-please-version
    DESCRIPTION "Real-time meeting copilot - native C++ audio, resilient STT, LLM suggestions, overlay"
    LANGUAGES CXX)

# ---------------------------------------------------------------------------
# Global settings
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Put all binaries in a predictable place so tests/app can find assets.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
option(RTAI_BUILD_TESTS "Build unit/integration tests" ON)
option(RTAI_ENABLE_ONNX "Build the ONNX Silero VAD adapter (requires onnxruntime)" OFF)
option(RTAI_ENABLE_EMBEDDINGS "Hybrid RAG: local multilingual-e5 embeddings via ONNX Runtime (downloaded if RTAI_ONNXRUNTIME_ROOT is empty)" OFF)

# ---------------------------------------------------------------------------
# Compiler flags
#   - /O2 optimized builds, /arch:AVX2 for the resampler SIMD path.
#   - The audio hot path must not throw; we still keep exceptions enabled for
#     setup/teardown code but document the no-throw contract in core headers.
# ---------------------------------------------------------------------------
# Keep <windows.h> from defining min/max macros and trim rarely-used APIs.
# Applied globally so any TU that includes windows headers is consistent.
if (WIN32)
    # Windows 10+ APIs (per-monitor DPI v2, GetDpiForWindow).
    add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00 WINVER=0x0A00)
endif()

if (MSVC)
    add_compile_options(/W4 /permissive- /utf-8)
    add_compile_options($<$<CONFIG:Release>:/O2>)
    # AVX2 enables the optional SIMD resampler kernel; scalar fallback is always built.
    add_compile_options($<$<CONFIG:Release>:/arch:AVX2>)
    # Multi-processor compilation.
    add_compile_options(/MP)
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# ---------------------------------------------------------------------------
# Subdirectories
# ---------------------------------------------------------------------------
add_subdirectory(src/core)

# ONNX adapters first: the app reads their runtime paths.
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

if (RTAI_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests/core_tests)
    if (WIN32)
        add_subdirectory(tests/deepgram_tests)
        add_subdirectory(tests/integration)
        add_subdirectory(tests/overlay_tests)
        add_subdirectory(tests/net_tests)
    endif()
endif()
