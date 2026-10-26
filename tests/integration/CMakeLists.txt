# Integration tests against local fake servers (no keys, no internet):
#   python fake_deepgram.py 8765 18      +  stream_itest.exe keepalive 8765 25
#   python fake_openrouter.py 8780       +  llm_itest.exe 8780
# See README.md in this folder.
add_executable(stream_itest stream_itest.cpp)
target_link_libraries(stream_itest PRIVATE rtai::options rtai::core rtai::net)

add_executable(llm_itest llm_itest.cpp)
target_link_libraries(llm_itest PRIVATE rtai::options rtai::core rtai::net)

set_target_properties(stream_itest llm_itest PROPERTIES FOLDER "tests")
