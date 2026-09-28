#!/usr/bin/with-contenv bashio
# Beacon -- Home Assistant Add-on entry point

if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  # Supervisor options take precedence in the add-on.
  THEME="$(bashio::config 'theme' 2>/dev/null || echo 'skylight')"
  AUTO_DARK_MODE="$(bashio::config 'auto_dark_mode' 2>/dev/null || echo 'true')"
  WEATHER_ENTITY="$(bashio::config 'weather_entity' 2>/dev/null || echo 'weather.home')"
  PHOTO_DIRECTORY="$(bashio::config 'photo_directory' 2>/dev/null || echo '/media/beacon/photos')"
  PHOTO_INTERVAL="$(bashio::config 'photo_interval' 2>/dev/null || echo '30')"
  SCREEN_SAVER_TIMEOUT="$(bashio::config 'screen_saver_timeout' 2>/dev/null || echo '5')"
  export BEACON_PARENT_PIN="$(bashio::config 'parent_pin' 2>/dev/null || true)"
  if [ "${BEACON_PARENT_PIN}" = "null" ]; then
    bashio::log.warning "Legacy parent_pin=null treated as unset; set a PIN to require parent unlock."
    export BEACON_PARENT_PIN=""
  fi
  export BEACON_BLOCKED_ENTITIES="$(bashio::config 'blocked_entities' 2>/dev/null || true)"
  export BEACON_HOST="0.0.0.0"
else
  THEME="${THEME:-skylight}"
  AUTO_DARK_MODE="${AUTO_DARK_MODE:-true}"
  WEATHER_ENTITY="${WEATHER_ENTITY:-weather.home}"
  PHOTO_DIRECTORY="${PHOTO_DIRECTORY:-/media/beacon/photos}"
  PHOTO_INTERVAL="${PHOTO_INTERVAL:-30}"
  SCREEN_SAVER_TIMEOUT="${SCREEN_SAVER_TIMEOUT:-5}"
fi

# Fetch this add-on's own slug from the Supervisor API. /addons/self/* is
# callable with just the base SUPERVISOR_TOKEN, no extra permissions
# needed. Used to build stable /hassio/ingress/<slug> links (e.g. for Kid
# Display) instead of embedding the current session's ephemeral ingress
# token from window.location.href, which breaks (401) once that token
# rotates or is opened from a different session/device.
ADDON_SLUG=""
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  ADDON_SELF_RESPONSE="$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
    http://supervisor/addons/self/info 2>&1)"
  ADDON_SELF_STATUS="$(echo "${ADDON_SELF_RESPONSE}" | tail -n1)"
  ADDON_SELF_BODY="$(echo "${ADDON_SELF_RESPONSE}" | sed '$d')"
  if [ "${ADDON_SELF_STATUS}" = "200" ]; then
    ADDON_SLUG="$(echo "${ADDON_SELF_BODY}" | jq -r '.data.slug // empty' 2>/dev/null || echo '')"
  fi
  if [ -z "${ADDON_SLUG}" ] && [ -n "${SUPERVISOR_TOKEN:-}" ]; then
    bashio::log.warning "Supervisor /addons/self/info returned status ${ADDON_SELF_STATUS}: ${ADDON_SELF_BODY}"
  fi
fi
if [ -z "${ADDON_SLUG}" ]; then
  bashio::log.warning "Could not determine add-on slug from Supervisor — Kid Display links cannot be shared."
else
  bashio::log.info "Add-on slug resolved: ${ADDON_SLUG}"
fi

# The port Home Assistant's ingress proxy connects to: ingress_port in
# config.yaml, or the free port the Supervisor picks when that's 0 (as it
# should be for an add-on on the host's network, where 3000 may be taken).
valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  BEACON_PORT="$(echo "${ADDON_SELF_BODY:-}" | jq -r '.data.ingress_port // empty' 2>/dev/null || true)"
  if ! valid_port "${BEACON_PORT}"; then
    bashio::log.warning "Could not read the ingress port from the Supervisor; using 3000."
    BEACON_PORT=3000
  fi
elif ! valid_port "${BEACON_PORT:-}"; then
  BEACON_PORT=3000
fi
BEACON_PORT="$((10#${BEACON_PORT}))"
export BEACON_PORT
# For the image's HEALTHCHECK.
echo "${BEACON_PORT}" > /tmp/beacon-port

# The AirPlay receiver (airplay.cjs runs UxPlay; the dbus and avahi services
# advertise it and wait for this decision). It needs two things this add-on
# doesn't have, each of which changes what it runs or where, so they're
# left for whoever maintains it to decide on (docs/airplay.md):
# - UxPlay, a separate GPL-3.0 program, in the image (the Dockerfile
#   doesn't build it: nothing to say, then);
# - the host's network (host_network in config.yaml), since iPhones, iPads
#   and Macs find receivers by mDNS on the local network.
AIRPLAY="off"
if [ -n "${SUPERVISOR_TOKEN:-}" ] && command -v uxplay >/dev/null 2>&1 \
  && [ "$(bashio::config 'airplay' 2>/dev/null || echo true)" != "false" ]; then
  if [ "$(echo "${ADDON_SELF_BODY:-}" | jq -r '.data.host_network // false' 2>/dev/null)" = "true" ]; then
    AIRPLAY="on"
  else
    bashio::log.info "AirPlay is off: devices can only find it with the add-on on the host's network (host_network in config.yaml)."
  fi
fi
echo "${AIRPLAY}" > /run/family-airplay

if [ "${AIRPLAY}" = "on" ]; then
  export BEACON_AIRPLAY=1
  BEACON_AIRPLAY_NAME="$(bashio::config 'airplay_name' 2>/dev/null || true)"
  if [ -z "${BEACON_AIRPLAY_NAME}" ] || [ "${BEACON_AIRPLAY_NAME}" = "null" ]; then
    BEACON_AIRPLAY_NAME="Family"
  fi
  export BEACON_AIRPLAY_NAME
  BEACON_AIRPLAY_PASSWORD="$(bashio::config 'airplay_password' 2>/dev/null || true)"
  if [ "${BEACON_AIRPLAY_PASSWORD}" = "null" ]; then
    BEACON_AIRPLAY_PASSWORD=""
  fi
  export BEACON_AIRPLAY_PASSWORD
  # UxPlay runs as the image's airplay user, since it handles whatever any
  # device on the network sends it. Nothing that user can read may tell it
  # the Supervisor token (s6's copy of the environment), the add-on's
  # options (options.json, bashio's cache) or the family's data.
  BEACON_AIRPLAY_UID="$(id -u airplay 2>/dev/null || true)"
  BEACON_AIRPLAY_GID="$(id -g airplay 2>/dev/null || true)"
  export BEACON_AIRPLAY_UID BEACON_AIRPLAY_GID
  umask 077
  chmod 0700 /run/s6/container_environment /tmp/.bashio 2>/dev/null || true
  chmod 0711 /data
  find /data -mindepth 1 -maxdepth 1 ! -name airplay -exec chmod go-rwx {} +
  if [ -n "${BEACON_AIRPLAY_PASSWORD}" ]; then
    bashio::log.info "AirPlay receiver \"${BEACON_AIRPLAY_NAME}\" is on; devices need its password."
  else
    bashio::log.info "AirPlay receiver \"${BEACON_AIRPLAY_NAME}\" is on, open to every device on the network (airplay_password sets a password)."
  fi
else
  unset BEACON_AIRPLAY BEACON_AIRPLAY_NAME BEACON_AIRPLAY_PASSWORD BEACON_AIRPLAY_UID BEACON_AIRPLAY_GID
fi

# The server reaches Home Assistant with the Supervisor token (the browser
# never holds one; see server.js).
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  bashio::log.info "Using the API proxy with the Supervisor token."
elif [ -n "${HA_TOKEN:-}" ] && [ -n "${HA_URL:-}" ]; then
  bashio::log.info "Using the API proxy with standalone Home Assistant credentials."
else
  bashio::log.warning "No Home Assistant credentials. Running in local-only mode."
fi

# The proxy server handles /api/* requests — the browser always uses same-origin.
# ha_url stays empty in the browser even when standalone HA_URL is set.
# The server alone reads HA_URL and HA_TOKEN; neither is sent to the page.

# Generate runtime-config.js using node for proper JSON escaping (prevents injection)
CONFIG_JS="/app/dist/runtime-config.js"
# The options go before `node` so they're in its environment. (They used to
# follow the script, where node only sees them as arguments: every add-on
# option was ignored and runtime-config.js always had the defaults.)
THEME="${THEME}" AUTO_DARK_MODE="${AUTO_DARK_MODE}" WEATHER_ENTITY="${WEATHER_ENTITY}" \
  PHOTO_DIRECTORY="${PHOTO_DIRECTORY}" PHOTO_INTERVAL="${PHOTO_INTERVAL}" \
  SCREEN_SAVER_TIMEOUT="${SCREEN_SAVER_TIMEOUT}" ADDON_SLUG="${ADDON_SLUG}" \
  node -e "
  const config = {
    ha_url: '',
    ha_token: '',
    ha_available: Boolean(process.env.SUPERVISOR_TOKEN || (process.env.HA_URL && process.env.HA_TOKEN)),
    parent_pin_required: Boolean(process.env.BEACON_PARENT_PIN),
    theme: process.env.THEME || 'skylight',
    auto_dark_mode: process.env.AUTO_DARK_MODE !== 'false',
    weather_entity: process.env.WEATHER_ENTITY || 'weather.home',
    photo_directory: process.env.PHOTO_DIRECTORY || '/media/beacon/photos',
    photo_interval: parseInt(process.env.PHOTO_INTERVAL) || 30,
    screen_saver_timeout: parseInt(process.env.SCREEN_SAVER_TIMEOUT) || 5,
    addon_slug: process.env.ADDON_SLUG || '',
  };
  require('fs').writeFileSync(
    '${CONFIG_JS}',
    'window.__BEACON_CONFIG__ = ' + JSON.stringify(config) + ';'
  );
"

# Inject the runtime-config script tag into index.html if not already present
INDEX_HTML="/app/dist/index.html"
if ! grep -q 'runtime-config.js' "${INDEX_HTML}"; then
  sed -i 's|</head>|<script src="./runtime-config.js"></script></head>|' "${INDEX_HTML}"
fi

bashio::log.info "Starting Family server on port ${BEACON_PORT}..."
exec node /app/server.js
