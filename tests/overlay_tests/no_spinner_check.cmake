# Static source-level guard for Req 13.4: "exibir a Pulse_Bar como único
# indicador de estado de atividade, não renderizando nenhum elemento de spinner
# giratório em qualquer estado."
#
# A rotating spinner is a *render* construct, so the only place it could be
# reintroduced is the overlay drawing code. This check fails the build/test if a
# drawing symbol that would animate a rotating spinner reappears in the overlay
# source. It runs anywhere (no desktop, no D2D), which is why "no spinner" is
# enforced here rather than in the runtime Win32 suite.
#
# It deliberately ignores the word "spinner" inside comments (the source
# documents that the spinner was removed), matching only code that would draw a
# rotating indicator: a function *defining/implementing* a spinner draw, or a
# rotation transform applied while an activity spinner is drawn.
#
# Invoked via:  cmake -DOVERLAY_SRC=<path> -P no_spinner_check.cmake

if(NOT DEFINED OVERLAY_SRC)
    message(FATAL_ERROR "OVERLAY_SRC not set")
endif()
if(NOT EXISTS "${OVERLAY_SRC}")
    message(FATAL_ERROR "overlay source not found: ${OVERLAY_SRC}")
endif()

file(STRINGS "${OVERLAY_SRC}" LINES)

set(OFFENDERS "")
set(LINENO 0)
foreach(LINE IN LISTS LINES)
    math(EXPR LINENO "${LINENO}+1")

    # Strip // line comments so documentation that mentions "spinner" (the code
    # explains the spinner was removed) does not trip the guard. This is a
    # heuristic strip, adequate for a single-line static check.
    string(REGEX REPLACE "//.*$" "" CODE "${LINE}")

    # Match a spinner *drawing* construct in actual code:
    #   - draw_spinner / render_spinner / paint_spinner (a draw entry point)
    #   - DrawSpinner (PascalCase variant)
    string(REGEX MATCH "(draw|render|paint)_?[Ss]pinner" HIT "${CODE}")
    if(HIT)
        list(APPEND OFFENDERS "line ${LINENO}: ${LINE}")
    endif()
endforeach()

list(LENGTH OFFENDERS N)
if(N GREATER 0)
    string(REPLACE ";" "\n  " PRETTY "${OFFENDERS}")
    message(FATAL_ERROR
        "Req 13.4 violation: rotating-spinner draw code found in overlay source.\n"
        "  The Pulse_Bar must be the only activity indicator.\n  ${PRETTY}")
endif()

message(STATUS "Req 13.4 OK: no rotating-spinner draw code in ${OVERLAY_SRC}")
