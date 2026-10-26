# Win32/Direct2D integration tests for the Glanceable HUD Overlay (task 22).
#
# This target links rtai_overlay and the Win32 libraries, and exercises the
# automatable subset of task 22 against the real Win32 API on an interactive
# desktop (it self-skips on headless sessions). The timing/visual items that
# need the live renderer are documented in MANUAL_CHECKLIST.md, and the
# "no rotating spinner" rule (Req 13.4) is enforced statically below.

add_executable(overlay_tests
    test_overlay_win32.cpp
)

target_include_directories(overlay_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

# rtai_overlay brings the overlay headers and the Win32/D2D link deps; we also
# link user32/gdi32 directly for the window-creation calls in the test itself.
target_link_libraries(overlay_tests PRIVATE
    rtai::options
    rtai::overlay
    user32
    gdi32
    GTest::gtest
    GTest::gtest_main
)

set_target_properties(overlay_tests PROPERTIES FOLDER "tests")

gtest_discover_tests(overlay_tests DISCOVERY_MODE PRE_TEST)

# ---------------------------------------------------------------------------
# Req 13.4 static guard: no rotating-spinner draw code in the overlay source.
# Runs on every build of this target, anywhere (no desktop/D2D needed).
# ---------------------------------------------------------------------------
set(_overlay_src "${CMAKE_SOURCE_DIR}/src/overlay/src/overlay_window.cpp")
add_custom_target(overlay_no_spinner_check ALL
    COMMAND ${CMAKE_COMMAND}
            -DOVERLAY_SRC=${_overlay_src}
            -P "${CMAKE_CURRENT_SOURCE_DIR}/no_spinner_check.cmake"
    COMMENT "Req 13.4: checking the overlay source has no rotating spinner"
    VERBATIM)
set_target_properties(overlay_no_spinner_check PROPERTIES FOLDER "tests")

# Register the static guard as a CTest case too, so `ctest` reports it.
add_test(NAME overlay_no_spinner_check
         COMMAND ${CMAKE_COMMAND}
                 -DOVERLAY_SRC=${_overlay_src}
                 -P "${CMAKE_CURRENT_SOURCE_DIR}/no_spinner_check.cmake")
