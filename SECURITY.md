# Security Policy

## Supported Versions

Security fixes are made for the [current Family release](https://github.com/f1f1f1f1f1f1/Family/releases). Older versions may not receive fixes; update the add-on or pin a newer published standalone image version.

## Reporting a Vulnerability

If you discover a security vulnerability in this Family fork, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/f1f1f1f1f1f1/Family/security/advisories/new) if available, or contact a repository maintainer privately through GitHub. Include reproduction steps without posting tokens or personal data. The maintainers will coordinate disclosure and a fix.

## Security Considerations

- **Home Assistant add-on:** Access is through authenticated HA ingress only. The Supervisor token stays in the container; the browser receives no HA token. The optional 6–8 digit `parent_pin` defaults to blank: **every authenticated ingress user receives parent access** until you set one. The optional `blocked_entities` CSV defaults to blank (blocks no HA entities). The HA service/path allowlist still restricts available operations; a parent PIN is not a replacement for ingress authentication.
- **AirPlay receiver (add-on):** The add-on runs on the host's network so iPhones, iPads and Macs can find its AirPlay receiver (UxPlay); its web server still accepts only Home Assistant's ingress proxy. UxPlay accepts AirPlay from **any device on the local network** unless `airplay_password` is set, and runs as its own unprivileged user without access to the Supervisor token or family data. `airplay: false` turns it off. See [docs/airplay.md](docs/airplay.md).
- **Standalone Docker:** Supply `HA_URL` and `HA_TOKEN` server-side, require a unique `BEACON_PASSWORD` of at least 16 characters for HTTP Basic (username `beacon`), and optionally set a 6–8 digit `BEACON_PARENT_PIN` and `BEACON_BLOCKED_ENTITIES` CSV to deny specific HA entity IDs. With no parent PIN, everyone with the browser password has parent access; with no blocklist, no valid entity IDs are blocked. Bind the host port to `127.0.0.1`. Basic authentication is not encryption: use an HTTPS reverse proxy for remote access, never an unauthenticated LAN bind. Set `BEACON_HOST=0.0.0.0` only inside the container so the proxy can reach it.
- **Session lifetime:** When a parent PIN is set, its session has an absolute **10-minute** lifetime from PIN unlock; page activity and session polling do not extend it. Without a parent PIN, authenticated users can obtain another parent session automatically. A Kid Display session has a **24-hour sliding** lifetime renewed by its normal session polling. These app cookies do not replace HA ingress authentication or standalone HTTP Basic.
- **Credentials:** Add-on/Docker `runtime-config.js` has empty `ha_url`/`ha_token` and non-secret `ha_available`/`parent_pin_required` Booleans. Neither deployment should include `HA_TOKEN` in the frontend bundle. Never set `VITE_HA_TOKEN`; `VITE_*` values are embedded in browser assets. Direct development/native onboarding may store an HA login on that device (web localStorage or native secure storage).
- **Data and integrations:** Add-on family data is persisted in the add-on data directory, with browser caches for display. HA integrations, including Google services, may communicate with external providers; review their privacy policies separately.

## Best Practices

- Keep Home Assistant and Family updated; use a dedicated, revocable HA token for standalone Docker.
- Keep environment files containing tokens/passwords outside the repository, restrict filesystem permissions, and rotate compromised credentials.
- **Revoke and replace any long-lived HA token used with an older `VITE_HA_TOKEN` build or stored in an older browser login.** The updated server-backed app deletes browser-stored HA credentials on startup, but cannot undo an earlier exposure through a bundle, cache, or device. In Home Assistant, go to your profile's **Security > Long-Lived Access Tokens** and revoke the old token. For Docker, put the replacement only in the server's private `HA_TOKEN` environment file; the add-on uses Supervisor credentials. Direct development/native users should re-enter a replacement through onboarding, never through a `VITE_*` variable.
- Do not expose the add-on port directly; use HA ingress. Do not publish standalone Docker's port on all host interfaces.
- Use HTTPS (including to Home Assistant where possible) for traffic beyond a trusted local host.
