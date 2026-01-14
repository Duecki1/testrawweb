FROM rust:latest AS build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
COPY static ./static
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd -m app && mkdir -p /data && chown -R app:app /data
WORKDIR /app
COPY --from=build /app/target/release/raw-manager /app/raw-manager
COPY --from=build /app/static /app/static
ENV RAW_MANAGER_DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
USER app
CMD ["/app/raw-manager"]
