FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1-bookworm AS backend
WORKDIR /build/backend
COPY backend/ ./
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data
WORKDIR /app/backend
COPY --from=backend /build/backend/target/release/thien-an-api /usr/local/bin/thien-an-api
COPY --from=frontend /build/frontend/dist /app/frontend/dist
ENV DATABASE_URL=sqlite:///data/thien-an.db
CMD ["sh", "-c", "THIEN_AN_BIND=\"${THIEN_AN_BIND:-0.0.0.0:${PORT:-8080}}\" exec thien-an-api"]
