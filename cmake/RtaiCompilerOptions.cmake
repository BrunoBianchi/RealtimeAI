# Compiler/linker settings shared by every RealTimeAI target.
#
#   rtai::options  INTERFACE target: warnings and per-target flags. Every
#                  first-party target links it PRIVATE (third-party code such
#                  as GoogleTest keeps its own flags).
#
# Optimized builds (Release / RelWithDebInfo) get whole-program optimization
# (LTO / MSVC /GL + /LTCG) and dead-code stripping: the audio, STT and LLM hot
# paths cross library boundaries (core -> net -> app), which LTO can inline.
include_guard(GLOBAL)
include(CheckIPOSupported)

option(RTAI_ENABLE_LTO "Link-time optimization in optimized builds" ON)
option(RTAI_ENABLE_AVX2 "Compile for AVX2 (/arch:AVX2, -mavx2). Faster on modern CPUs, but the binary crashes on CPUs without AVX2" OFF)
option(RTAI_WARNINGS_AS_ERRORS "Treat compiler warnings as errors" OFF)

# ---- Global: platform API level (also seen by third-party Windows code) ----
if (WIN32)
    # Windows 10+ APIs (per-monitor DPI v2, GetDpiForWindow, power throttling).
    add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00 WINVER=0x0A00)
endif()

# ---- Global: optimizer level -------------------------------------------------
# MSVC Release defaults to /Ob2; /Ob3 (VS 2019+) inlines more aggressively.
if (MSVC)
    foreach (_cfg RELEASE RELWITHDEBINFO)
        string(REPLACE "/Ob2" "/Ob3" CMAKE_CXX_FLAGS_${_cfg} "${CMAKE_CXX_FLAGS_${_cfg}}")
        string(REPLACE "/Ob1" "/Ob3" CMAKE_CXX_FLAGS_${_cfg} "${CMAKE_CXX_FLAGS_${_cfg}}")
    endforeach()
endif()

# ---- Global: link-time optimization ----------------------------------------
if (RTAI_ENABLE_LTO)
    check_ipo_supported(RESULT _rtai_ipo OUTPUT _rtai_ipo_msg LANGUAGES CXX)
    if (_rtai_ipo)
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELEASE ON)
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELWITHDEBINFO ON)
    else()
        message(STATUS "RealTimeAI: LTO not supported by this toolchain (${_rtai_ipo_msg})")
    endif()
endif()

# ---- rtai::options ----------------------------------------------------------
add_library(rtai_options INTERFACE)
add_library(rtai::options ALIAS rtai_options)
target_compile_features(rtai_options INTERFACE cxx_std_20)

set(_rtai_opt "$<OR:$<CONFIG:Release>,$<CONFIG:RelWithDebInfo>,$<CONFIG:MinSizeRel>>")

if (MSVC)
    target_compile_options(rtai_options INTERFACE
        /W4 /permissive- /utf-8 /Zc:__cplusplus /Zc:inline
        # Optimized builds: intrinsics, function-level linking and global data
        # folding, so /OPT:REF,ICF can drop what the app never calls.
        "$<${_rtai_opt}:/Oi;/Gy;/Gw>"
        "$<$<BOOL:${RTAI_WARNINGS_AS_ERRORS}>:/WX>")
    target_link_options(rtai_options INTERFACE
        "$<${_rtai_opt}:/OPT:REF;/OPT:ICF;/INCREMENTAL:NO>")
    if (RTAI_ENABLE_AVX2)
        target_compile_options(rtai_options INTERFACE /arch:AVX2)
    endif()
    # Parallel compilation inside each MSBuild project (Ninja already is).
    if (CMAKE_GENERATOR MATCHES "Visual Studio")
        add_compile_options(/MP)
    endif()
else()
    target_compile_options(rtai_options INTERFACE
        -Wall -Wextra -Wpedantic
        "$<$<BOOL:${RTAI_WARNINGS_AS_ERRORS}>:-Werror>")
    if (RTAI_ENABLE_AVX2)
        target_compile_options(rtai_options INTERFACE -mavx2 -mfma)
    endif()
endif()

unset(_rtai_opt)
