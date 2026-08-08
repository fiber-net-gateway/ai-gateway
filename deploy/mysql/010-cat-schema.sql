CREATE DATABASE IF NOT EXISTS cat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cat;
SOURCE /opt/cat/CatApplication.sql;

UPDATE config
SET content = REPLACE(
  REPLACE(content, '<server id="127.0.0.1">', '<server id="172.28.0.20">'),
  'name="remote-servers" value="127.0.0.1:8080"',
  'name="remote-servers" value="172.28.0.20:8080"'
)
WHERE name = 'server-config';
