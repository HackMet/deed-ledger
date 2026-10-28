#!/usr/bin/env bash
# Builds synthetic stand-ins for WhatsApp voice notes: flite text-to-speech over quiet noise, mono,
# 48 kHz, OGG/Opus from libopus. No real voices. Output goes to dist/audio (gitignored).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/dist/audio"
mkdir -p "$out"

cat > "$out/speech.txt" <<'EOF'
Good morning. Twelve boxes of rice arrived from the supplier today, and five bottles of cooking oil.
The invoice says forty dollars for the rice, but I think it was thirty eight. Please check it.
We sold three bags of sugar and two packs of coffee before noon.
How many cans of beans are left on the shelf? I counted nine yesterday.
Correction: it was not ten bottles of soda, it was twelve. Cancel the last entry.
The bread delivery comes on Thursday. Write down six loaves and one box of eggs.
EOF

ffmpeg -y -v error -f lavfi -i "flite=textfile=$out/speech.txt:voice=slt" "$out/speech-16k.wav"

# Speech looped to the target length, upsampled to 48 kHz, with pink noise so there is no digital
# silence (real phones always pick up some room noise).
make_note() {
  local name="$1" seconds="$2" bitrate="$3" application="$4" noise="$5"
  ffmpeg -y -v error -stream_loop -1 -i "$out/speech-16k.wav" \
    -f lavfi -i "anoisesrc=color=${noise}:amplitude=0.02:sample_rate=48000" \
    -filter_complex "[0:a]aresample=48000,aformat=channel_layouts=mono[s];[1:a]aformat=channel_layouts=mono[n];[s][n]amix=inputs=2:duration=first:normalize=0[m]" \
    -map "[m]" -t "$seconds" -ac 1 -ar 48000 \
    -c:a libopus -b:a "$bitrate" -vbr on -application "$application" -frame_duration 20 \
    "$out/$name.ogg"
}

make_note note-5s 5 24k voip pink
make_note note-60s 60 24k voip pink
make_note note-300s 300 24k voip pink
# Stress case: full-band white noise at a high bitrate pushes Opus into CELT/hybrid modes.
make_note stress-300s-64k 300 64k audio white

ls -l "$out"
