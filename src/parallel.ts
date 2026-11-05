/**
 * Processamento paralelo com worker_threads (Etapa 5).
 *
 * O arquivo é dividido em K faixas de bytes, uma por núcleo. Cada fronteira é
 * movida para o início da primeira linha de um NOVO timestamp, então cada grupo
 * de timestamp fica inteiro em uma única faixa e nenhum encontro se perde ou
 * se duplica. Cada worker roda o mesmo motor (`detectRange`) na sua faixa, e
 * a thread principal concatena os resultados na ordem das faixas.
 *
 * Arquivos pequenos usam o motor sequencial: criar workers custa dezenas de ms,
 * mais do que o processamento inteiro deles.
 */
import fs from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { compareEncounters } from './detector';
import { detectEncountersFast, detectRange } from './engine';
import { Encounter } from './types';

/**
 * Abaixo deste tamanho, o paralelismo não compensa: cada worker precisa iniciar
 * e aquecer o próprio JIT. Medido: o ds5 (53 MB) fica ~40% mais lento em
 * paralelo, enquanto o ds6 (423 MB) e o ds7 (638 MB) ficam 2-3x mais rápidos.
 */
export const PARALLEL_THRESHOLD_BYTES = 128 << 20; // 128 MB

const NL = 10;
const QUOTE = 34;

interface RangeTask {
  file: string;
  start: number;
  end: number;
}

/** Lê os bytes de [pos, pos+len) do arquivo. */
function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.allocUnsafe(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

/** Extrai o timestamp (3º campo, entre aspas) da linha em buf[lineStart..]. */
function timestampAt(buf: Buffer, lineStart: number): string | null {
  const q1 = buf.indexOf(QUOTE, lineStart);
  if (q1 < 0) return null;
  const q2 = buf.indexOf(QUOTE, q1 + 1);
  if (q2 < 0) return null;
  return buf.toString('latin1', q1 + 1, q2);
}

/**
 * Retorna a posição (>= offset) do início da primeira linha cujo timestamp é
 * diferente do da linha anterior, ou seja, uma fronteira de tick. Retorna o
 * tamanho do arquivo se não houver fronteira depois de `offset`.
 */
export function findTickBoundary(fd: number, offset: number, size: number): number {
  let window = 64 * 1024;
  for (;;) {
    const buf = readAt(fd, offset, Math.min(window, size - offset));
    // Início da primeira linha completa a partir de offset.
    const firstNl = buf.indexOf(NL);
    if (firstNl < 0) {
      if (offset + buf.length >= size) return size;
      window *= 2;
      continue;
    }
    let lineStart = firstNl + 1;
    let prevTs: string | null = null;
    while (lineStart < buf.length) {
      const nl = buf.indexOf(NL, lineStart);
      if (nl < 0) break; // linha incompleta na janela
      const ts = timestampAt(buf.subarray(0, nl), lineStart);
      if (prevTs !== null && ts !== prevTs) return offset + lineStart;
      prevTs = ts;
      lineStart = nl + 1;
    }
    if (offset + buf.length >= size) return size;
    window *= 2; // um tick maior que a janela: tenta com uma janela maior
  }
}

/** Divide o arquivo em até `parts` faixas alinhadas a fronteiras de timestamp. */
export function splitRanges(file: string, parts: number): RangeTask[] {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const cuts = [0];
    for (let k = 1; k < parts; k++) {
      const cut = findTickBoundary(fd, Math.floor((size * k) / parts), size);
      if (cut > cuts[cuts.length - 1] && cut < size) cuts.push(cut);
    }
    cuts.push(size);
    const ranges: RangeTask[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) ranges.push({ file, start: cuts[k], end: cuts[k + 1] });
    return ranges;
  } finally {
    fs.closeSync(fd);
  }
}

function runWorker(task: RangeTask): Promise<Encounter[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: task });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker terminou com código ${code}`));
    });
  });
}

export function defaultThreads(): number {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

/**
 * Detecta os encontros do arquivo, em paralelo quando o arquivo é grande.
 * `threads` = 1 força o modo sequencial.
 */
export async function detectEncounters(
  file: string,
  threads = defaultThreads(),
  minParallelBytes = PARALLEL_THRESHOLD_BYTES,
): Promise<Encounter[]> {
  const size = fs.statSync(file).size;
  if (threads <= 1 || size < minParallelBytes) return detectEncountersFast(file);

  const ranges = splitRanges(file, threads);
  const results = await Promise.all(ranges.map(runWorker));
  return results.flat().sort(compareEncounters);
}

// Código executado dentro do worker.
if (!isMainThread && parentPort) {
  const { file, start, end } = workerData as RangeTask;
  parentPort.postMessage(detectRange(file, start, end));
}
