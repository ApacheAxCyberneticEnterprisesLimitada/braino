# syntax=docker/dockerfile:1

FROM rust:1.100.0-bookworm AS build
WORKDIR /source/services/plugin-host
COPY services/plugin-host/Cargo.toml services/plugin-host/Cargo.lock ./
COPY services/plugin-host/src ./src
COPY packages/plugin-runtime/wit /source/packages/plugin-runtime/wit
RUN cargo build --locked --release

FROM debian:bookworm-slim AS runtime
ENV PORT=8080
WORKDIR /app
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /source/services/plugin-host/target/release/braino-plugin-host /usr/local/bin/braino-plugin-host
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=4 \
  CMD ["braino-plugin-host", "healthcheck"]
ENTRYPOINT ["braino-plugin-host"]
