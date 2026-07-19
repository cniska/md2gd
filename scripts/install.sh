#!/usr/bin/env sh
# Download the latest prebuilt md2gd binary for this platform, verify its
# checksum, and install it to ~/.local/bin. Usage:
#   curl -fsSL https://raw.githubusercontent.com/cniska/md2gd/main/scripts/install.sh | sh
set -eu

REPO="cniska/md2gd"
INSTALL_DIR="${HOME}/.local/bin"

main() {
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$platform" in
    darwin | linux) ;;
    *) echo "Unsupported platform: $platform" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  case "${platform}-${arch}" in
    linux-x64|darwin-arm64) ;;
    *) echo "No prebuilt binary for ${platform}-${arch}. Build from source with Bun (see README)." >&2; exit 1 ;;
  esac

  asset="md2gd-${platform}-${arch}.tar.gz"

  echo "Fetching latest release..."
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d '"' -f 4)"
  if [ -z "$tag" ]; then
    echo "Failed to fetch latest release (has one been published yet?)" >&2
    exit 1
  fi

  url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
  echo "Downloading ${tag} for ${platform}/${arch}..."

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  curl -fsSL "$url" -o "${tmpdir}/${asset}"

  sha_url="https://github.com/${REPO}/releases/download/${tag}/${asset%.tar.gz}.sha256"
  if curl -fsSL "$sha_url" -o "${tmpdir}/checksum.sha256" 2>/dev/null; then
    expected="$(cut -d ' ' -f 1 "${tmpdir}/checksum.sha256")"
    if command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "${tmpdir}/${asset}" | cut -d ' ' -f 1)"
    elif command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "${tmpdir}/${asset}" | cut -d ' ' -f 1)"
    else
      actual=""
    fi
    if [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
      echo "Checksum mismatch: expected ${expected}, got ${actual}" >&2
      exit 1
    fi
  fi

  tar xzf "${tmpdir}/${asset}" -C "$tmpdir"
  mkdir -p "$INSTALL_DIR"
  mv "${tmpdir}/md2gd" "${INSTALL_DIR}/md2gd"
  chmod +x "${INSTALL_DIR}/md2gd"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    shell_config=""
    case "${SHELL:-}" in
      */zsh) shell_config="${HOME}/.zshrc" ;;
      */bash)
        if [ -f "${HOME}/.bashrc" ]; then
          shell_config="${HOME}/.bashrc"
        elif [ -f "${HOME}/.bash_profile" ]; then
          shell_config="${HOME}/.bash_profile"
        fi
        ;;
    esac
    if [ -n "$shell_config" ] && ! grep -q "${INSTALL_DIR}" "$shell_config" 2>/dev/null; then
      printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$shell_config"
      echo "Added ${INSTALL_DIR} to PATH in ${shell_config} (restart your shell)."
    else
      echo "Add ${INSTALL_DIR} to your PATH manually."
    fi
  fi

  echo ""
  echo "md2gd ${tag} installed to ${INSTALL_DIR}/md2gd"
  echo "Next: md2gd init --client <client_secret.json>  (see the README for Google setup)"
}

main
