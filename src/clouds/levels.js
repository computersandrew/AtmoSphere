/** Cloud shell heights, km above sea level. Must match LEVELS_KM in pipeline/build_clouds.py. */
export const LEVELS_KM = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0,
  5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0];

/** Each shell stands for the slab halfway to its neighbours. */
export const SLABS = LEVELS_KM.map((h, i) => {
  const lo = i === 0 ? 0 : (h + LEVELS_KM[i - 1]) / 2;
  const hi = i === LEVELS_KM.length - 1 ? h + (h - LEVELS_KM[i - 1]) / 2 : (h + LEVELS_KM[i + 1]) / 2;
  return [lo, hi];
});
