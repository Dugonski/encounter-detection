/** Posição de um monitorado em um timestamp. */
export interface Position {
  id: number;
  /** Id da facção; string vazia quando não há facção (vítimas nunca têm). */
  faction: string;
  lat: number;
  lon: number;
  /** Ids dos agressores dos quais esta pessoa deve manter distância. */
  restrictions: number[];
}

export type EncounterType = 'generico' | 'faccao' | 'protetiva';

export interface Encounter {
  tipo: EncounterType;
  monitoradosEncontro: [number, number];
  timestamp: string;
  posicoes: Record<string, { lat: number; lon: number }>;
  distanciaMetros: number;
}
