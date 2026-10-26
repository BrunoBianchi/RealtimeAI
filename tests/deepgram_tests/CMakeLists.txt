# Integration test: real WAV -> real WinHTTP transport -> Deepgram Nova-3.
# Skips at runtime unless DEEPGRAM_API_KEY is set. Reuses the real core
# resampler and the real Deepgram transport (no mocks).
add_executable(deepgram_tests
    test_deepgram_live.cpp
)

target_link_libraries(deepgram_tests PRIVATE
    rtai::options
    rtai::core
    rtai::deepgram
    GTest::gtest
    GTest::gtest_main
)

# Let the test locate bundled assets.
target_compile_definitions(deepgram_tests PRIVATE
    RTAI_TEST_ASSET_DIR="${CMAKE_CURRENT_SOURCE_DIR}/assets")
set_target_properties(deepgram_tests PROPERTIES FOLDER "tests")

gtest_discover_tests(deepgram_tests DISCOVERY_MODE PRE_TEST)
