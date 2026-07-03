# syntax=docker/dockerfile:1
# OmniKube API image (Go backend: REST + WebSocket). Serves the API on :8080.
# The React UI ships as a separate image (see ../frontend/Dockerfile).
# Build context = backend/:  docker build -t twwch/omnikube:api-dev backend

FROM golang:1.25-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /omnikube ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 omnikube
USER omnikube
WORKDIR /app
COPY --from=build /omnikube /app/omnikube
EXPOSE 8080
# Env-only config (no config.yaml needed):
#   DATABASE_URL (required) · JWT_SECRET ≥32 (required) · MASTER_KEY base64-32 (required)
#   ADMIN_USERNAME (default "admin"; first-login password printed to logs)
ENTRYPOINT ["/app/omnikube"]
