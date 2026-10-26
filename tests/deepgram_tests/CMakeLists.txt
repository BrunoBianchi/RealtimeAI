# Integration test: real WAV -> real WinHTTP transport -> Deepgram Nova-3.
# Skips at runtime unless DEEPGRAM_API_KEY is set. Reuses the real core
# resampler and the real Deepgram transport (no mocks).
include(FetchContent)

find_package(GTest CONFIG QUIET)
if (NOT GTest_FOUND)
    # googletest is already made available by core_tests; reuse that target if
    # present, otherwise fetch here too.
    if (NOT TARGET GTest::gtest)
        FetchContent_Declare(
            googletest
            GIT_REPOSITORY https://github.com/google/googletest.git
            GIT_TAG v1.15.2
        )
        set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
        FetchContent_MakeAvailable(googletest)
    endif()
endif()

add_executable(deepgram_tests
    test_deepgram_live.cpp
)

target_link_libraries(deepgram_tests PRIVATE
    rtai_core
    rtai_deepgram
    GTest::gtest
    GTest::gtest_main
)

# Let the test locate bundled assets.
target_compile_definitions(deepgram_tests PRIVATE
    RTAI_TEST_ASSET_DIR="${CMAKE_CURRENT_SOURCE_DIR}/assets")

include(GoogleTest)
gtest_discover_tests(deepgram_tests)
