#!/usr/bin/env bash
# Decode cost inside local workerd (`wrangler dev`). Clocks inside the Worker don't advance during
# synchronous work, so this measures from outside: CPU of every workerd process that this wrangler
# started (wrangler runs two; the one serving the port proxies to the one running the Worker), from
# per-thread schedstat in /proc (nanoseconds), around each request, plus curl's wall time.
# Linux only. Usage: RUNS=5 PORT=8799 bench/workerd-bench.sh file.ogg...
set -euo pipefail

port="${PORT:-8799}"
runs="${RUNS:-5}"
rate="${RATE:-16000}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$root/dist/wav-workerd"
mkdir -p "$out_dir"

pid="$(ss -ltnp | grep -E "127.0.0.1:${port}\b" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
[ -n "$pid" ] || { echo "nothing listening on port $port" >&2; exit 1; }
wrangler_pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
pids="$(pgrep -P "$wrangler_pid" -x workerd | tr '\n' ' ')"
cpu_ns() {
  local p
  for p in $pids; do cat /proc/"$p"/task/*/schedstat 2>/dev/null; done | awk '{ s += $1 } END { printf "%d", s }'
}
cpu_ns_of() { cat /proc/"$1"/task/*/schedstat 2>/dev/null | awk '{ s += $1 } END { printf "%d", s }'; }

echo "workerd pids=$pids(listening: $pid) rate=$rate runs=$runs"
for file in "$@"; do
  name="$(basename "$file" .ogg)"
  for run in $(seq 1 "$runs"); do
    before="$(cpu_ns)"
    wall="$(curl -s -o "$out_dir/$name-$rate.wav" -D "$out_dir/$name-$rate.headers" -w '%{time_total}' \
      --data-binary @"$file" -H 'content-type: audio/ogg' "http://127.0.0.1:$port/decode?rate=$rate")"
    after="$(cpu_ns)"
    status="$(grep "^HTTP" "$out_dir/$name-$rate.headers" | tail -1 | tr -d '\r')"
    clock="$(grep -i '^x-clock-delta-ms' "$out_dir/$name-$rate.headers" | tr -d '\r' | cut -d' ' -f2)"
    printf '%s run=%s status="%s" wall_ms=%.1f workerd_cpu_ms=%.1f wav_bytes=%s in_worker_clock_ms=%s\n' \
      "$name" "$run" "$status" "$(echo "$wall * 1000" | bc -l)" "$(echo "($after - $before) / 1000000" | bc -l)" \
      "$(stat -c %s "$out_dir/$name-$rate.wav")" "$clock"
  done
done
