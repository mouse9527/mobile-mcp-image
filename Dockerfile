# mobile-mcp-image: mobile-next/mobile-mcp (unmodified) + adb, ready to drive an Android phone over Wi-Fi adb.
#
# - mobile-mcp: npm @mobilenext/mobile-mcp, every dependency pinned by package-lock.json (version + sha512);
#   brings the static Go binary mobilecli for the target platform
# - adb: Google platform-tools (Apache-2.0, AOSP), pinned by sha256; only needs glibc / libgcc_s
# - runtime: distroless Node.js 22 on Debian 13 — no shell, no package manager; entrypoint is JavaScript
# - no upstream code is modified
#
# Upgrade: see README.md ("Upgrading").

ARG NODE_IMAGE=docker.io/library/node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c

FROM ${NODE_IMAGE} AS build
ARG PLATFORM_TOOLS_VERSION=37.0.1
ARG PLATFORM_TOOLS_SHA256=d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/platform-tools
RUN curl -fsSL --retry 3 -o pt.zip "https://dl.google.com/android/repository/platform-tools_r${PLATFORM_TOOLS_VERSION}-linux.zip" \
 && echo "${PLATFORM_TOOLS_SHA256}  pt.zip" | sha256sum -c - \
 && unzip -q pt.zip platform-tools/adb platform-tools/NOTICE.txt platform-tools/source.properties \
 && mv platform-tools/* . && rmdir platform-tools && rm pt.zip \
 && ./adb version

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no install scripts are needed (mobilecli ships as a prebuilt optional dependency)
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --update-notifier=false \
 && test -x "node_modules/@mobilenext/mobilecli-linux-$(dpkg --print-architecture)/mobilecli-linux-$(dpkg --print-architecture)" \
 && ls node_modules/@mobilenext
COPY entrypoint.js ./

FROM ${RUNTIME_IMAGE}
COPY --from=build /opt/platform-tools /opt/platform-tools
COPY --from=build /app /app
COPY LICENSE NOTICE.md /usr/share/doc/mobile-mcp-image/
WORKDIR /app
USER 1000:1000
ENV HOME=/tmp/home \
    PATH=/opt/platform-tools:/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
    MOBILEMCP_DISABLE_TELEMETRY=1 \
    NODE_ENV=production
EXPOSE 8931
LABEL org.opencontainers.image.source="https://github.com/mouse9527/mobile-mcp-image" \
      org.opencontainers.image.description="mobile-next/mobile-mcp 1.0.12 (unmodified) + adb platform-tools 37.0.1" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0"
ENTRYPOINT ["/nodejs/bin/node", "/app/entrypoint.js"]
