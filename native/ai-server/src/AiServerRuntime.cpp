#include "AiServerRuntime.h"
#include "DnsSetup.h"
#include "observability/AiServerLogCategories.h"
#include "server/InitialConfigStartupGate.h"

#include <cerrno>
#include <new>
#include <sys/socket.h>
#include <utility>

#include <fiber/async/Spawn.h>
#include <fiber/common/Assert.h>
#include <fiber/dns/DnsClient.h>
#include <fiber/log/Log.h>

namespace fiber::ai_server {
namespace {

DEFINE_LOGGER(LOG_LIFECYCLE, kAiServerLifecycleLogger);

constexpr std::string_view kConsoleApiService = "ai-server-console-api";
constexpr std::string_view kConsoleApiGroup = "AI-GATEWAY";

AiServerRuntimeError create_error(AiServerRuntimeErrorCode code, nacos::NacosCreateError error) noexcept {
    return AiServerRuntimeError{
            .code = code,
            .create_error = error.code,
    };
}

AiServerRuntimeError dns_error() noexcept {
    return AiServerRuntimeError{
            .code = AiServerRuntimeErrorCode::CreateDnsResolver,
            .io_error = common::IoErr::Invalid,
            .message = "failed to initialize DNS resolver",
    };
}

AiServerRuntimeError io_error(AiServerRuntimeErrorCode code, common::IoErr error) noexcept {
    return AiServerRuntimeError{
            .code = code,
            .io_error = error,
    };
}

AiServerRuntimeError config_error(nacos::ConfigServiceError error) {
    return AiServerRuntimeError{
            .code = AiServerRuntimeErrorCode::StartConfigManager,
            .io_error = error.io_error,
            .config_error = error.code,
            .message = std::move(error.message),
    };
}

AiServerRuntimeError naming_error(nacos::NamingServiceError error) {
    return AiServerRuntimeError{
            .code = AiServerRuntimeErrorCode::StartRateLimitCluster,
            .io_error = error.io_error,
            .naming_error = error.code,
            .message = std::move(error.message),
    };
}

common::IoResult<std::uint16_t> bound_port(int fd) noexcept {
    sockaddr_storage storage{};
    socklen_t length = sizeof(storage);
    if (::getsockname(fd, reinterpret_cast<sockaddr *>(&storage), &length) != 0) {
        return std::unexpected(common::io_err_from_errno(errno));
    }
    net::SocketAddress address;
    if (!net::SocketAddress::from_sockaddr(reinterpret_cast<sockaddr *>(&storage), length, address)) {
        return std::unexpected(common::IoErr::Invalid);
    }
    return address.port();
}

} // namespace

std::expected<std::unique_ptr<AiServerRuntime>, AiServerRuntimeError>
AiServerRuntime::create(event::EventLoop &accept_loop, event::EventLoop &nacos_loop, event::EventLoop &cat_loop,
                        event::EventLoopGroup &http_workers, const AiServerConfig &config,
                        std::size_t audit_max_record_bytes, log::AppenderId audit_appender_id,
                        const net::ListenOptions &listen_options) {
    // One process-wide DNS cache shared by the provider worker resolvers and the Nacos
    // resolver. The Nacos resolver stack enables hostname (not just IP literal) Nacos
    // servers. Init is state-setting (no in-loop requirement) so it runs here before the
    // event loops start; the resolver fds are created and registered lazily on first use.
    RuntimeDns dns;
    dns.cache = std::make_unique<dns::SharedDnsCache2>();
    dns.cache_loop = http_workers.size() > 0 ? &http_workers.at(0) : &nacos_loop;
    if (!dns.cache->init(*dns.cache_loop)) {
        leak_dns(dns);
        return std::unexpected(dns_error());
    }

    dns::DnsClient::Options client_options;
    FIBER_ASSERT(client_options.nameservers.add(read_system_nameserver()));
    client_options.timeout = std::chrono::milliseconds(2000);
    client_options.attempts = 2;

    dns.nacos_local = std::make_unique<dns::DnsResolverLocal>();
    if (!dns.nacos_local->init(nacos_loop, *dns.cache, client_options)) {
        leak_dns(dns);
        return std::unexpected(dns_error());
    }
    dns.nacos_resolver = std::make_unique<dns::DnsResolver>();
    if (!dns.nacos_resolver->init(*dns.nacos_local)) {
        leak_dns(dns);
        return std::unexpected(dns_error());
    }
    dns.nacos_address_resolver = std::make_unique<dns::AddressResolver>();
    if (!dns.nacos_address_resolver->init(*dns.nacos_resolver)) {
        leak_dns(dns);
        return std::unexpected(dns_error());
    }

    auto client = nacos::NacosClient::create(nacos_loop, *dns.nacos_address_resolver, config.nacos_config());
    if (!client) {
        leak_dns(dns);
        return std::unexpected(create_error(AiServerRuntimeErrorCode::CreateNacosClient, client.error()));
    }
    auto service = nacos::ConfigService::create(**client);
    if (!service) {
        leak_dns(dns);
        return std::unexpected(create_error(AiServerRuntimeErrorCode::CreateConfigService, service.error()));
    }
    auto naming = nacos::NamingService::create(**client);
    if (!naming) {
        leak_dns(dns);
        return std::unexpected(create_error(AiServerRuntimeErrorCode::CreateNamingService, naming.error()));
    }
    std::unique_ptr<cat::CatClient> cat_client;
    if (config.cat_config()) {
        auto created = cat::CatClient::create(cat_loop, *config.cat_config());
        if (!created) {
            leak_dns(dns);
            return std::unexpected(AiServerRuntimeError{
                    .code = AiServerRuntimeErrorCode::CreateCatClient,
                    .io_error = common::IoErr::Invalid,
                    .message = "failed to create CAT client",
            });
        }
        cat_client = std::move(*created);
    }
#if AI_SERVER_AUDIT_HTTP
    std::unique_ptr<LlmAuditHttpSender> audit_sender;
    if (!config.audit_delivery_options().ingest_token.empty()) {
        try {
            audit_sender = std::make_unique<LlmAuditHttpSender>(config.audit_delivery_options());
        } catch (...) {
            return std::unexpected(AiServerRuntimeError{
                    .code = AiServerRuntimeErrorCode::AllocateRuntime,
                    .create_error = nacos::NacosCreateErrorCode::NoMem,
                    .message = "failed to allocate audit HTTP sender",
            });
        }
    } else {
        LOG(LOG_LIFECYCLE, ERROR) << "HTTP audit transport disabled because AUDIT_INGEST_TOKEN is empty";
    }
#endif
    auto runtime = std::unique_ptr<AiServerRuntime>(new (std::nothrow) AiServerRuntime(
            accept_loop, nacos_loop, cat_loop, http_workers, config.listen_address(), listen_options,
            config.initial_config_timeout(), config.advertise_address(), std::string(config.service_name()),
            std::string(config.service_group()), config.nacos_cluster(), std::move(dns), std::move(cat_client),
#if AI_SERVER_AUDIT_HTTP
            std::move(audit_sender),
#endif
            audit_max_record_bytes, audit_appender_id, std::move(*client), std::move(*service), std::move(*naming)));
    if (!runtime) {
        leak_dns(dns);
        return std::unexpected(AiServerRuntimeError{
                .code = AiServerRuntimeErrorCode::AllocateRuntime,
                .create_error = nacos::NacosCreateErrorCode::NoMem,
        });
    }
    return runtime;
}

void AiServerRuntime::leak_dns(RuntimeDns &dns) noexcept {
    // SharedDnsCache2::shutdown() and DnsResolverLocal::release() must run on their
    // owning event loops, which are not started yet during create(). On a startup
    // failure the process is exiting anyway, so intentionally leak the objects
    // instead of hitting their in-loop destructor assertions.
    (void) dns.cache.release();
    (void) dns.nacos_local.release();
    (void) dns.nacos_resolver.release();
    (void) dns.nacos_address_resolver.release();
}

AiServerRuntime::AiServerRuntime(event::EventLoop &accept_loop, event::EventLoop &nacos_loop,
                                 event::EventLoop &cat_loop, event::EventLoopGroup &http_workers,
                                 net::SocketAddress listen_address, net::ListenOptions listen_options,
                                 std::chrono::milliseconds initial_config_timeout, net::IpAddress advertise_address,
                                 std::string service_name, std::string service_group, std::string nacos_cluster,
                                 RuntimeDns dns, std::unique_ptr<cat::CatClient> cat_client,
#if AI_SERVER_AUDIT_HTTP
                                 std::unique_ptr<LlmAuditHttpSender> audit_sender,
#endif
                                 std::size_t audit_max_record_bytes, log::AppenderId audit_appender_id,
                                 std::unique_ptr<nacos::NacosClient> nacos_client,
                                 std::unique_ptr<nacos::ConfigService> config_service,
                                 std::unique_ptr<nacos::NamingService> naming_service) noexcept :
    accept_loop_(&accept_loop), nacos_loop_(&nacos_loop), cat_loop_(&cat_loop),
    listen_address_(std::move(listen_address)), listen_options_(std::move(listen_options)),
    initial_config_timeout_(initial_config_timeout), advertise_address_(std::move(advertise_address)),
    cat_client_(std::move(cat_client)), nacos_client_(std::move(nacos_client)),
    config_service_(std::move(config_service)), naming_service_(std::move(naming_service)),
#if AI_SERVER_AUDIT_HTTP
    audit_sender_(std::move(audit_sender)),
#endif
    config_manager_(nacos_loop, *config_service_, *naming_service_), dns_(std::move(dns)),
    server_(accept_loop, http_workers, *dns_.cache, cat_client_.get(), audit_max_record_bytes, audit_appender_id
#if AI_SERVER_AUDIT_HTTP
            ,
            audit_sender_.get()
#endif
                    ),
    rate_limit_membership_(nacos_loop, *naming_service_, server_.rate_limit_ring(), std::move(service_name),
                           std::move(service_group), std::move(nacos_cluster)) {
    FIBER_ASSERT(nacos_client_ != nullptr);
    FIBER_ASSERT(config_service_ != nullptr);
    FIBER_ASSERT(naming_service_ != nullptr);
    FIBER_ASSERT(dns_.cache != nullptr);
    FIBER_ASSERT(dns_.cache_loop != nullptr);
    FIBER_ASSERT(accept_loop_ != nacos_loop_);
    FIBER_ASSERT(accept_loop_ != cat_loop_);
    FIBER_ASSERT(nacos_loop_ != cat_loop_);
    for (std::size_t i = 0; i < http_workers.size(); ++i) {
        FIBER_ASSERT(&http_workers.at(i) != nacos_loop_);
        FIBER_ASSERT(&http_workers.at(i) != cat_loop_);
    }
    nacos_start_publisher_ = nacos_start_status_.acquire_publisher();
    FIBER_ASSERT(nacos_start_publisher_.has_value());
    cluster_start_publisher_ = cluster_start_status_.acquire_publisher();
    FIBER_ASSERT(cluster_start_publisher_.has_value());
    cat_start_publisher_ = cat_start_status_.acquire_publisher();
    FIBER_ASSERT(cat_start_publisher_.has_value());
    nacos_stopped_publisher_ = nacos_stopped_.acquire_publisher();
    FIBER_ASSERT(nacos_stopped_publisher_.has_value());
    cat_stopped_publisher_ = cat_stopped_.acquire_publisher();
    FIBER_ASSERT(cat_stopped_publisher_.has_value());
}

AiServerRuntime::~AiServerRuntime() {
    FIBER_ASSERT(state_ == AiServerRuntimeState::Created || state_ == AiServerRuntimeState::Stopped);
    FIBER_ASSERT(nacos_start_tasks_.empty());
    FIBER_ASSERT(cluster_start_tasks_.empty());
    FIBER_ASSERT(cat_start_tasks_.empty());
    // In the Created state the DNS objects were never released on their owning
    // loops (which may never have run), so their in-loop destructor assertions
    // would fire. The owner is tearing down; leak them like create() failures.
    // After Stopped, stop_dns() already released and reset every pointer.
    leak_dns(dns_);
}

async::DetachedTask AiServerRuntime::start_cat() noexcept {
    FIBER_ASSERT(cat_loop_->in_loop());
    const auto started = cat_client_->start();
    if (!started) {
        cat_start_publisher_->publish(CatStartStatus{
                .error = io_error(AiServerRuntimeErrorCode::StartCatClient, started.error()),
        });
    } else {
        LOG(LOG_LIFECYCLE, INFO) << "CAT client started";
        cat_start_publisher_->publish(CatStartStatus{.success = true});
    }
    cat_start_tasks_.done();
    co_return;
}

async::DetachedTask AiServerRuntime::start_nacos() noexcept {
    FIBER_ASSERT(nacos_loop_->in_loop());
    auto client_started = nacos_client_->start();
    if (!client_started) {
        nacos_start_publisher_->publish(NacosStartStatus{
                .error = io_error(AiServerRuntimeErrorCode::StartNacosClient, client_started.error()),
        });
        nacos_start_tasks_.done();
        co_return;
    }
    LOG(LOG_LIFECYCLE, DEBUG) << "Nacos client started";
    auto service_started = config_service_->start();
    if (!service_started) {
        co_await nacos_client_->shutdown();
        nacos_start_publisher_->publish(NacosStartStatus{
                .error = io_error(AiServerRuntimeErrorCode::StartConfigService, service_started.error()),
        });
        nacos_start_tasks_.done();
        co_return;
    }
    LOG(LOG_LIFECYCLE, DEBUG) << "Nacos config service started";
    auto naming_started = naming_service_->start();
    if (!naming_started) {
        co_await config_service_->shutdown();
        co_await nacos_client_->shutdown();
        nacos_start_publisher_->publish(NacosStartStatus{
                .error = io_error(AiServerRuntimeErrorCode::StartNamingService, naming_started.error()),
        });
        nacos_start_tasks_.done();
        co_return;
    }
    LOG(LOG_LIFECYCLE, DEBUG) << "Nacos naming service started";
#if AI_SERVER_AUDIT_HTTP
    if (audit_sender_) {
        auto subscription = naming_service_->subscribe(kConsoleApiService, kConsoleApiGroup,
                                                       &AiServerRuntime::on_console_api_update, this);
        if (subscription) {
            console_api_subscription_ = std::move(*subscription);
            LOG(LOG_LIFECYCLE, INFO) << "subscribed to console API audit endpoints";
        } else {
            LOG(LOG_LIFECYCLE, WARN) << "failed to subscribe to console API audit endpoints code="
                                     << static_cast<int>(subscription.error().code);
        }
    }
#endif
    auto manager_started = config_manager_.start();
    if (!manager_started) {
        console_api_subscription_.close();
#if AI_SERVER_AUDIT_HTTP
        if (audit_sender_) {
            audit_sender_->clear_endpoints();
        }
#endif
        co_await naming_service_->shutdown();
        co_await config_service_->shutdown();
        co_await nacos_client_->shutdown();
        nacos_start_publisher_->publish(NacosStartStatus{
                .error = config_error(std::move(manager_started.error())),
        });
        nacos_start_tasks_.done();
        co_return;
    }
    LOG(LOG_LIFECYCLE, INFO) << "Nacos-backed LLM configuration runtime started";
    nacos_start_publisher_->publish(NacosStartStatus{.success = true});
    nacos_start_tasks_.done();
}

async::DetachedTask AiServerRuntime::start_rate_limit_cluster(std::string advertise_ipv4, std::uint16_t port) noexcept {
    FIBER_ASSERT(nacos_loop_->in_loop());
    auto started = rate_limit_membership_.start(std::move(advertise_ipv4), port);
    if (!started) {
        cluster_start_publisher_->publish(ClusterStartStatus{
                .error = naming_error(std::move(started.error())),
        });
    } else {
        cluster_start_publisher_->publish(ClusterStartStatus{.success = true});
    }
    cluster_start_tasks_.done();
    co_return;
}

async::DetachedTask AiServerRuntime::shutdown_nacos() noexcept {
    FIBER_ASSERT(nacos_loop_->in_loop());
    co_await nacos_start_tasks_.join();
    co_await cluster_start_tasks_.join();
    co_await rate_limit_membership_.shutdown();
    co_await config_manager_.shutdown();
    console_api_subscription_.close();
#if AI_SERVER_AUDIT_HTTP
    if (audit_sender_) {
        audit_sender_->clear_endpoints();
    }
#endif
    co_await naming_service_->shutdown();
    co_await config_service_->shutdown();
    co_await nacos_client_->shutdown();
    LOG(LOG_LIFECYCLE, INFO) << "Nacos-backed LLM configuration runtime stopped";
    nacos_stopped_publisher_->publish(true);
}

async::DetachedTask AiServerRuntime::shutdown_cat() noexcept {
    FIBER_ASSERT(cat_loop_->in_loop());
    co_await cat_start_tasks_.join();
    co_await cat_client_->shutdown();
    LOG(LOG_LIFECYCLE, INFO) << "CAT client stopped";
    cat_stopped_publisher_->publish(true);
}

async::Task<void> AiServerRuntime::stop_nacos() noexcept {
    FIBER_ASSERT(accept_loop_->in_loop());
    auto stopped = nacos_stopped_.subscribe();
    auto snapshot = stopped.current();
    if (!nacos_shutdown_spawned_) {
        nacos_shutdown_spawned_ = true;
        async::spawn(*nacos_loop_, [this]() { return shutdown_nacos(); });
    }
    while (!snapshot.value || !*snapshot.value) {
        snapshot = co_await stopped.next(snapshot.version);
    }
}

async::Task<void> AiServerRuntime::stop_cat() noexcept {
    FIBER_ASSERT(accept_loop_->in_loop());
    if (!cat_client_) {
        co_return;
    }
    auto stopped = cat_stopped_.subscribe();
    auto snapshot = stopped.current();
    if (!cat_shutdown_spawned_) {
        cat_shutdown_spawned_ = true;
        async::spawn(*cat_loop_, [this]() { return shutdown_cat(); });
    }
    while (!snapshot.value || !*snapshot.value) {
        snapshot = co_await stopped.next(snapshot.version);
    }
}

async::Task<void> AiServerRuntime::stop_dns() noexcept {
    FIBER_ASSERT(accept_loop_->in_loop());
    if (!dns_.cache) {
        co_return;
    }
    // Runs after stop_nacos(), so the Nacos resolver is no longer in use. Release the
    // per-loop resolver stack on the Nacos loop, then shut the shared cache down on its
    // owner loop. Worker resolvers were already released by server_.shutdown_and_wait().
    async::WaitGroup release_wg;
    release_wg.add();
    async::spawn(*nacos_loop_, [this, &release_wg]() -> async::DetachedTask {
        if (dns_.nacos_address_resolver) {
            dns_.nacos_address_resolver->release();
        }
        if (dns_.nacos_resolver) {
            dns_.nacos_resolver->release();
        }
        if (dns_.nacos_local) {
            dns_.nacos_local->release();
        }
        release_wg.done();
        co_return;
    });
    co_await release_wg.join();

    async::WaitGroup cache_wg;
    cache_wg.add();
    async::spawn(*dns_.cache_loop, [this, &cache_wg]() -> async::DetachedTask {
        dns_.cache->shutdown();
        cache_wg.done();
        co_return;
    });
    co_await cache_wg.join();
    dns_.cache.reset();
    dns_.nacos_local.reset();
    dns_.nacos_resolver.reset();
    dns_.nacos_address_resolver.reset();
    dns_.cache_loop = nullptr;
}

async::Task<void> AiServerRuntime::fail_start() noexcept {
    FIBER_ASSERT(accept_loop_->in_loop());
    state_ = AiServerRuntimeState::Stopping;
    co_await server_.shutdown_and_wait();
    co_await stop_cat();
#if AI_SERVER_AUDIT_HTTP
    if (audit_sender_) {
        audit_sender_->shutdown();
    }
#endif
    co_await stop_nacos();
    co_await stop_dns();
    state_ = AiServerRuntimeState::Stopped;
}

async::Task<std::expected<void, AiServerRuntimeError>> AiServerRuntime::start() noexcept {
    FIBER_ASSERT(accept_loop_->in_loop());
    FIBER_ASSERT(state_ == AiServerRuntimeState::Created);
    state_ = AiServerRuntimeState::Starting;

#if AI_SERVER_AUDIT_HTTP
    if (audit_sender_ && !audit_sender_->start()) {
        LOG(LOG_LIFECYCLE, ERROR) << "failed to start audit HTTP sender; audit records will be dropped";
    }
#endif

    if (cat_client_) {
        auto cat_status = cat_start_status_.subscribe();
        auto cat_snapshot = cat_status.current();
        cat_start_tasks_.add();
        async::spawn(*cat_loop_, [this]() { return start_cat(); });
        while (!cat_snapshot.value) {
            cat_snapshot = co_await cat_status.next(cat_snapshot.version);
        }
        if (!cat_snapshot.value->success) {
            AiServerRuntimeError error = cat_snapshot.value->error;
            co_await fail_start();
            co_return std::unexpected(std::move(error));
        }
    }

    auto nacos_status = nacos_start_status_.subscribe();
    auto nacos_snapshot = nacos_status.current();
    nacos_start_tasks_.add();
    async::spawn(*nacos_loop_, [this]() { return start_nacos(); });
    while (!nacos_snapshot.value) {
        nacos_snapshot = co_await nacos_status.next(nacos_snapshot.version);
    }
    if (!nacos_snapshot.value->success) {
        AiServerRuntimeError error = nacos_snapshot.value->error;
        co_await fail_start();
        co_return std::unexpected(std::move(error));
    }

    InitialConfigGateResult initial_config =
            co_await wait_for_initial_config(server_.start_config_workers(config_manager_),
                                             config_manager_.subscribe_initial_rejection(), initial_config_timeout_);
    if (initial_config.status != InitialConfigGateStatus::Installed) {
        co_await fail_start();
        switch (initial_config.status) {
            case InitialConfigGateStatus::Rejected:
                FIBER_ASSERT(initial_config.failure != nullptr);
                co_return std::unexpected(AiServerRuntimeError{
                        .code = AiServerRuntimeErrorCode::InitialConfigRejected,
                        .llm_config_failure = std::move(initial_config.failure),
                });
            case InitialConfigGateStatus::Unavailable:
                co_return std::unexpected(AiServerRuntimeError{
                        .code = AiServerRuntimeErrorCode::InitialConfigUnavailable,
                        .io_error = common::IoErr::Canceled,
                        .message = "initial Nacos LLM configuration sync stopped",
                });
            case InitialConfigGateStatus::TimedOut:
                co_return std::unexpected(AiServerRuntimeError{
                        .code = AiServerRuntimeErrorCode::InitialConfigTimeout,
                        .io_error = common::IoErr::TimedOut,
                        .message = "initial Nacos LLM configuration sync timed out",
                });
            case InitialConfigGateStatus::Installed:
                FIBER_PANIC("installed initial configuration entered failure handling");
        }
    }
    LOG(LOG_LIFECYCLE, INFO) << "initial LLM configuration installed on HTTP workers";

    auto bound = server_.bind(listen_address_, listen_options_);
    if (!bound) {
        const common::IoErr error = bound.error();
        co_await fail_start();
        co_return std::unexpected(io_error(AiServerRuntimeErrorCode::Bind, error));
    }

    auto port = bound_port(server_.fd());
    if (!port || *port == 0) {
        const common::IoErr error = port ? common::IoErr::Invalid : port.error();
        co_await fail_start();
        co_return std::unexpected(io_error(AiServerRuntimeErrorCode::Bind, error));
    }
    auto cluster_status = cluster_start_status_.subscribe();
    auto cluster_snapshot = cluster_status.current();
    cluster_start_tasks_.add();
    async::spawn(*nacos_loop_, [this, address = advertise_address_.to_string(), port = *port]() mutable {
        return start_rate_limit_cluster(std::move(address), port);
    });
    while (!cluster_snapshot.value) {
        cluster_snapshot = co_await cluster_status.next(cluster_snapshot.version);
    }
    if (!cluster_snapshot.value->success) {
        AiServerRuntimeError error = cluster_snapshot.value->error;
        co_await fail_start();
        co_return std::unexpected(std::move(error));
    }
    state_ = AiServerRuntimeState::Running;
    async::spawn([this]() { return server_.serve(); });
    co_return std::expected<void, AiServerRuntimeError>{};
}

async::Task<void> AiServerRuntime::shutdown() noexcept {
    FIBER_ASSERT(accept_loop_->in_loop());
    if (state_ == AiServerRuntimeState::Stopped) {
        co_return;
    }
    LOG(LOG_LIFECYCLE, INFO) << "runtime shutdown started";
    if (state_ == AiServerRuntimeState::Created) {
        server_.close();
        co_await stop_cat();
#if AI_SERVER_AUDIT_HTTP
        if (audit_sender_) {
            audit_sender_->shutdown();
        }
#endif
        co_await stop_nacos();
        co_await stop_dns();
        state_ = AiServerRuntimeState::Stopped;
        LOG(LOG_LIFECYCLE, INFO) << "runtime shutdown completed";
        co_return;
    }

    state_ = AiServerRuntimeState::Stopping;
    co_await server_.shutdown_and_wait();
    co_await stop_cat();
#if AI_SERVER_AUDIT_HTTP
    if (audit_sender_) {
        audit_sender_->shutdown();
    }
#endif
    co_await stop_nacos();
    co_await stop_dns();
    state_ = AiServerRuntimeState::Stopped;
    LOG(LOG_LIFECYCLE, INFO) << "runtime shutdown completed";
}

void AiServerRuntime::on_console_api_update(void *context,
                                            const nacos::SubscriptionResult<nacos::ServiceInfo> &result) noexcept {
    auto *runtime = static_cast<AiServerRuntime *>(context);
    FIBER_ASSERT(runtime != nullptr);
    FIBER_ASSERT(runtime->nacos_loop_->in_loop());
#if AI_SERVER_AUDIT_HTTP
    if (!runtime->audit_sender_) {
        return;
    }
    if (result.kind == nacos::ResultKind::Success && result.data) {
        runtime->audit_sender_->update_endpoints(result.data);
    } else {
        runtime->audit_sender_->clear_endpoints();
    }
#endif
}

} // namespace fiber::ai_server
