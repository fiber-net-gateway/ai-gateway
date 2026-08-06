# syntax=docker/dockerfile:1.7

FROM mysql:8.0.36
ADD --checksum=sha256:a5b3351ffe1ef0e33e9f14c352fdfa6b6dd82156ee09c7c927ef80aec4666a21 \
  https://raw.githubusercontent.com/dianping/cat/e815e74d4c2dd74edac831241f1253fcc7d25381/script/CatApplication.sql \
  /opt/cat/CatApplication.sql
COPY deploy/mysql/010-cat-schema.sql /docker-entrypoint-initdb.d/010-cat-schema.sql
