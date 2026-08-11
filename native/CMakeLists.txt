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
    "b6ee98d1775b7766fc0758ee8351c81fd1ec6475"
    CACHE STRING
    "Pinned fiber-gateway-cpp revision")
set(AI_GATEWAY_FIBER_GATEWAY_SHA256
    "ef3f074c134ea8ca8171e10fb8c7c5a5d115051fd3c1b625db0b8cb8327e231b"
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
