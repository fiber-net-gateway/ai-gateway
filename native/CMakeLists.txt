cmake_minimum_required(VERSION 4.1)

option(FIBER_USE_LIBCXX "Use libc++ with Clang toolchains" OFF)
if (FIBER_USE_LIBCXX)
    # fiber-gateway-cpp normally selects this before its top-level project().
    # This repository is now the top-level project, so select libc++ here.
    string(APPEND CMAKE_CXX_FLAGS_INIT " -stdlib=libc++")
endif()

project(ai_gateway_native LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

set(AI_GATEWAY_FIBER_GATEWAY_REF
    "0c56be5fc9e9e106a45b219e49739fedfbaf31b1"
    CACHE STRING
    "Pinned fiber-gateway-cpp revision")
set(AI_GATEWAY_FIBER_GATEWAY_SHA256
    "498f62fdbd2f859537e75476717f7c676b3a22f58a9186b1aca31e236109bbcf"
    CACHE STRING
    "SHA-256 of the pinned fiber-gateway-cpp source archive")
set(AI_SERVER_AUDIT_TRANSPORT
    "HTTP"
    CACHE STRING
    "ai-server audit transport: FILE or HTTP")
set_property(CACHE AI_SERVER_AUDIT_TRANSPORT PROPERTY STRINGS FILE HTTP)

if (NOT AI_SERVER_AUDIT_TRANSPORT STREQUAL "FILE" AND
    NOT AI_SERVER_AUDIT_TRANSPORT STREQUAL "HTTP")
    message(FATAL_ERROR "AI_SERVER_AUDIT_TRANSPORT must be FILE or HTTP")
endif()

set(FIBER_BUILD_APPS OFF CACHE BOOL "" FORCE)
set(FIBER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(FIBER_BUILD_NACOS ON CACHE BOOL "" FORCE)
set(FIBER_BUILD_CAT ON CACHE BOOL "" FORCE)
set(FIBER_BUILD_PROMETHEUS ON CACHE BOOL "" FORCE)
set(FIBER_BUILD_CAT_DEMO OFF CACHE BOOL "" FORCE)
set(FIBER_BUILD_PROMETHEUS_BENCHMARK OFF CACHE BOOL "" FORCE)

# Debug builds skip LTO so fiber targets are plain ELF and link with any
# system linker (GNU ld). Release keeps fiber-gateway-cpp's LTO default (ON);
# its thin-LTO objects are LLVM bitcode, so link with lld (see build flags).
if (CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(FIBER_ENABLE_LTO OFF CACHE BOOL "" FORCE)
endif()

FetchContent_Declare(
    fiber_gateway_cpp
    URL
        "https://codeload.github.com/fiber-net-gateway/fiber-gateway-cpp/tar.gz/${AI_GATEWAY_FIBER_GATEWAY_REF}"
    URL_HASH
        SHA256=${AI_GATEWAY_FIBER_GATEWAY_SHA256})
FetchContent_MakeAvailable(fiber_gateway_cpp)

if (FIBER_BUILD_TESTS)
    enable_testing()
endif()

add_subdirectory(ai-server)
