# Deepgram transport for Windows: core DeepgramStream + WinHTTP WebSocket.
add_library(rtai_deepgram STATIC
    src/deepgram_transport.cpp
)

target_include_directories(rtai_deepgram PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

target_link_libraries(rtai_deepgram PUBLIC rtai_core rtai_net)

set_target_properties(rtai_deepgram PROPERTIES FOLDER "adapters")
