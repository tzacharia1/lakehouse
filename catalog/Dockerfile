# The published fixture has no Postgres JDBC driver (Iceberg issue 14802).
# Its entrypoint only puts iceberg-rest-adapter.jar on the classpath.
FROM apache/iceberg-rest-fixture:latest

USER root
COPY entrypoint.sh /usr/lib/iceberg-rest/entrypoint.sh
RUN curl -fsSL -o /usr/lib/iceberg-rest/postgresql.jar \
        https://jdbc.postgresql.org/download/postgresql-42.7.8.jar \
    && chown iceberg:iceberg /usr/lib/iceberg-rest/postgresql.jar \
        /usr/lib/iceberg-rest/entrypoint.sh \
    && chmod 755 /usr/lib/iceberg-rest/entrypoint.sh
USER iceberg

HEALTHCHECK --start-period=25s --interval=5s --timeout=5s --retries=12 \
  CMD curl --fail http://localhost:8181/v1/config || exit 1
