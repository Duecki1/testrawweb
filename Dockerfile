FROM node:18-slim AS frontend-build
WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./

RUN npm run build

FROM rust:latest AS build
WORKDIR /app

COPY Cargo.toml ./

COPY src ./src

COPY --from=frontend-build /frontend/dist ./static

RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd -m app && mkdir -p /data && chown -R app:app /data
WORKDIR /app
COPY --from=build /app/target/release/raw-manager /app/raw-manager
COPY --from=build /app/static /app/static

RUN chown -R app:app /app
ENV RAW_MANAGER_DATA_DIR=/data
EXPOSE 1234
VOLUME ["/data"]
USER app
CMD ["/app/raw-manager"]