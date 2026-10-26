# App version for the native build.
#
#   RTAI_VERSION_STRING  full semver of this build (2.1.0, 2.1.0-beta.3). CI
#                        passes the version it is releasing. Empty = the
#                        project() version plus "+dev.<commit>" build metadata,
#                        so a local build never claims to be a release.
#   RTAI_GIT_COMMIT      commit the build comes from (empty = asked to git when
#                        CMake configures).
#
# Provides rtai::version (generated rtai/version.hpp) and RTAI_VERSION_* vars
# for the Windows VERSIONINFO resource.
include_guard(GLOBAL)

set(RTAI_VERSION_STRING "" CACHE STRING "Full app version (semver). Empty = project version + dev build metadata")
set(RTAI_GIT_COMMIT "" CACHE STRING "Commit of this build. Empty = read from git at configure time")

set(_rtai_commit "${RTAI_GIT_COMMIT}")
if (NOT _rtai_commit)
    find_package(Git QUIET)
    if (GIT_FOUND)
        execute_process(COMMAND "${GIT_EXECUTABLE}" rev-parse --short=7 HEAD
            WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
            OUTPUT_VARIABLE _rtai_commit OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
    endif()
endif()
string(SUBSTRING "${_rtai_commit}" 0 7 _rtai_commit_short)

if (RTAI_VERSION_STRING)
    set(RTAI_VERSION_FULL "${RTAI_VERSION_STRING}")
elseif (_rtai_commit_short)
    set(RTAI_VERSION_FULL "${PROJECT_VERSION}+dev.${_rtai_commit_short}")
else()
    set(RTAI_VERSION_FULL "${PROJECT_VERSION}+dev")
endif()

if (NOT RTAI_VERSION_FULL MATCHES "^([0-9]+)\\.([0-9]+)\\.([0-9]+)(-([0-9A-Za-z.-]+))?(\\+[0-9A-Za-z.-]+)?$")
    message(FATAL_ERROR "RTAI_VERSION_STRING '${RTAI_VERSION_FULL}' is not a semantic version (X.Y.Z[-pre][+build])")
endif()
set(RTAI_VERSION_MAJOR "${CMAKE_MATCH_1}")
set(RTAI_VERSION_MINOR "${CMAKE_MATCH_2}")
set(RTAI_VERSION_PATCH "${CMAKE_MATCH_3}")
set(RTAI_VERSION_PRERELEASE "${CMAKE_MATCH_5}")

# 4th Windows file-version field: the pre-release number (2.1.0-beta.3 ->
# 2.1.0.3), 0 for a release.
set(RTAI_VERSION_BUILD 0)
if (RTAI_VERSION_PRERELEASE MATCHES "([0-9]+)$")
    set(RTAI_VERSION_BUILD "${CMAKE_MATCH_1}")
endif()
if (RTAI_VERSION_PRERELEASE OR RTAI_VERSION_FULL MATCHES "\\+dev")
    set(RTAI_VERSION_IS_PRERELEASE true)
else()
    set(RTAI_VERSION_IS_PRERELEASE false)
endif()
set(RTAI_VERSION_COMMIT "${_rtai_commit_short}")

if (RTAI_VERSION_STRING)
    string(REGEX REPLACE "[-+].*$" "" _rtai_core_version "${RTAI_VERSION_STRING}")
    if (NOT _rtai_core_version VERSION_EQUAL PROJECT_VERSION)
        message(STATUS "RealTimeAI: building ${RTAI_VERSION_FULL} (CMakeLists.txt says ${PROJECT_VERSION})")
    endif()
endif()
message(STATUS "RealTimeAI version: ${RTAI_VERSION_FULL}")

set(_rtai_gen "${PROJECT_BINARY_DIR}/generated/include")
configure_file("${CMAKE_CURRENT_LIST_DIR}/version.hpp.in" "${_rtai_gen}/rtai/version.hpp" @ONLY)

add_library(rtai_version INTERFACE)
add_library(rtai::version ALIAS rtai_version)
target_include_directories(rtai_version INTERFACE "${_rtai_gen}")

unset(_rtai_gen)
unset(_rtai_commit)
unset(_rtai_commit_short)
unset(_rtai_core_version)
