export function colorProfileSaveDisabled({ browserStateReady, saving, resultSeason }) {
  return !browserStateReady || saving || !resultSeason;
}
