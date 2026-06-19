# Build the collector statically and ship it on distroless/nonroot so it works
# with the Deployment's runAsNonRoot + readOnlyRootFilesystem security context.
# Building on the build platform with GOOS/GOARCH (CGO is off) cross-compiles
# natively, so a multi-arch build avoids QEMU emulation.
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/collector .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/collector /collector
USER nonroot:nonroot
ENTRYPOINT ["/collector"]
