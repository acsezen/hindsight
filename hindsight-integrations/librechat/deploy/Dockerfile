# Build context: the packed addon (hindsight-librechat.tgz), its matching
# package-lock.json, and librechat-source.tar, made with
#   git archive --format=tar "$LIBRECHAT_SOURCE_COMMIT" > librechat-source.tar
# from the LibreChat commit the pinned image was built from. No credentials or
# application configuration belong in the build context.
ARG LIBRECHAT_IMAGE=registry.librechat.ai/librechat-ai/librechat-api@sha256:9cde97da2b504adc90b8b01b606697f1fd6d71e2152345060133c7b41bfabc21
ARG LIBRECHAT_SOURCE_COMMIT=e8f3be08623663d4ad7f7241e693c94469b63bb0
ARG LIBRECHAT_SOURCE_SHA256=e658669f118b777be82807299d6f1b48a7f65bc48d191c19684eb55bb9f59420
ARG CLIENT_PATCH_SHA256=3ccd6381888198cbda554d1d30b8d535ce903ca7e96bba1a9ea5913d4bff3520

# The per-chat Hindsight controls live in the browser bundle, which the pinned
# image ships prebuilt. Rebuild only client/dist from that image's own source
# plus the hash-pinned client patch, on the image's own Node runtime, following
# the client stages of upstream Dockerfile.multi.
FROM ${LIBRECHAT_IMAGE} AS client-build
ARG LIBRECHAT_SOURCE_SHA256
ARG CLIENT_PATCH_SHA256
ENV SCARF_ANALYTICS=false
WORKDIR /build
COPY librechat-source.tar hindsight-librechat.tgz ./
RUN echo "${LIBRECHAT_SOURCE_SHA256}  librechat-source.tar" | sha256sum -c - \
    && tar -xzf hindsight-librechat.tgz package/patches/librechat-v0.8.8-client.patch \
    && echo "${CLIENT_PATCH_SHA256}  package/patches/librechat-v0.8.8-client.patch" | sha256sum -c - \
    && apk add --no-cache git \
    && mkdir src \
    && tar -xf librechat-source.tar -C src \
    && cd src \
    && git apply --check ../package/patches/librechat-v0.8.8-client.patch \
    && git apply ../package/patches/librechat-v0.8.8-client.patch
WORKDIR /build/src
RUN npm ci --no-audit --no-fund \
    && npm run build:data-provider \
    && npm run build:client-package \
    && cd client \
    && NODE_OPTIONS=--max-old-space-size=6144 npm run build

FROM ${LIBRECHAT_IMAGE}
ADD hindsight-librechat.tgz /opt/hindsight-librechat/
COPY package-lock.json /opt/hindsight-librechat/package/package-lock.json
RUN cd /opt/hindsight-librechat/package \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node dist/install.js --root /app --apply \
    && rm -rf /app/client/dist
# Replaced, not merged, so no stale hashed assets of the stock bundle remain.
COPY --from=client-build /build/src/client/dist /app/client/dist

# Inherit the pinned image's command, working directory and runtime user unchanged.
