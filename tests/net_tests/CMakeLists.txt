# Unit/property tests for the rtai_net adapter layer (Dual-Path Cold_Path:
# JevAnalyticsClient builders/parsers, endpoint selection, keep-alive). These
# exercise the PURE, network-free pieces of rtai_net off Win32.
#
# GoogleTest: tests/core_tests is added before this directory and already makes
# the GTest::gtest / GTest::gtest_main targets available, so we reuse them. If
# this directory is ever configured standalone, fall back to FetchContent
# (same source/tag as the rest of the project).

if (NOT TARGET GTest::gtest)
    include(FetchContent)
    find_package(GTest CONFIG QUIET)
    if (NOT GTest_FOUND AND NOT TARGET GTest::gtest)
        FetchContent_Declare(
            googletest
            GIT_REPOSITORY https://github.com/google/googletest.git
            GIT_TAG v1.15.2
        )
        set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
        FetchContent_MakeAvailable(googletest)
    endif()
endif()

# Property tests for the Cold_Path land here later (tasks 8.4-8.7). Adding a
# source is a one-line change to this list; test_net_smoke.cpp keeps the target
# buildable and green in the meantime.
#
# test_http2_transport_integration.cpp (task 10.2) adds the direct HTTP/2
# transport integration tests: a pure Req 4.1/4.3 critical-endpoint static
# guard that runs everywhere, plus self-skipping live tests for HTTP/2
# negotiation (Req 4.4) and cancel+reissue connection reuse (Req 4.6), with the
# by-hand procedure in tests/net_tests/MANUAL_CHECKLIST.md.
add_executable(net_tests
    test_net_smoke.cpp
    test_jev_properties.cpp
    test_endpoint_selection_properties.cpp
    test_http2_transport_integration.cpp
)

target_include_directories(net_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

target_link_libraries(net_tests PRIVATE
    rtai_net
    GTest::gtest
    GTest::gtest_main
)

set_target_properties(net_tests PROPERTIES FOLDER "tests")

include(GoogleTest)
# Discover tests; DISCOVERY_MODE PRE_TEST avoids running the exe at configure.
gtest_discover_tests(net_tests DISCOVERY_MODE PRE_TEST)
