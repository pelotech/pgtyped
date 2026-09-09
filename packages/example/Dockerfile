ARG NODE_IMAGE

FROM $NODE_IMAGE

RUN echo "Using Node.js version: $(node --version)"

RUN apk add --update --no-cache postgresql-client git

ADD packages/example/scripts/wait-for-postgres-then /usr/local/bin/

WORKDIR /app

# Install inside the image rather than reusing the host's node_modules. Some
# dependencies ship platform-specific native binaries — rolldown, which vitest
# builds on, is one — and a macOS install is not loadable under linux/musl.
# compose mounts an anonymous volume over /app/node_modules so the bind mount
# of the source tree cannot shadow what we install here.
COPY package.json package-lock.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/example/package.json ./packages/example/
COPY packages/runtime/package.json ./packages/runtime/
RUN npm ci

WORKDIR /app/packages/example

RUN git config --global --add safe.directory /app

ENTRYPOINT ["wait-for-postgres-then"]
