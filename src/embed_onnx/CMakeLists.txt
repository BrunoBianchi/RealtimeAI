# multilingual-e5 embedder (hybrid RAG) via ONNX Runtime (RTAI_ENABLE_EMBEDDINGS).
# On Windows the app DELAY-LOADS onnxruntime.dll: a machine without the DLL (or
# without the model) still runs, BM25 only.
add_library(rtai_embed_onnx STATIC
    src/e5_embedder.cpp
)
add_library(rtai::embed_onnx ALIAS rtai_embed_onnx)

target_include_directories(rtai_embed_onnx PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rtai_embed_onnx
    PUBLIC rtai::core onnxruntime::onnxruntime
    PRIVATE rtai::options)

set_target_properties(rtai_embed_onnx PROPERTIES FOLDER "adapters")
