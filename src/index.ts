import path from 'node:path';
import fs from 'node:fs';
import { compareEncounters, detectTick } from './detector';
import { defaultThreads, detectEncounters } from './parallel';
import { forEachTick } from './parser';
import { writeEncounters } from './output';
import { Encounter } from './types';

/** Implementação de referência: simples, legível, O(n²) por tick. */
export async function detectEncountersBaseline(file: string): Promise<Encounter[]> {
  const all: Encounter[] = [];
  await forEachTick(file, (ts, points) => {
    for (const e of detectTick(ts, points)) all.push(e);
  });
  return all.sort(compareEncounters);
}

/** dataset7.txt -> output/respostas7.json */
export function defaultOutput(input: string): string {
  const m = /(\d+)\D*$/.exec(path.basename(input));
  return path.join('output', `respostas${m ? m[1] : path.parse(input).name}.json`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseline = args.includes('--baseline');
  const threadsArg = args.find((a) => a.startsWith('--threads='));
  const threads = args.includes('--sequential')
    ? 1
    : threadsArg
      ? Math.max(1, Number(threadsArg.split('=')[1]) || 1)
      : defaultThreads();
  const [input, outArg] = args.filter((a) => !a.startsWith('--'));
  if (!input) {
    console.error(
      'uso: node dist/src/index.js <dataset.txt> [saida.json] [--threads=N | --sequential | --baseline]',
    );
    process.exit(1);
  }
  const out = outArg ?? defaultOutput(input);
  const t0 = process.hrtime.bigint();
  const encounters = baseline
    ? await detectEncountersBaseline(input)
    : await detectEncounters(input, threads);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeEncounters(out, encounters);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const mode = baseline ? 'baseline' : `até ${threads} thread(s)`;
  console.error(`${input}: ${encounters.length} encontros -> ${out} (${ms.toFixed(1)} ms, ${mode})`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
