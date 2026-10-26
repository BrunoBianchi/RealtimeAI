# App executable: WASAPI lanes -> VAD -> Deepgram -> copilot engine ->
# LLM suggestions -> overlay HUD + session files.
add_executable(rtai_app
    src/main.cpp
)

# Version resource (file properties in Explorer, installer metadata).
if (WIN32)
    enable_language(RC)
    if (RTAI_VERSION_IS_PRERELEASE)
        set(RTAI_RC_FILEFLAGS "VS_FF_PRERELEASE")
    else()
        set(RTAI_RC_FILEFLAGS "0x0L")
    endif()
    configure_file(rtai_app.rc.in "${CMAKE_CURRENT_BINARY_DIR}/rtai_app.rc" @ONLY)
    target_sources(rtai_app PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/rtai_app.rc")
endif()

target_include_directories(rtai_app PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include")

target_link_libraries(rtai_app PRIVATE
    rtai::options
    rtai::version
    rtai::core
    rtai::audio_wasapi
    rtai::net
    rtai::deepgram
    rtai::overlay
    shell32
    ole32
    crypt32
    comdlg32
    gdi32
    user32
    dwmapi
    winmm # timeBeginPeriod: 1 ms timer resolution for the real-time threads
)

# Optional Silero VAD adapter.
if (RTAI_ENABLE_ONNX)
    target_link_libraries(rtai_app PRIVATE rtai::vad_onnx)
    target_compile_definitions(rtai_app PRIVATE RTAI_HAVE_ONNX=1)
endif()

# Hybrid RAG embeddings. onnxruntime.dll is delay-loaded so the app still
# starts (BM25 only) on a machine without it.
if (RTAI_ENABLE_EMBEDDINGS)
    target_link_libraries(rtai_app PRIVATE rtai::embed_onnx)
    target_compile_definitions(rtai_app PRIVATE RTAI_HAVE_EMBEDDINGS=1)
    if (MSVC)
        target_link_options(rtai_app PRIVATE "/DELAYLOAD:onnxruntime.dll")
        target_link_libraries(rtai_app PRIVATE delayimp)
    endif()
endif()

# Ship the ONNX Runtime DLL next to the exe whenever an adapter uses it.
if (WIN32 AND (RTAI_ENABLE_ONNX OR RTAI_ENABLE_EMBEDDINGS) AND EXISTS "${RTAI_ORT_RUNTIME_DIR}/onnxruntime.dll")
    add_custom_command(TARGET rtai_app POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${RTAI_ORT_RUNTIME_DIR}/onnxruntime.dll" "$<TARGET_FILE_DIR:rtai_app>/onnxruntime.dll"
        VERBATIM)
endif()

set_target_properties(rtai_app PROPERTIES FOLDER "app")
