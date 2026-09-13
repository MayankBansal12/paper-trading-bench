#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
sudo -n apt-get install -y bubblewrap libseccomp-dev
mkdir -p .sandbox
gcc -Wall -Werror scripts/sandbox/seccomp.c -lseccomp -o .sandbox/build-seccomp
.sandbox/build-seccomp > .sandbox/seccomp.bpf
/usr/bin/bwrap --version
