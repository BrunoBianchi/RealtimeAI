# Silero VAD via ONNX Runtime (RTAI_ENABLE_ONNX). The runtime comes from
# cmake/RtaiOnnxRuntime.cmake (RTAI_ONNXRUNTIME_ROOT or the official release).
add_library(rtai_vad_onnx STATIC
    src/silero_vad.cpp
)
add_library(rtai::vad_onnx ALIAS rtai_vad_onnx)

target_include_directories(rtai_vad_onnx PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rtai_vad_onnx
    PUBLIC rtai::core onnxruntime::onnxruntime
    PRIVATE rtai::options)

set_target_properties(rtai_vad_onnx PROPERTIES FOLDER "adapters")
