# WASAPI capture adapters (Windows-only COM audio).
add_library(rtai_audio_wasapi STATIC
    src/wasapi_capture.cpp
)

target_include_directories(rtai_audio_wasapi PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

# WASAPI/COM + MMCSS (avrt) libraries from the Windows SDK.
target_link_libraries(rtai_audio_wasapi
    PUBLIC rtai_core
    PRIVATE ole32 avrt)

set_target_properties(rtai_audio_wasapi PROPERTIES FOLDER "adapters")
