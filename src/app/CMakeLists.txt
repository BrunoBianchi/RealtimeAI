# App executable: WASAPI lanes -> VAD -> Deepgram -> copilot engine ->
# OpenRouter suggestions -> overlay HUD + session files.
add_executable(rtai_app
    src/main.cpp
)

target_include_directories(rtai_app PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

target_link_libraries(rtai_app PRIVATE
    rtai_core
    rtai_audio_wasapi
    rtai_net
    rtai_deepgram
    rtai_overlay
    shell32
    ole32
    crypt32
    comdlg32
    gdi32
    user32
    dwmapi
)

# Optionally link the ONNX Silero adapter when enabled.
if (RTAI_ENABLE_ONNX)
    target_link_libraries(rtai_app PRIVATE rtai_vad_onnx)
    target_compile_definitions(rtai_app PRIVATE RTAI_HAVE_ONNX=1)
endif()

set_target_properties(rtai_app PROPERTIES FOLDER "app")
