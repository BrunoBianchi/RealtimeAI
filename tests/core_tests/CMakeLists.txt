# Unit tests for the pure core. GoogleTest is pulled via FetchContent so no
# external package manager is required; if vcpkg/the system provides GTest,
# find_package is used instead.
include(FetchContent)

find_package(GTest CONFIG QUIET)

if (NOT GTest_FOUND AND NOT TARGET GTest::gtest)
    FetchContent_Declare(
        googletest
        GIT_REPOSITORY https://github.com/google/googletest.git
        GIT_TAG v1.15.2
    )
    # For Windows / MSVC: don't override the parent project's runtime settings.
    set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(googletest)
endif()

add_executable(core_tests
    test_audio_format.cpp
    test_resampler.cpp
    test_vad_state_machine.cpp
    test_deepgram_protocol.cpp
    test_json_min.cpp
    test_ring_buffer.cpp
    test_pipeline_e2e.cpp
    test_latency.cpp
    test_device_format.cpp
    test_outbound_queue.cpp
    test_deepgram_stream.cpp
    test_source_pipeline.cpp
    test_copilot.cpp
    test_llm_protocol.cpp
    test_session_store.cpp
    test_text_and_ui_core.cpp
    test_settings.cpp
    test_ui_actions.cpp
    test_server_protocol.cpp
    test_ui_models.cpp
    test_hud_properties.cpp
    test_frame_vad_properties.cpp
    test_fast_filter_properties.cpp
    test_session_transcript_properties.cpp
    test_shadow_streaming_properties.cpp
    test_dashboard_properties.cpp
    test_render_coalescing_properties.cpp
    test_finalize_timing.cpp
    test_subject_fusion_properties.cpp
    test_rag_grounding_properties.cpp
    test_transcription_mode_properties.cpp
    test_goal_workspace_properties.cpp
    test_star_rag_latency.cpp
    test_rag_quality.cpp
    test_question_gate.cpp
    test_question_flow.cpp
    test_question_interpretation.cpp
)

target_include_directories(core_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

target_link_libraries(core_tests PRIVATE
    rtai_core
    GTest::gtest
    GTest::gtest_main
)

include(GoogleTest)
# Discover tests; DISCOVERY_MODE PRE_TEST avoids running the exe at configure.
gtest_discover_tests(core_tests DISCOVERY_MODE PRE_TEST)
