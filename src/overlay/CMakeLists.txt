# Floating HUD: Win32 layered window rendered with Direct2D/DirectWrite.
add_library(rtai_overlay STATIC
    src/overlay_window.cpp
    src/screen_capture.cpp
)

target_include_directories(rtai_overlay PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

target_link_libraries(rtai_overlay PUBLIC rtai_core PRIVATE d2d1 dwrite user32 gdi32 windowscodecs ole32 oleaut32)

set_target_properties(rtai_overlay PROPERTIES FOLDER "ui")
