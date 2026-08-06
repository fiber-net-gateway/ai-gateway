FROM meituaninc/cat:3.0.1
COPY deploy/cat/client.xml /data/appdatas/cat/client.xml
COPY deploy/cat/entrypoint.sh /usr/local/bin/cat-entrypoint
RUN chmod 0755 /usr/local/bin/cat-entrypoint /usr/local/tomcat/datasources.sh
ENTRYPOINT ["/usr/local/bin/cat-entrypoint"]
