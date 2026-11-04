# WinHTTP adapters: WebSocket (Deepgram), streaming HTTPS (LLM providers),
# analytics, web search and the RealTimeAI cloud session broker.
add_library(rtai_net STATIC
    src/winhttp_websocket.cpp
    src/winhttp_llm_client.cpp
    src/jev_analytics_client.cpp
    src/web_search.cpp
    src/cloud_client.cpp
)
add_library(rtai::net ALIAS rtai_net)

target_include_directories(rtai_net PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rtai_net
    PUBLIC rtai::core rtai::version
    PRIVATE rtai::options winhttp)

set_target_properties(rtai_net PROPERTIES FOLDER "adapters")
