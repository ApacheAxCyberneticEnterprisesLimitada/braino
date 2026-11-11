# syntax=docker/dockerfile:1

FROM rust:1.99.1-bookworm AS build
WORKDIR /source
COPY services/codelinker/Cargo.toml services/codelinker/Cargo.lock ./
COPY services/codelinker/src ./src
RUN cargo build --locked --release

FROM debian:bookworm-slim AS runtime
ENV PORT=8080
WORKDIR /app
COPY --from=build /source/target/release/braino-codelinker /usr/local/bin/braino-codelinker
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=4 \
  CMD ["braino-codelinker", "healthcheck"]
ENTRYPOINT ["braino-codelinker"]
