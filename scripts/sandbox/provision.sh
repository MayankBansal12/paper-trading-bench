#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
command -v gcc >/dev/null || { echo "Install GCC and libseccomp-dev first." >&2; exit 1; }
/usr/bin/bwrap --version
mkdir -p .sandbox
gcc -Wall -Werror scripts/sandbox/seccomp.c -lseccomp -o .sandbox/build-seccomp
.sandbox/build-seccomp > .sandbox/seccomp.bpf
