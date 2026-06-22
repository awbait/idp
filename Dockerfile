# syntax=docker/dockerfile:1

# 1) Build the SPA bundle on the build platform (native) once; the static output
#    is arch-independent and reused for every target arch.
FROM --platform=$BUILDPLATFORM oven/bun:1-alpine AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# 2) Cross-compile the Go portal with the SPA embedded (web/dist ->
#    internal/spa/dist). Building on the build platform with GOOS/GOARCH (CGO is
#    off) cross-compiles natively, so a multi-arch build avoids QEMU emulation.
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /web/dist ./internal/spa/dist
# Build metadata for the "About" page; pass --build-arg at release time. VERSION
# defaults to "dev"; COMMIT/DATE are optional (the build context usually omits
# .git, so VCS stamping is unavailable here - inject them explicitly to populate
# the page).
ARG VERSION=dev
ARG COMMIT=
ARG DATE=
# -tags prod excludes the test-only dev authenticator (internal/auth/dev.go) from
# the shipped binary, so the X-Dev-Role header cannot grant roles in production.
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -tags prod \
	-ldflags="-s -w -X console/internal/buildinfo.Version=${VERSION} -X console/internal/buildinfo.Commit=${COMMIT} -X console/internal/buildinfo.Date=${DATE}" \
	-o /out/portal ./cmd/portal

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/portal /portal
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/portal"]
