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
    "465dc942bf05eda6cdfef5855c03964d436ff9f0"
    CACHE STRING
    "Pinned fiber-gateway-cpp revision")
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

FetchContent_Declare(
    fiber_gateway_cpp
    URL
        "https://codeload.github.com/fiber-net-gateway/fiber-gateway-cpp/tar.gz/${AI_GATEWAY_FIBER_GATEWAY_REF}"
    URL_HASH
        SHA256=905199acb1424bdddc9e5056b2a231113e3d7824cdca059305fdead2b85b15a8
    PATCH_COMMAND
        git apply --no-index --whitespace=nowarn
        "${CMAKE_CURRENT_SOURCE_DIR}/patches/fiber-gateway-cpp-gcc13-json-constexpr.patch"
        COMMAND
        git apply --no-index --whitespace=nowarn
        "${CMAKE_CURRENT_SOURCE_DIR}/patches/fiber-gateway-cpp-codeload-urls.patch")
FetchContent_MakeAvailable(fiber_gateway_cpp)

if (FIBER_BUILD_TESTS)
    enable_testing()
endif()

# ai-server is owned by this repository. Pull in only the upstream libraries it
# consumes instead of building the upstream copy of apps/ai-server.
add_subdirectory(
    "${fiber_gateway_cpp_SOURCE_DIR}/apps/nacos"
    "${CMAKE_BINARY_DIR}/fiber-apps/nacos")
add_subdirectory(
    "${fiber_gateway_cpp_SOURCE_DIR}/apps/cat"
    "${CMAKE_BINARY_DIR}/fiber-apps/cat")
add_subdirectory(
    "${fiber_gateway_cpp_SOURCE_DIR}/apps/prometheus"
    "${CMAKE_BINARY_DIR}/fiber-apps/prometheus")

add_subdirectory(ai-server)
