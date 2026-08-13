# codegrind sandbox runner — Python
#
# BUILD CONTEXT IS `test-harness/`, NOT THIS DIRECTORY:
#
#   docker build -t codegrind-runner-python:latest \
#     -f test-harness/python/Dockerfile test-harness
#
# (bin/build-runner-image does exactly that.) Docker forbids `COPY ../…`, so a
# per-language context could not reach conformance/, and every language needs
# the same fixture — it is the only thing keeping three hand-written deepEqual
# implementations in agreement. One context up, one -f down.

FROM python:3.12-slim

# The harness is baked into the image for fast cold start. User code + tests are
# bind-mounted read-only at /work at run time.
WORKDIR /app
COPY python/runner.py /app/runner.py

# The shared equality/serialization spec. Baked in rather than mounted so
# `--selftest` tests the IMAGE — the thing that will actually run submissions —
# rather than whatever happens to be in the working tree.
COPY conformance/ /app/conformance/

# Never write a .pyc. The container is --read-only with a tmpfs on /tmp only, so
# a write attempt next to runner.py fails; more importantly a stale cached
# bytecode file is one more thing that could differ between the image that
# passed --selftest and the image that runs a submission.
ENV PYTHONDONTWRITEBYTECODE=1
# Unbuffered: the payload is written with os.write(1, …) so this is belt and
# braces, but a solution that prints during a run should not have its output
# stranded in a buffer when the outer `timeout` kills the container.
ENV PYTHONUNBUFFERED=1

# python:3.12-slim ships no unprivileged application user of its own (unlike the
# node images' `node`), so `nobody` — present in every Debian base — is the one
# to use. Defense in depth alongside the --cap-drop / --read-only / --network
# none flags passed by bin/run-submission.
USER nobody

ENTRYPOINT []
CMD ["python3", "/app/runner.py"]
