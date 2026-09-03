# syntax=docker/dockerfile:1.7

FROM ubuntu:24.04 AS build
ARG DEBIAN_FRONTEND=noninteractive
ARG FIBER_GATEWAY_REF=1162be70a08521b14744650bffed8e7c1451ff37
ARG FIBER_GATEWAY_SHA256=49625cd9e7ae0d0325b6b2f7d09bd380257f3ea30601375d960e76cb365cc4e0
ARG AI_SERVER_AUDIT_TRANSPORT=HTTP
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      ninja-build \
      perl \
      python3 \
      python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir \
      --timeout 120 \
      --retries 5 \
      cmake==4.1.2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY native /src/native
RUN cmake -S native -B native/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DAI_GATEWAY_FIBER_GATEWAY_REF="${FIBER_GATEWAY_REF}" \
      -DAI_GATEWAY_FIBER_GATEWAY_SHA256="${FIBER_GATEWAY_SHA256}" \
      -DAI_SERVER_AUDIT_TRANSPORT="${AI_SERVER_AUDIT_TRANSPORT}" \
      -DFIBER_BUILD_EXAMPLES=OFF \
      -DFIBER_BUILD_TESTS=OFF \
      -DFIBER_ENABLE_LTO=OFF \
      -DFIBER_USE_LIBCXX=OFF
RUN cmake --build native/build --target fiber_app_ai_server --parallel

FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
ARG AI_SERVER_AUDIT_TRANSPORT=HTTP
ENV AI_SERVER_AUDIT_TRANSPORT=${AI_SERVER_AUDIT_TRANSPORT}
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gettext-base \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin ai-server \
    && install -d -o ai-server -g ai-server /etc/ai-server /var/log/ai-server
COPY --from=build /src/native/build/apps/ai-server /usr/local/bin/ai-server
COPY deploy/ai-server/ai-server.env.template /etc/ai-server/ai-server.env.template
COPY deploy/ai-server/logging.json /etc/ai-server/logging.json
COPY deploy/ai-server/entrypoint.sh /usr/local/bin/ai-server-entrypoint
RUN chmod 0755 /usr/local/bin/ai-server /usr/local/bin/ai-server-entrypoint \
    && chown ai-server:ai-server /etc/ai-server/ai-server.env.template /etc/ai-server/logging.json
USER ai-server
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ai-server-entrypoint"]
