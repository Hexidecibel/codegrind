FROM node:22-slim

# The harness is baked into the image for fast cold start. User code + tests are
# bind-mounted read-only at /work at run time.
WORKDIR /app
COPY runner.mjs /app/runner.mjs

# Run as the built-in unprivileged `node` user (defense in depth alongside the
# --cap-drop / --read-only / --network none flags passed by bin/run-submission).
USER node

ENTRYPOINT []
CMD ["node", "/app/runner.mjs"]
