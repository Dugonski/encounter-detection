/**
 * Motor otimizado de detecção de encontros.
 *
 * Mesmas regras da baseline (src/parser.ts + src/detector.ts), mas:
 *  1. Lê o arquivo em blocos grandes com readSync e faz o parsing direto dos bytes,
 *     sem criar strings por linha. O timestamp só vira string quando há encontro.
 *  2. Guarda as posições do tick atual em typed arrays reutilizados entre ticks,
 *     sem alocação por linha.
 *  3. Busca pares com sweep por latitude: os pontos ficam ordenados por latitude
 *     e só são comparados enquanto Δlat < janela de 20 m. Como as pessoas se
 *     movem pouco entre ticks, reaproveitar a ordem do tick anterior deixa o
 *     insertion sort praticamente O(n).
 */
import fs from 'node:fs';
import { ENCOUNTER_DISTANCE_M, compareEncounters } from './detector';
import { EARTH_RADIUS_M, haversine } from './geo';
import { Encounter, EncounterType } from './types';

const SEMI = 59; // ;
const QUOTE = 34; // "
const NL = 10; // \n
const CR = 13; // \r
const MINUS = 45; // -
const DOT = 46; // .
const ZERO = 48; // 0
const NINE = 57; // 9
const T = 116; // t

/**
 * Janela de latitude (em graus) para o sweep. A distância de Haversine é sempre
 * >= R * |Δlat em radianos|, então pares com Δlat >= 20 m nunca são encontros.
 * Usamos 10% de margem para não depender de arredondamento.
 */
const LAT_WINDOW_DEG = ((ENCOUNTER_DISTANCE_M / EARTH_RADIUS_M) * 180) / Math.PI * 1.1;

/** Potências de 10 exatas em double, usadas para converter mantissa inteira em decimal. */
const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i);

const CHUNK_SIZE = 8 << 20; // 8 MB

/** Estado do tick atual, em arrays reutilizáveis. */
class TickBuffer {
  count = 0;
  ids = new Int32Array(256);
  factions = new Int32Array(256); // -1 = sem facção
  lats = new Float64Array(256);
  lons = new Float64Array(256);
  restrStart = new Int32Array(256); // fatia em `restr` com os ids de restrição
  restrLen = new Int32Array(256);
  restr = new Int32Array(1024);
  restrCount = 0;

  /** Ordem dos índices por latitude, mantida entre ticks. */
  order = new Int32Array(256);
  orderSize = 0;

  reset(): void {
    this.count = 0;
    this.restrCount = 0;
  }

  ensureCapacity(n: number): void {
    if (n <= this.ids.length) return;
    const cap = Math.max(n, this.ids.length * 2);
    const grow = <A extends Int32Array | Float64Array>(a: A): A => {
      const b = new (a.constructor as { new (n: number): A })(cap);
      b.set(a);
      return b;
    };
    this.ids = grow(this.ids);
    this.factions = grow(this.factions);
    this.lats = grow(this.lats);
    this.lons = grow(this.lons);
    this.restrStart = grow(this.restrStart);
    this.restrLen = grow(this.restrLen);
    this.order = grow(this.order);
  }

  pushRestriction(id: number): void {
    if (this.restrCount === this.restr.length) {
      const b = new Int32Array(this.restr.length * 2);
      b.set(this.restr);
      this.restr = b;
    }
    this.restr[this.restrCount++] = id;
  }

  hasRestriction(i: number, id: number): boolean {
    const end = this.restrStart[i] + this.restrLen[i];
    for (let k = this.restrStart[i]; k < end; k++) if (this.restr[k] === id) return true;
    return false;
  }
}

function classify(t: TickBuffer, i: number, j: number): EncounterType {
  if (t.hasRestriction(i, t.ids[j]) || t.hasRestriction(j, t.ids[i])) return 'protetiva';
  if (t.factions[i] !== -1 && t.factions[i] === t.factions[j]) return 'faccao';
  return 'generico';
}

/** Detecta os encontros do tick atual e os adiciona em `out`. */
function detectTick(t: TickBuffer, timestamp: () => string, out: Encounter[]): void {
  const n = t.count;
  const { lats, lons, ids, order } = t;

  // Reaproveita a ordem do tick anterior se a quantidade de pontos for a mesma.
  if (t.orderSize !== n) {
    for (let k = 0; k < n; k++) order[k] = k;
    t.orderSize = n;
  }
  // Insertion sort por latitude: quase O(n) quando a ordem anterior já está quase certa.
  for (let a = 1; a < n; a++) {
    const idx = order[a];
    const v = lats[idx];
    let b = a - 1;
    while (b >= 0 && lats[order[b]] > v) {
      order[b + 1] = order[b];
      b--;
    }
    order[b + 1] = idx;
  }

  // Sweep: para cada ponto, compara só com os seguintes dentro da janela de latitude.
  for (let a = 0; a < n; a++) {
    const i = order[a];
    const latI = lats[i];
    const limit = latI + LAT_WINDOW_DEG;
    for (let b = a + 1; b < n; b++) {
      const j = order[b];
      if (lats[j] >= limit) break;
      const dist = haversine(latI, lons[i], lats[j], lons[j]);
      if (dist < ENCOUNTER_DISTANCE_M) {
        const [p, q] = ids[i] < ids[j] ? [i, j] : [j, i];
        out.push({
          tipo: classify(t, i, j),
          monitoradosEncontro: [ids[p], ids[q]],
          timestamp: timestamp(),
          posicoes: {
            [ids[p]]: { lat: lats[p], lon: lons[p] },
            [ids[q]]: { lat: lats[q], lon: lons[q] },
          },
          distanciaMetros: dist,
        });
      }
    }
  }
}

/** Processa o arquivo inteiro numa única thread. */
export function detectEncountersFast(file: string): Encounter[] {
  return detectRange(file, 0, Infinity).sort(compareEncounters);
}

/**
 * Detecta os encontros na faixa de bytes [start, rangeEnd) do arquivo.
 *
 * `start` deve ser 0 (o cabeçalho é pulado) ou o início de uma linha, e a faixa
 * deve conter timestamps completos (ver `findTickBoundary` em parallel.ts). Assim
 * nenhum grupo de timestamp fica dividido entre duas faixas. Retorna os encontros
 * na ordem em que aparecem no arquivo.
 */
export function detectRange(file: string, start: number, rangeEnd: number): Encounter[] {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  const out: Encounter[] = [];
  const tick = new TickBuffer();

  // Timestamp do tick atual (bytes copiados, pois o buffer é sobrescrito a cada leitura).
  const curTs = Buffer.alloc(64);
  let curTsLen = -1; // -1 = nenhum tick ainda
  let curTsStr: string | null = null;
  const timestamp = (): string => (curTsStr ??= curTs.toString('latin1', 0, curTsLen));

  const flush = (): void => {
    if (curTsLen >= 0 && tick.count > 0) detectTick(tick, timestamp, out);
    tick.reset();
  };

  let filled = 0; // bytes válidos em buf
  let eof = false;
  let headerSkipped = start > 0; // só a faixa que começa no byte 0 tem cabeçalho
  let filePos = start;

  try {
    for (;;) {
      if (!eof) {
        const want = Math.min(buf.length - filled, rangeEnd - filePos);
        const n = want > 0 ? fs.readSync(fd, buf, filled, want, filePos) : 0;
        if (n === 0) eof = true;
        filled += n;
        filePos += n;
      }
      if (filled === 0) break;

      // Processa somente linhas completas. No EOF, a última linha pode não ter '\n'.
      let end: number;
      if (eof) {
        end = filled;
      } else {
        const lastNl = buf.lastIndexOf(NL, filled - 1);
        if (lastNl < 0) {
          if (filled === buf.length) throw new Error('linha maior que o buffer de leitura');
          continue;
        }
        end = lastNl + 1;
      }

      let pos = 0;
      if (!headerSkipped) {
        const nl = buf.indexOf(NL);
        pos = nl < 0 || nl >= end ? end : nl + 1;
        headerSkipped = true;
      }

      while (pos < end) {
        // Linha vazia (ou só \r)
        let c = buf[pos];
        if (c === NL || c === CR) {
          pos++;
          continue;
        }

        // idMonitorado
        let id = 0;
        while ((c = buf[pos++]) !== SEMI) id = id * 10 + (c - ZERO);

        // faccaoMonitorado (vazio = -1)
        let faction = -1;
        if ((c = buf[pos++]) !== SEMI) {
          faction = c - ZERO;
          while ((c = buf[pos++]) !== SEMI) faction = faction * 10 + (c - ZERO);
        }

        // timestamp (entre aspas)
        if (buf[pos] === QUOTE) pos++;
        const tsStart = pos;
        while ((c = buf[pos]) !== QUOTE && c !== SEMI) pos++;
        const tsLen = pos - tsStart;
        if (c === QUOTE) pos++;
        pos++; // ;

        // Mudou o timestamp? Compara de trás para frente (os segundos mudam primeiro).
        let same = tsLen === curTsLen;
        if (same) {
          for (let k = tsLen - 1; k >= 0; k--) {
            if (buf[tsStart + k] !== curTs[k]) {
              same = false;
              break;
            }
          }
        }
        if (!same) {
          flush();
          buf.copy(curTs, 0, tsStart, tsStart + tsLen);
          curTsLen = tsLen;
          curTsStr = null;
        }

        // latitude e longitude: mantissa inteira / 10^casas. É bit a bit igual a
        // parseFloat, pois os dois são o arredondamento correto do mesmo decimal.
        let neg = false;
        let m = 0;
        let dec = -1;
        if ((c = buf[pos]) === MINUS) {
          neg = true;
          pos++;
        }
        while ((c = buf[pos++]) !== SEMI) {
          if (c === DOT) dec = 0;
          else {
            m = m * 10 + (c - ZERO);
            if (dec >= 0) dec++;
          }
        }
        let lat = dec > 0 ? m / POW10[dec] : m;
        if (neg) lat = -lat;

        neg = false;
        m = 0;
        dec = -1;
        if ((c = buf[pos]) === MINUS) {
          neg = true;
          pos++;
        }
        while ((c = buf[pos++]) !== SEMI) {
          if (c === DOT) dec = 0;
          else {
            m = m * 10 + (c - ZERO);
            if (dec >= 0) dec++;
          }
        }
        let lon = dec > 0 ? m / POW10[dec] : m;
        if (neg) lon = -lon;

        // medidaProtetiva
        const protective = buf[pos] === T;
        while (buf[pos++] !== SEMI);

        // Registra o ponto
        const i = tick.count;
        tick.ensureCapacity(i + 1);
        tick.ids[i] = id;
        tick.factions[i] = faction;
        tick.lats[i] = lat;
        tick.lons[i] = lon;
        tick.restrStart[i] = tick.restrCount;

        // idsRestricaoMedida: "1,2,3" (pode estar vazio)
        let restrLen = 0;
        while (pos < end && (c = buf[pos]) !== NL && c !== CR) {
          if (c >= ZERO && c <= NINE) {
            let r = 0;
            while (pos < end && (c = buf[pos]) >= ZERO && c <= NINE) {
              r = r * 10 + (c - ZERO);
              pos++;
            }
            if (protective) {
              tick.pushRestriction(r);
              restrLen++;
            }
          } else pos++; // aspas ou vírgula
        }
        tick.restrLen[i] = restrLen;
        tick.count = i + 1;

        // fim de linha
        while (pos < end && ((c = buf[pos]) === CR || c === NL)) pos++;
      }

      // Move o resto (linha incompleta) para o início do buffer.
      const rest = filled - end;
      if (rest > 0) buf.copy(buf, 0, end, filled);
      filled = rest;
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }

  return out;
}
