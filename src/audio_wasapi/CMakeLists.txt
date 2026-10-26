# WASAPI capture adapters (Windows-only COM audio): microphone + loopback.
add_library(rtai_audio_wasapi STATIC
    src/wasapi_capture.cpp
)
add_library(rtai::audio_wasapi ALIAS rtai_audio_wasapi)

target_include_directories(rtai_audio_wasapi PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")

# WASAPI/COM + MMCSS (avrt) libraries from the Windows SDK.
target_link_libraries(rtai_audio_wasapi
    PUBLIC rtai::core
    PRIVATE rtai::options ole32 avrt)

set_target_properties(rtai_audio_wasapi PROPERTIES FOLDER "adapters")
