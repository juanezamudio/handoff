/**
 * Workers get an auto-assigned name. Nobody types anything on stage — the join
 * flow has to be scan → tap → done, or half the room never makes it in.
 */
const ADJECTIVES = [
  "swift", "calm", "bright", "clever", "bold", "quiet", "sharp", "keen",
  "brave", "warm", "quick", "steady", "lucky", "sly", "eager", "noble",
];

const ANIMALS = [
  "otter", "falcon", "heron", "lynx", "marten", "raven", "tapir", "vixen",
  "badger", "osprey", "ibis", "shrew", "gannet", "stoat", "kite", "wren",
];

export function generateName(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const a = ADJECTIVES[Math.abs(h) % ADJECTIVES.length];
  const n = ANIMALS[Math.abs(h >> 5) % ANIMALS.length];
  return `${a} ${n}`;
}
