#!/usr/bin/env bash
# tdrive CLI installer.
#
#   curl -fsSL https://raw.githubusercontent.com/davis7dotsh/aDrive/main/scripts/install-cli.sh | bash
#
# Installs the latest stable release (or $TDRIVE_CLI_VERSION, e.g.
# cli-v0.1.0) into ~/.tdrive/bin with SHA-256 verification. No sudo, no
# PATH edits unless invoked with --modify-path.
#
# Trust model: this script and the checksums it verifies both come from
# the GitHub repo over TLS — the checksums defend against corruption and
# single-asset tampering, not a full repo compromise. Auditors: the
# script is short; read it before piping to bash if that's your policy.
# A release-pinned copy is published (and checksummed) with every
# release: https://github.com/davis7dotsh/aDrive/releases
set -euo pipefail

REPO="davis7dotsh/aDrive"
INSTALL_DIR="${TDRIVE_INSTALL_DIR:-${HOME}/.tdrive/bin}"
# INSTALL_DIR is interpolated into shell profile lines and a fish -c
# call; rather than escaping for three shell dialects, refuse the
# characters that would let a hostile value corrupt or hijack them.
# Spaces are fine — every interpolation site quotes the path — so a
# home folder with a space installs normally. Colons break PATH entries.
case "${INSTALL_DIR}" in
*[\"\'\`\$\\:]*)
  printf 'tdrive install: TDRIVE_INSTALL_DIR must not contain quotes, backslashes, $, backticks, or colons\n' >&2
  exit 1
  ;;
esac
MODIFY_PATH=0
[[ "${1:-}" == "--modify-path" ]] && MODIFY_PATH=1

say() { printf '\033[1mtdrive install:\033[0m %s\n' "$*"; }
die() {
  printf '\033[1mtdrive install:\033[0m %s\n' "$*" >&2
  exit 1
}

# --- prerequisites -----------------------------------------------------------
command -v curl >/dev/null || die "curl is required"

command -v node >/dev/null || die "Node.js >= 20 is required but was not found.
  macOS:  brew install node
  Linux:  https://nodejs.org/en/download/package-manager
  Any:    https://nodejs.org/en/download"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[[ "${NODE_MAJOR}" -ge 20 ]] || die "Node.js >= 20 is required (found $(node --version)). Upgrade via your package manager or https://nodejs.org"

if command -v shasum >/dev/null; then
  SHA_CMD=(shasum -a 256)
elif command -v sha256sum >/dev/null; then
  SHA_CMD=(sha256sum)
else
  die "Neither shasum nor sha256sum is available for checksum verification"
fi

# --- resolve release ---------------------------------------------------------
# List releases and pick the newest cli-v* tag: /releases/latest returns
# the newest release of ANY kind, and the repo also publishes app releases.
TAG="${TDRIVE_CLI_VERSION:-}"
if [[ -z "${TAG}" ]]; then
  TAG="$(curl -fsSL -H 'accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/releases?per_page=100" |
    node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
	// Stable versions only: pre-release builds (cli-v1.2.3-rc.1) must
	// never win the default install; pin one via TDRIVE_CLI_VERSION.
	const tags = JSON.parse(d)
		.map((r) => r.tag_name)
		.filter(
			(t) =>
				typeof t === "string" && /^cli-v\d+\.\d+\.\d+$/.test(t)
		);
	if (tags.length === 0) process.exit(1);
	const key = (t) => t.slice(5).split(".").map(Number);
	tags.sort((a, b) => {
		const [am, an, ap] = key(a), [bm, bn, bp] = key(b);
		return bm - am || bn - an || bp - ap;
	});
	console.log(tags[0]);
});')" ||
    die "Could not resolve the latest CLI release from GitHub"
fi
case "${TAG}" in
cli-v*) ;;
*) die "Release tag '${TAG}' does not look like a CLI release (expected cli-vX.Y.Z)" ;;
esac
VERSION="${TAG#cli-v}"
# TDRIVE_BASE_URL exists for testing the installer against a local mock.
BASE_URL="${TDRIVE_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
say "installing tdrive v${VERSION} from ${TAG}"

# --- download and verify -----------------------------------------------------
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

curl -fsSL -o "${WORK_DIR}/tdrive.mjs" "${BASE_URL}/tdrive.mjs" ||
  die "Could not download tdrive.mjs from ${BASE_URL}"
curl -fsSL -o "${WORK_DIR}/checksums.txt" "${BASE_URL}/checksums.txt" ||
  die "Could not download checksums.txt from ${BASE_URL}"

EXPECTED="$(awk '$2 == "tdrive.mjs" { print $1 }' "${WORK_DIR}/checksums.txt")"
[[ -n "${EXPECTED}" ]] || die "checksums.txt has no entry for tdrive.mjs"
ACTUAL="$("${SHA_CMD[@]}" "${WORK_DIR}/tdrive.mjs" | awk '{ print $1 }')"
[[ "${EXPECTED}" == "${ACTUAL}" ]] ||
  die "Checksum mismatch for tdrive.mjs (expected ${EXPECTED}, got ${ACTUAL}). Aborting."
say "checksum verified"

# --- install -----------------------------------------------------------------
# Stage under temporary names and verify the new bundle actually runs
# BEFORE swapping it in, so a broken download can never clobber a
# working installation.
mkdir -p "${INSTALL_DIR}"
# The staged name must keep the .mjs extension — Node refuses to load
# ESM from an unknown extension like .new.
install -m 0755 "${WORK_DIR}/tdrive.mjs" "${INSTALL_DIR}/.staged-tdrive.mjs"
cat >"${INSTALL_DIR}/.staged-tdrive" <<'LAUNCHER'
#!/usr/bin/env bash
# Resolve symlinks portably: BSD readlink (macOS < 12.3) has no -f, so
# walk the link chain by hand before locating the sibling bundle.
source_path="$0"
while [ -L "$source_path" ]; do
	link_target="$(readlink "$source_path")"
	case "$link_target" in
		/*) source_path="$link_target" ;;
		*) source_path="$(dirname "$source_path")/$link_target" ;;
	esac
done
exec node "$(cd "$(dirname "$source_path")" && pwd)/tdrive.mjs" "$@"
LAUNCHER
chmod 0755 "${INSTALL_DIR}/.staged-tdrive"

STAGED_VERSION="$(node "${INSTALL_DIR}/.staged-tdrive.mjs" --version 2>/dev/null | head -1)" || {
  rm -f "${INSTALL_DIR}/.staged-tdrive.mjs" "${INSTALL_DIR}/.staged-tdrive"
  die "Downloaded CLI failed to run; existing installation left untouched"
}
mv "${INSTALL_DIR}/.staged-tdrive.mjs" "${INSTALL_DIR}/tdrive.mjs"
mv "${INSTALL_DIR}/.staged-tdrive" "${INSTALL_DIR}/tdrive"
say "installed: ${STAGED_VERSION} -> ${INSTALL_DIR}/tdrive"

# --- PATH --------------------------------------------------------------------
case ":${PATH}:" in
*":${INSTALL_DIR}:"*)
  say "ready — run: tdrive login <your-drive-url>"
  ;;
*)
  SHELL_NAME="$(basename "${SHELL:-}")"
  PROFILE=""
  case "${SHELL_NAME}" in
  zsh) PROFILE="${HOME}/.zshrc" ;;
  bash) PROFILE="${HOME}/.bashrc" ;;
  esac
  EXPORT_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
  if [[ "${MODIFY_PATH}" == "1" && "${SHELL_NAME}" == "fish" ]] &&
    command -v fish >/dev/null; then
    fish -c "fish_add_path '${INSTALL_DIR}'"
    say "added ${INSTALL_DIR} to fish's PATH — restart your shell"
  elif [[ "${MODIFY_PATH}" == "1" && -n "${PROFILE}" ]]; then
    printf '\n%s\n' "${EXPORT_LINE}" >>"${PROFILE}"
    say "added ${INSTALL_DIR} to PATH in ${PROFILE} — restart your shell"
  else
    if [[ "${MODIFY_PATH}" == "1" ]]; then
      say "could not determine your shell profile; add tdrive to your PATH:"
    else
      say "add tdrive to your PATH:"
    fi
    if [[ "${SHELL_NAME}" == "fish" ]]; then
      printf '\n  fish_add_path %s\n\n' "${INSTALL_DIR}"
    else
      printf '\n  %s\n\n' "${EXPORT_LINE}"
    fi
    if [[ "${MODIFY_PATH}" != "1" ]]; then
      say "(or re-run with --modify-path to do it automatically)"
    fi
  fi
  ;;
esac
