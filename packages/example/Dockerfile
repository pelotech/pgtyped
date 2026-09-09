ARG NODE_IMAGE

FROM $NODE_IMAGE

RUN echo "Using Node.js version: $(node --version)"

RUN apk add --update --no-cache postgresql-client git

ADD packages/example/scripts/wait-for-postgres-then /usr/local/bin/

WORKDIR /app

# Install inside the image rather than reusing the host's node_modules. Some
# dependencies ship platform-specific native binaries — rolldown, which vitest
# builds on, is one — and a macOS install is not loadable under linux/musl.
# compose mounts anonymous volumes over every node_modules pnpm creates — the
# root store and each package's link farm — so the bind mount of the source
# tree cannot shadow what we install here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/example/package.json ./packages/example/
COPY packages/runtime/package.json ./packages/runtime/
# corepack shipped with Node through 25 but was removed in 26, and the image's
# Node version is a build arg. Fall back to a global install pinned to the same
# version the root package.json's packageManager field names.
RUN corepack enable 2>/dev/null \
  || npm i -g "pnpm@$(node -p "require('./package.json').packageManager.split('@').pop()")"
RUN pnpm install --frozen-lockfile

WORKDIR /app/packages/example

RUN git config --global --add safe.directory /app

ENTRYPOINT ["wait-for-postgres-then"]
