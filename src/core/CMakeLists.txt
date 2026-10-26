# Pure, platform-free core: no <windows.h>, no third-party deps. Everything
# with threads/timing (Deepgram stream, copilot engine, session store) lives
# here so it can be unit-tested (and run under TSan) on any OS.
find_package(Threads REQUIRED)

add_library(rtai_core STATIC
    src/resampler.cpp
    src/wav_file_source.cpp
    src/deepgram_stream.cpp
    src/copilot_engine.cpp
    src/session_store.cpp
)
add_library(rtai::core ALIAS rtai_core)

target_include_directories(rtai_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_compile_features(rtai_core PUBLIC cxx_std_20)
target_link_libraries(rtai_core
    PUBLIC Threads::Threads
    PRIVATE rtai::options)

set_target_properties(rtai_core PROPERTIES FOLDER "core")
