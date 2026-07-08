# Homebase brain (homebase --serve) for Railway.
# Dockerfile instead of Nixpacks so we control the runtime (current Bun, not the
# EOL Node 18 Nixpacks defaults to) and so secrets are injected at RUNTIME by
# Railway — never baked into image layers as ENV.
FROM oven/bun:1

WORKDIR /app

# Install deps first (cached until the lockfile changes).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production=false

# App source.
COPY . .

# Railway provides PORT at runtime; the server reads it (defaults to 8080).
EXPOSE 8080

CMD ["bun", "run", "homebase.ts", "--serve"]
