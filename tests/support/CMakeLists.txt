# Test doubles (scripted LLM, fake transport, scripted VAD) and the WAV file
# source. Only test targets link this; the app never sees these headers.
add_library(rtai_test_support STATIC
    wav_file_source.cpp
)
add_library(rtai::test_support ALIAS rtai_test_support)

target_include_directories(rtai_test_support PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(rtai_test_support
    PUBLIC rtai::core
    PRIVATE rtai::options)
set_target_properties(rtai_test_support PROPERTIES FOLDER "tests")
