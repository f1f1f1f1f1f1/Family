ARG BUILD_FROM=ghcr.io/hassio-addons/base:16.3.2
# UxPlay, the AirPlay receiver (docs/airplay.md): the release built, and the
# SHA-512 of its source archive. 1.73.7 fixed a stack overflow any device on
# the network could cause before pairing (GHSA-479c-ww7g-wgp8).
ARG UXPLAY_VERSION=1.73.7
ARG UXPLAY_SHA512=269efad0ba37698b863a9dbcd2040e5315f4ee1b0e3412617cbebf752711cf7a50b342aacbdc188cc6429a151e292022189307240e8b14962c0622482a250d21

# ---------- Build stage ----------
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html config.yaml tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# ---------- UxPlay stage ----------
# UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0), built from its release
# source once that matches the hash above, on the add-on's own base so it
# links against the libraries the runtime stage installs. NO_MARCH_NATIVE:
# on x86 it would otherwise be built for the building machine's own CPU,
# which a machine a backup is restored onto may lack. Only the program, its
# licences and where its source is reach the add-on.
FROM ${BUILD_FROM} AS uxplay
ARG UXPLAY_VERSION
ARG UXPLAY_SHA512
# The base pins the libcrypto3, libssl3 and musl it was made with, and
# openssl-dev and musl-dev need Alpine's current ones: naming them replaces
# those pins here (the add-on itself keeps the base's).
RUN apk add --no-cache libcrypto3 libssl3 musl \
    build-base cmake pkgconf openssl-dev libplist-dev avahi-dev gstreamer-dev gst-plugins-base-dev
WORKDIR /src
RUN curl -fsSL -o uxplay.tar.gz "https://github.com/FDH2/UxPlay/archive/refs/tags/v${UXPLAY_VERSION}.tar.gz" \
  && echo "${UXPLAY_SHA512}  uxplay.tar.gz" | sha512sum -c - \
  && tar -xzf uxplay.tar.gz \
  && cd "UxPlay-${UXPLAY_VERSION}" \
  && cmake -S . -B build -DNO_MARCH_NATIVE=ON -DNO_X11_DEPS=ON \
  && cmake --build build --parallel "$(nproc)" \
  && strip build/uxplay \
  && install -D -m 755 build/uxplay /usr/local/bin/uxplay \
  && install -D -m 644 LICENSE /usr/share/licenses/uxplay/LICENSE \
  && install -D -m 644 lib/playfair/LICENSE.md /usr/share/licenses/uxplay/playfair-LICENSE.md \
  && install -D -m 644 lib/llhttp/LICENSE-MIT /usr/share/licenses/uxplay/llhttp-LICENSE-MIT \
  && echo "https://github.com/FDH2/UxPlay/archive/refs/tags/v${UXPLAY_VERSION}.tar.gz sha512:${UXPLAY_SHA512}" > /usr/share/licenses/uxplay/SOURCE

# ---------- Runtime stage ----------
FROM ${BUILD_FROM}
ARG UXPLAY_VERSION

# Node.js runs the server. The rest is the AirPlay receiver's: D-Bus and
# Avahi advertise it (Avahi's own SSH and SFTP entries go: the add-on has
# neither), and UxPlay runs with these libraries and GStreamer plugins, as
# the airplay user. Its IDs are fixed so the key UxPlay keeps in /data stays
# its own after an update.
RUN apk add --no-cache nodejs \
    dbus avahi avahi-compat-libdns_sd libplist \
    gstreamer gstreamer-tools gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav \
  && rm -f /etc/avahi/services/*.service \
  && addgroup -S -g 1500 airplay \
  && adduser -S -D -H -u 1500 -G airplay -s /sbin/nologin airplay

COPY --from=uxplay /usr/local/bin/uxplay /usr/local/bin/uxplay
COPY --from=uxplay /usr/share/licenses/uxplay/ /usr/share/licenses/uxplay/
# Fails the build, rather than AirPlay on the device, if UxPlay can't start
# (it needs every library it links) or GStreamer lacks something it uses:
# the plugins it checks for (app, playback, autodetect, libav,
# videoparsersbad) and the elements of its pipelines, with what airplay.cjs
# adds to them.
RUN uxplay -v | grep -F "UxPlay version ${UXPLAY_VERSION};" \
  && for element in appsrc playbin autoaudiosink queue h264parse rtph264pay \
      avdec_aac avdec_alac audioconvert audioresample volume rtpL16pay rtpstreampay fdsink; do \
      GST_REGISTRY=/tmp/gst-registry.bin gst-inspect-1.0 --exists "$element" || { echo "GStreamer element $element is missing" >&2; exit 1; }; \
    done \
  && rm -f /tmp/gst-registry.bin

WORKDIR /app

COPY --from=builder /app/dist/ /app/dist/
COPY --from=builder /app/node_modules/ws/ /app/node_modules/ws/
# The dbus and avahi services start their daemons only while run.sh has the
# AirPlay receiver on (see docs/airplay.md).
COPY rootfs/ /
COPY run.sh /etc/services.d/beacon/run
COPY server.js /app/server.js
COPY server-guards.cjs /app/server-guards.cjs
COPY chores-sync.cjs /app/chores-sync.cjs
COPY airplay.cjs /app/airplay.cjs
COPY airplay-relay.cjs /app/airplay-relay.cjs
RUN chmod a+x /etc/services.d/beacon/run /etc/services.d/dbus/run /etc/services.d/avahi/run

EXPOSE 3000

# run.sh writes the port it serves on (the one ingress was given) there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:$(cat /tmp/beacon-port 2>/dev/null || echo 3000)/beacon-action/health" || exit 1
