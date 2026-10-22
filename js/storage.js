// localStorage helpers. Storage can be unavailable (private windows, blocked
// site data), so every access is guarded and the app keeps working without it.

const PREFIX = 'linzBrowser.';

export function load(name, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + name);
    else localStorage.setItem(PREFIX + name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const MAX_SAVED_QUERIES = 50;

/** Last query used for each dataset, so reopening a favourite restores it. */
export function loadQuery(datasetKey) {
  return load('queries', {})[datasetKey]?.query || null;
}

export function saveQuery(datasetKey, query) {
  const all = load('queries', {});
  all[datasetKey] = { query, savedAt: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_SAVED_QUERIES) {
    keys.sort((a, b) => all[a].savedAt - all[b].savedAt)
      .slice(0, keys.length - MAX_SAVED_QUERIES)
      .forEach((k) => delete all[k]);
  }
  save('queries', all);
}
