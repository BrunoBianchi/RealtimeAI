# Floating HUD: Win32 layered window rendered with Direct2D/DirectWrite.
add_library(rtai_overlay STATIC
    src/overlay_window.cpp
    src/screen_capture.cpp
)
add_library(rtai::overlay ALIAS rtai_overlay)

target_include_directories(rtai_overlay PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(rtai_overlay
    PUBLIC rtai::core
    PRIVATE rtai::options d2d1 dwrite user32 gdi32 windowscodecs ole32 oleaut32)

set_target_properties(rtai_overlay PROPERTIES FOLDER "ui")
