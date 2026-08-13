# codegrind sandbox runner — JavaScript
#
# BUILD CONTEXT IS `test-harness/`, NOT THIS DIRECTORY:
#
#   docker build -t codegrind-runner-javascript:latest \
#     -f test-harness/javascript/Dockerfile test-harness
#
# (bin/build-runner-image does exactly that.) Docker forbids `COPY ../…`, so a
# per-language context could not reach conformance/, and every language needs
# the same fixture — it is the only thing keeping three hand-written deepEqual
# implementations in agreement. One context up, one -f down.

FROM node:22-slim

# The harness is baked into the image for fast cold start. User code + tests are
# bind-mounted read-only at /work at run time.
WORKDIR /app
COPY javascript/runner.mjs /app/runner.mjs

# The shared equality/serialization spec. Baked in rather than mounted so
# `--selftest` tests the IMAGE — the thing that will actually run submissions —
# rather than whatever happens to be in the working tree.
COPY conformance/ /app/conformance/

# Run as the built-in unprivileged `node` user (defense in depth alongside the
# --cap-drop / --read-only / --network none flags passed by bin/run-submission).
USER node

ENTRYPOINT []
CMD ["node", "/app/runner.mjs"]
