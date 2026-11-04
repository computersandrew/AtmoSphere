/** Metric / imperial formatting. All inputs are SI-ish: km and °C. */

const KM_PER_MI = 1.609344;
const FT_PER_KM = 3280.84;

let units = defaultUnits();

export function defaultUnits() {
  const lang = (navigator.language || '').toLowerCase();
  return /-(us|lr|mm)$/.test(lang) || lang === 'en' ? 'imperial' : 'metric';
}

export function getUnits() {
  return units;
}

export function setUnits(u) {
  units = u === 'imperial' ? 'imperial' : 'metric';
}

const int = (n) => Math.round(n).toLocaleString();

/** Distances such as camera altitude. */
export function formatDistance(km) {
  if (units === 'imperial') {
    const mi = km / KM_PER_MI;
    if (mi < 0.5) return `${int(km * FT_PER_KM)} ft`;
    if (mi < 100) return `${mi.toFixed(1)} mi`;
    return `${int(mi)} mi`;
  }
  if (km < 1) return `${int(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${int(km)} km`;
}

/** Heights in the atmosphere (cloud tops): feet or km. */
export function formatHeight(km) {
  if (units === 'imperial') return `${(Math.round((km * FT_PER_KM) / 100) * 100).toLocaleString()} ft`;
  return `${km.toFixed(1)} km`;
}

export function formatTemp(c) {
  if (units === 'imperial') return `${Math.round((c * 9) / 5 + 32)} °F`;
  return `${Math.round(c)} °C`;
}
