export const EARTH_RADIUS_M = 6371000;

/**
 * Converte graus para radianos.
 *
 * Atenção: é `deg * Math.PI / 180`, e não `deg * (Math.PI / 180)`. A segunda forma
 * pré-calcula a constante e muda o arredondamento no último dígito do float,
 * divergindo do gabarito (ex.: 10.81640474094182 vs 10.816404740941822).
 */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Distância em metros entre dois pontos pela fórmula de Haversine (R = 6.371.000 m). */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
