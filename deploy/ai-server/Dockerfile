# syntax=docker/dockerfile:1.7

FROM ubuntu:24.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
ARG FIBER_GATEWAY_REF=465dc942bf05eda6cdfef5855c03964d436ff9f0
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      ninja-build \
      perl \
      python3 \
      python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir cmake==4.1.2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --filter=blob:none https://github.com/fiber-net-gateway/fiber-gateway-cpp.git . \
    && git checkout --detach "${FIBER_GATEWAY_REF}"
RUN cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DFIBER_BUILD_EXAMPLES=OFF \
      -DFIBER_BUILD_TESTS=OFF \
      -DFIBER_ENABLE_LTO=OFF \
    && cmake --build build --target ai_server --parallel

FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gettext-base \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin ai-server \
    && install -d -o ai-server -g ai-server /etc/ai-server /var/log/ai-server
COPY --from=build /src/build/apps/ai-server /usr/local/bin/ai-server
COPY deploy/ai-server/ai-server.env.template /etc/ai-server/ai-server.env.template
COPY deploy/ai-server/logging.json /etc/ai-server/logging.json
COPY deploy/ai-server/entrypoint.sh /usr/local/bin/ai-server-entrypoint
RUN chmod 0755 /usr/local/bin/ai-server /usr/local/bin/ai-server-entrypoint \
    && chown ai-server:ai-server /etc/ai-server/ai-server.env.template /etc/ai-server/logging.json
USER ai-server
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ai-server-entrypoint"]
