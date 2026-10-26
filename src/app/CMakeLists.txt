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

# Hybrid RAG embeddings. onnxruntime.dll is delay-loaded so the app still
# starts (BM25 only) on a machine without it; the DLL is copied next to the exe.
if (RTAI_ENABLE_EMBEDDINGS)
    target_link_libraries(rtai_app PRIVATE rtai_embed_onnx)
    target_compile_definitions(rtai_app PRIVATE RTAI_HAVE_EMBEDDINGS=1)
    if (MSVC)
        target_link_options(rtai_app PRIVATE "/DELAYLOAD:onnxruntime.dll")
        target_link_libraries(rtai_app PRIVATE delayimp)
        add_custom_command(TARGET rtai_app POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${RTAI_ORT_RUNTIME_DIR}/onnxruntime.dll" "$<TARGET_FILE_DIR:rtai_app>/onnxruntime.dll")
    endif()
endif()

set_target_properties(rtai_app PROPERTIES FOLDER "app")
