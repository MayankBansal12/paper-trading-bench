#!/bin/sh
set -eu
# Called by the trusted host runner. No argument or path originates in model output.
# These sources are individually bound; the host repository is never mounted.
filter=$1; runtime_bun=$2; runtime_opencode=$3; setup=$4; gateway=$5; worker=$6; cpu_seconds=$7
exec 3< "$filter"
exec /usr/bin/prlimit --nofile=256:256 --nproc=128:128 --fsize=33554432:33554432 --core=0:0 --cpu="$cpu_seconds:$cpu_seconds" \
 /usr/bin/bwrap --unshare-all --die-with-parent --new-session --uid 1000 --gid 1000 --cap-drop ALL \
 --clearenv --setenv PATH /runtime:/usr/bin --setenv LANG C.UTF-8 \
 --ro-bind /usr/lib /usr/lib --symlink usr/lib /lib --symlink usr/lib64 /lib64 --ro-bind /usr/lib64 /usr/lib64 \
 --proc /proc --dev /dev --size 67108864 --tmpfs /tmp --size 134217728 --tmpfs /work \
 --ro-bind "$setup/readonly-config" /work/config/opencode --ro-bind "$setup/readonly-config" /work/extra-config \
 --dir /etc --ro-bind "$setup/passwd" /etc/passwd --dir /runtime --ro-bind "$runtime_bun" /runtime/bun --ro-bind "$runtime_opencode" /runtime/opencode \
 --ro-bind "$worker" /runtime/worker.ts --ro-bind "$setup/launch.json" /runtime/launch.json \
 --ro-bind "$setup/benchmark-plugin.mjs" /work/benchmark-plugin.mjs \
 --ro-bind "$gateway" /gateway.sock --chdir /work --seccomp 3 \
 /runtime/bun /runtime/worker.ts
