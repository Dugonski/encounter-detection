import fs from 'node:fs';
import { Encounter } from './types';

export function writeEncounters(file: string, encounters: Encounter[]): void {
  fs.writeFileSync(file, JSON.stringify(encounters, null, 2));
}
