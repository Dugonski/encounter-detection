import fs from 'node:fs';
import readline from 'node:readline';
import { Position } from './types';

const stripQuotes = (s: string): string =>
  s.length >= 2 && s.charCodeAt(0) === 34 ? s.slice(1, -1) : s;

export function parseLine(line: string): { timestamp: string; position: Position } {
  const f = line.split(';');
  const restr = stripQuotes(f[6] ?? '');
  return {
    timestamp: stripQuotes(f[2]),
    position: {
      id: Number(f[0]),
      faction: f[1],
      lat: parseFloat(f[3]),
      lon: parseFloat(f[4]),
      restrictions: f[5] === 'true' && restr !== '' ? restr.split(',').map(Number) : [],
    },
  };
}

/**
 * Lê o dataset em streaming e chama `onTick` uma vez por timestamp, com todas as
 * posições daquele timestamp. Pressupõe o arquivo ordenado por timestamp, como
 * nos datasets fornecidos.
 */
export async function forEachTick(
  file: string,
  onTick: (timestamp: string, points: Position[]) => void,
): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  let header = true;
  let current: string | null = null;
  let points: Position[] = [];
  for await (const line of rl) {
    if (header) { header = false; continue; }
    if (line.length === 0) continue;
    const { timestamp, position } = parseLine(line);
    if (timestamp !== current) {
      if (current !== null) onTick(current, points);
      current = timestamp;
      points = [];
    }
    points.push(position);
  }
  if (current !== null) onTick(current, points);
}
