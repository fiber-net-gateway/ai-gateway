# Upstream provenance

The initial `native/ai-server` source was imported from
`fiber-net-gateway/fiber-gateway-cpp/apps/ai-server` at revision
`465dc942bf05eda6cdfef5855c03964d436ff9f0`.

The application is maintained in this repository. The underlying Fiber runtime,
Nacos, CAT, and Prometheus modules remain pinned CMake dependencies configured by
`native/CMakeLists.txt`. Preserve `LICENSE.upstream` when synchronizing code.
