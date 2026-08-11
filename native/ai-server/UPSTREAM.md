# Upstream provenance

The initial `native/ai-server` source was imported from
`fiber-net-gateway/fiber-gateway-cpp/apps/ai-server` at revision
`465dc942bf05eda6cdfef5855c03964d436ff9f0`.

The application is maintained in this repository. The underlying Fiber runtime,
Nacos, CAT, and Prometheus modules remain pinned CMake dependencies configured by
`native/CMakeLists.txt`. Preserve `LICENSE.upstream` when synchronizing code.

The current reusable-module integration targets upstream revision
`b6ee98d1775b7766fc0758ee8351c81fd1ec6475`, which contains the component CMake
interfaces introduced by [fiber-gateway-cpp PR #20][fiber-pr-20] and the
string-based Nacos server-host API. This runtime dependency pin is independent
of the historical ai-server source-import revision above.

[fiber-pr-20]: https://github.com/fiber-net-gateway/fiber-gateway-cpp/pull/20
