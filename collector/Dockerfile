# Build the collector statically and ship it on distroless/nonroot so it works
# with the Deployment's runAsNonRoot + readOnlyRootFilesystem security context.
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/collector .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/collector /collector
USER nonroot:nonroot
ENTRYPOINT ["/collector"]
