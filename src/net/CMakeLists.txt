# WinHTTP adapters: WebSocket (Deepgram), streaming HTTPS (LLM providers),
# analytics and web search.
add_library(rtai_net STATIC
    src/winhttp_websocket.cpp
    src/winhttp_llm_client.cpp
    src/jev_analytics_client.cpp
    src/web_search.cpp
)
add_library(rtai::net ALIAS rtai_net)

target_include_directories(rtai_net PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rtai_net
    PUBLIC rtai::core
    PRIVATE rtai::options winhttp)

set_target_properties(rtai_net PROPERTIES FOLDER "adapters")
