import { haversine } from './geo';
import { Encounter, EncounterType, Position } from './types';

/** Encontro: distância estritamente menor que 20 metros. */
export const ENCOUNTER_DISTANCE_M = 20;

export function classify(a: Position, b: Position): EncounterType {
  if (a.restrictions.includes(b.id) || b.restrictions.includes(a.id)) return 'protetiva';
  if (a.faction !== '' && a.faction === b.faction) return 'faccao';
  return 'generico';
}

/**
 * Detecta os encontros entre as posições de um mesmo timestamp.
 * Baseline: compara todos os pares (O(n²) por tick).
 */
export function detectTick(timestamp: string, points: Position[]): Encounter[] {
  const found: Encounter[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const dist = haversine(a.lat, a.lon, b.lat, b.lon);
      if (dist < ENCOUNTER_DISTANCE_M) found.push(buildEncounter(timestamp, a, b, dist));
    }
  }
  return found;
}

export function buildEncounter(timestamp: string, a: Position, b: Position, dist: number): Encounter {
  const [p, q] = a.id < b.id ? [a, b] : [b, a];
  return {
    tipo: classify(a, b),
    monitoradosEncontro: [p.id, q.id],
    timestamp,
    posicoes: {
      [p.id]: { lat: p.lat, lon: p.lon },
      [q.id]: { lat: q.lat, lon: q.lon },
    },
    distanciaMetros: dist,
  };
}

/** Ordem da saída: timestamp, depois o par de ids. */
export function compareEncounters(x: Encounter, y: Encounter): number {
  if (x.timestamp !== y.timestamp) return x.timestamp < y.timestamp ? -1 : 1;
  return (
    x.monitoradosEncontro[0] - y.monitoradosEncontro[0] ||
    x.monitoradosEncontro[1] - y.monitoradosEncontro[1]
  );
}
