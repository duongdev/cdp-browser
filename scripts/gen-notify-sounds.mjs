// Generates 3 short notification chime WAV files into chat/public/sounds/.
// Pure Node stdlib — no npm deps. PCM 16-bit mono 44100 Hz.
// Run: node scripts/gen-notify-sounds.mjs
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "chat", "public", "sounds")
mkdirSync(OUT, { recursive: true })

const SAMPLE_RATE = 44100

/** Build a raw PCM Int16 sine with exponential decay. */
function sine(freqHz, durationMs, decayRate = 8) {
  const samples = Math.floor((SAMPLE_RATE * durationMs) / 1000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE
    const envelope = Math.exp(-decayRate * t)
    const sample = Math.round(32767 * envelope * Math.sin(2 * Math.PI * freqHz * t))
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
  }
  return buf
}

/** Wrap raw PCM in a RIFF/WAV header. */
function wav(pcm) {
  const dataLen = pcm.length
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + dataLen, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write("data", 36)
  header.writeUInt32LE(dataLen, 40)
  return Buffer.concat([header, pcm])
}

const CHIMES = [
  { name: "chime-1", freq: 660, ms: 300, decay: 10 },
  { name: "chime-2", freq: 880, ms: 250, decay: 10 },
  { name: "chime-3", freq: 523, ms: 350, decay: 8 },
]

for (const { name, freq, ms, decay } of CHIMES) {
  const file = join(OUT, `${name}.wav`)
  writeFileSync(file, wav(sine(freq, ms, decay)))
  console.log(`wrote ${file}`)
}
