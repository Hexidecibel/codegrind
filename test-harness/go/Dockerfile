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
# IT STAYS READ-ONLY AT RUN TIME, AND THAT IS TRUE OF EXACTLY ONE HALF OF WHAT
# GO DOES TO ITS CACHE.
#
# Cache WRITES are best-effort: a submission's own package fails to be stored,
# every stdlib package is still a hit, and nothing complains. That is why the Go
# container needs no writable rootfs and no 42MB copy into a tmpfs per
# submission — it keeps the same hardening every other language gets. The
# numbers, measured INSIDE this sandbox (--read-only, --cpus=1) rather than on a
# dev box: 0.32-0.36s for a never-before-seen solution.go against the baked
# cache, and 10.05s with GOCACHE pointed at an empty tmpfs. The cold number is
# not "slow", it is OVER cgCompileBudget (10s, runner.go) — a fix that gives up
# the warm cache does not trade speed for simplicity, it fails every submission.
#
# The cache TRIM is NOT best-effort, and that is the 24-hour bug. Once per
# trimInterval (24h, cmd/go/internal/cache/cache.go) `go build` calls Trim() on
# the way out, which REWRITES $GOCACHE/trim.txt with the time it ran; the single
# caller — cmd/go/internal/work/exec.go — does
# `base.Fatalf("go: failed to trim cache: %v", err)` when that write fails. This
# image is built root-owned and runs as `nobody`, so the write could not
# succeed, and every image worked for exactly 24 hours from the minute it was
# built and then failed EVERY submission that COMPILES with
#
#     go: failed to trim cache: open /gocache/trim.txt: permission denied
#
# Submissions with compile ERRORS kept passing — go prints its diagnostics
# before it dies — so the symptom read as "only correct Go is broken". And it
# never self-heals: bin/deploy and bin/setup build images that are MISSING, so a
# 24-hour-old image is broken permanently, on this box and on anyone else's.
#
# THE FIX IS THE SYMLINK AT THE END OF THE RUN BELOW. trim.txt is the ONLY file
# in the cache that go must be able to write, so it is pointed at /tmp — the
# tmpfs every runner already gets, writable by `nobody`, and fresh per
# container. The trim then always succeeds no matter how old the image is, and
# the 42MB of cache entries stay exactly as read-only as they were. Cost, again
# measured in the sandbox: 0.34s for a build whose trim actually runs against
# 0.32s for one that skips it — the scan is 256 opendir()s and ~650 stat()s, and
# every unlink() it then attempts fails EROFS, which is precisely what stops a
# trim from evicting a warm cache it has decided is 5 days stale.
#
# TWO THINGS THAT LOOK LIKE FIXES AND ARE NOT:
#   * Baking a FAR-FUTURE trim.txt so the interval check short-circuits. Go
#     anticipates that: `if d := now.Sub(lastTrim); d < trimInterval && d >
#     -mtimeInterval` reads a stamp more than an hour in the future as
#     corruption and trims anyway.
#   * Rebuilding the image more often — a cron, a deploy-time rebuild, a
#     shorter TTL. That resets the clock instead of removing it. The image has
#     to be correct at ANY age, because the next person's bin/setup will build
#     one once and then leave it alone for months.
# There is also no env var or flag that turns trimming off: GOCACHE, GOFLAGS and
# every GODEBUG key in cmd/go/internal/cache were read in this image's own
# toolchain source. GOCACHEPROG can replace the cache wholesale, which is a
# daemon and a protocol to avoid one fatal write.
#
# The image's --selftest gate now forces a 24h-stale stamp and compiles, so a
# build that loses the symlink cannot be published (see cgSelftestCacheTrim in
# runner.go); bin/smoke-go proves the same thing against the image on disk.
#
# One consequence worth knowing: run this image WITHOUT --read-only (a debug
# shell) when it is more than 5 days old and that container's first build really
# will delete the warm cache — in the container's own writable layer. The image
# is untouched; throw the container away.
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

# The last two lines are the 24-hour fix, and they must stay LAST: the `go
# build` and `go vet` above are what create /gocache/trim.txt in the first
# place, so replacing it any earlier would just hand the next command a root
# owned regular file again.
RUN cd /build \
 && cp /app/src/runner.go /app/src/go.mod /build/ \
 && go build -o /app/cgrun . \
 && go vet ./... \
 && rm -rf /build \
 && chmod -R a+rX /gocache /app \
 && rm -f /gocache/trim.txt \
 && ln -s /tmp/cg-gocache-trim.txt /gocache/trim.txt

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
# default tmpfs is mounted noexec. /tmp is now load-bearing for a second reason
# as well — it is where /gocache/trim.txt points — so a Go container started
# WITHOUT a writable /tmp gets both failures at once, and the trim one is fatal.
ENTRYPOINT []
CMD ["/app/cgrun"]
