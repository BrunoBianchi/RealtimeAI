# Silero VAD via ONNX Runtime. Requires an ONNX Runtime install; point
# RTAI_ONNXRUNTIME_ROOT at the unpacked onnxruntime (with include/ and lib/).
add_library(rtai_vad_onnx STATIC
    src/silero_vad.cpp
)

target_include_directories(rtai_vad_onnx PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

set(RTAI_ONNXRUNTIME_ROOT "" CACHE PATH "Path to ONNX Runtime (include/ + lib/)")

if (NOT RTAI_ONNXRUNTIME_ROOT)
    message(FATAL_ERROR
        "RTAI_ENABLE_ONNX=ON requires -DRTAI_ONNXRUNTIME_ROOT=C:/path/to/onnxruntime")
endif()

target_include_directories(rtai_vad_onnx PUBLIC "${RTAI_ONNXRUNTIME_ROOT}/include")
find_library(ONNXRUNTIME_LIB
    NAMES onnxruntime
    HINTS "${RTAI_ONNXRUNTIME_ROOT}/lib")
if (NOT ONNXRUNTIME_LIB)
    message(FATAL_ERROR "onnxruntime library not found under ${RTAI_ONNXRUNTIME_ROOT}/lib")
endif()

target_link_libraries(rtai_vad_onnx PUBLIC rtai_core PRIVATE "${ONNXRUNTIME_LIB}")

set_target_properties(rtai_vad_onnx PROPERTIES FOLDER "adapters")
