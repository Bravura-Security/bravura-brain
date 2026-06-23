# gbrain production image — Bun-compiled binary with embedded /admin SPA.
# Build sequence per gbrain: install deps, build+embed admin, then compile.
FROM oven/bun:1.3-debian AS build
WORKDIR /app

# Root deps first (better layer caching)
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile || bun install

# Admin SPA deps
COPY admin/package.json admin/bun.lock* admin/
RUN cd admin && bun install || true

# Source
COPY . .

# Build + embed the admin SPA, then compile the self-contained binary.
RUN cd admin && bun run build && cd .. \
 && bun run scripts/build-admin-embedded.ts \
 && bun build --compile --outfile bin/gbrain src/cli.ts

# ---- runtime ----
FROM oven/bun:1.3-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/gbrain /usr/local/bin/gbrain
ENV HOME=/home/bun \
    GBRAIN_HOME=/home/bun/.gbrain
RUN mkdir -p /home/bun/.gbrain && chown -R bun:bun /home/bun
USER bun
EXPOSE 3131
ENTRYPOINT ["gbrain"]
