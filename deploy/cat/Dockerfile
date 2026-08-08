FROM meituaninc/cat:3.0.1
ADD --checksum=sha256:5bba9ff50e5e637a0996a730619dee19ccae274883a4d28c890d945252bb0e12 \
  https://repo1.maven.org/maven2/mysql/mysql-connector-java/5.1.49/mysql-connector-java-5.1.49.jar \
  /tmp/cat-connector/WEB-INF/lib/mysql-connector-java-5.1.49.jar
COPY deploy/cat/client.xml /data/appdatas/cat/client.xml
COPY deploy/cat/entrypoint.sh /usr/local/bin/cat-entrypoint
RUN apk add --no-cache zip \
    && zip -d /usr/local/tomcat/webapps/cat.war \
      WEB-INF/lib/mysql-connector-java-5.1.20.jar \
    && cd /tmp/cat-connector \
    && zip -g /usr/local/tomcat/webapps/cat.war \
      WEB-INF/lib/mysql-connector-java-5.1.49.jar \
    && cd / \
    && rm -rf /tmp/cat-connector \
    && apk del zip \
    && chmod 0755 /usr/local/bin/cat-entrypoint /usr/local/tomcat/datasources.sh
ENTRYPOINT ["/usr/local/bin/cat-entrypoint"]
