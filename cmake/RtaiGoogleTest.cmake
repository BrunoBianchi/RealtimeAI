# GoogleTest for every test directory: the system/vcpkg package when present,
# otherwise a shallow clone of the pinned release tag.
include_guard(GLOBAL)

set(RTAI_GTEST_VERSION "1.15.2" CACHE STRING "GoogleTest release used when no system package is found")

if (NOT TARGET GTest::gtest)
    find_package(GTest CONFIG QUIET)
endif()

if (NOT TARGET GTest::gtest)
    include(FetchContent)
    FetchContent_Declare(googletest
        GIT_REPOSITORY https://github.com/google/googletest.git
        GIT_TAG "v${RTAI_GTEST_VERSION}"
        GIT_SHALLOW TRUE)
    # Same CRT as the project on MSVC; no install rules, no gmock (unused).
    set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
    set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
    set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(googletest)
    foreach (_t gtest gtest_main)
        if (TARGET ${_t})
            set_target_properties(${_t} PROPERTIES FOLDER "third_party")
        endif()
    endforeach()
endif()

include(GoogleTest)
