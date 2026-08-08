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
    "0fda7764bf94944aca4b674ab5ab311184703118"
    CACHE STRING
    "Pinned fiber-gateway-cpp revision")
set(AI_GATEWAY_FIBER_GATEWAY_SHA256
    "0326a0aa1b45931d34d49b3355ac1c35e65aa13adb132f313b560430e1e3d2a3"
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
