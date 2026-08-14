# codegrind sandbox runner — Go
#
# BUILD CONTEXT IS `test-harness/`, NOT THIS DIRECTORY:
#
#   docker build -t codegrind-runner-go:latest \
#     -f test-harness/go/Dockerfile test-harness
#
# (bin/build-runner-image does exactly that.) Docker forbids `COPY ../…`, so a
# per-language context could not reach conformance/, and every language needs
# the same fixture — it is the only thing keeping three hand-written deepEqual
# implementations in agreement. One context up, one -f down.

FROM golang:1.24-alpine

# THIS IMAGE IS THE ONE THAT COMPILES AT RUN TIME, so it carries both a binary
# and the source that binary re-compiles alongside the user's file:
#
#   /app/src/runner.go   the harness, staged into every build directory
#   /app/src/go.mod      ditto
#   /app/cgrun           the DRIVER, built here so --selftest costs no compile
#
# shim_stub.go is used for the /app/cgrun build only and is NOT copied to
# /app/src — the driver writes the real shim.go beside runner.go per submission,
# and two definitions of cgEntry would be a redeclaration error blamed on the
# candidate's own file.
WORKDIR /app
COPY go/runner.go go/go.mod /app/src/
COPY go/shim_stub.go /build/shim_stub.go

# The shared equality/serialization spec. Baked in rather than mounted so
# `--selftest` tests the IMAGE — the thing that will actually run submissions —
# rather than whatever happens to be in the working tree.
COPY conformance/ /app/conformance/

# Hermetic, network-less, and warm.
#
# GOCACHE=/gocache is the load-bearing one. Go 1.20 stopped shipping the
# standard library as prebuilt archives, so a cold `go build` of a program that
# imports encoding/json + reflect + os/exec compiles the whole dependency
# closure: ~3s, against ~0.1s warm. The cache built by the RUN below is 38MB and
# ships inside the image.
#
# It stays READ-ONLY at run time, and that works: Go treats a cache it cannot
# write as a cache it simply cannot add to, so a submission's own package fails
# to be stored and everything else is still a hit. Measured at 0.11s for a
# never-before-seen solution.go under --read-only. This is why the Go container
# needs no writable rootfs and no 38MB copy into a tmpfs on every submission —
# it keeps the same hardening every other language gets.
#
# GOTOOLCHAIN=local: without it a `go` directive newer than the installed
# toolchain makes go try to DOWNLOAD one, which inside --network none fails as a
# baffling proxy error instead of a version mismatch.
# HOME/GOPATH point into /tmp because the container is --read-only and every
# other default would be an unwritable path under /root or /home.
ENV CGO_ENABLED=0 \
    GOPROXY=off \
    GOFLAGS=-mod=mod \
    GOTOOLCHAIN=local \
    GOCACHE=/gocache \
    GOPATH=/tmp/gopath \
    HOME=/tmp

RUN cd /build \
 && cp /app/src/runner.go /app/src/go.mod /build/ \
 && go build -o /app/cgrun . \
 && go vet ./... \
 && rm -rf /build \
 && chmod -R a+rX /gocache /app

# golang:1.24-alpine ships no unprivileged application user of its own, so
# `nobody` — present in every alpine base — is the one to use. Defense in depth
# alongside the --cap-drop / --read-only / --network none flags passed by
# bin/run-submission.
#
# NOTE FOR THE NEXT COMPILED LANGUAGE: `nobody` cannot traverse the 0700
# directory `mktemp -d` creates, which is why bin/run-submission chmods the work
# dir 0711 and its contents 0644. That fix landed for Python and Go inherits it.
USER nobody

# The container needs `--tmpfs /tmp:exec` (see CG_TMPFS in bin/lib/languages.sh):
# Go must write the linked binary somewhere AND then execute it, and docker's
# default tmpfs is mounted noexec.
ENTRYPOINT []
CMD ["/app/cgrun"]
