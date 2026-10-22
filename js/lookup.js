// Address lookup on the map: an address search box (geocoding), "What's
// here?" (reverse geocoding: the address, parcel and title at a spot) and the
// marked location that the query builder can filter by.

import { el } from './dom.js';
import { PARCEL_LAYER, TITLE_LAYER, geocodeAddress, whatsHere } from './linz.js';

const MARK_STYLE = { color: '#a61e4d', weight: 2, fillColor: '#f06595', fillOpacity: 0.9, radius: 7 };
const PARCEL_STYLE = { color: '#a61e4d', weight: 2, dashArray: '6 4', fill: false, interactive: false };

export function formatCoords({ lon, lat }) {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function distanceNote(feature) {
  return feature.distance > 0 ? el('span', { class: 'muted' }, ` · ${Math.round(feature.distance)} m away`) : null;
}

function copyButton(text) {
  const button = el('button', {
    type: 'button',
    class: 'link',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        window.prompt('Copy:', text);
      }
    },
  }, 'Copy');
  return button;
}

/**
 * Adds the lookup controls to a Leaflet map.
 * @param {L.Map} map
 * @param {object} hooks
 * @param {() => string} hooks.getApiKey
 * @param {(mark: {lon: number, lat: number, label: string}|null) => void} hooks.onMark
 *   Called whenever the marked location changes.
 * @param {(type: string, id: number, condition: object) => void} hooks.onOpen
 *   Opens a dataset filtered with one condition.
 * @param {() => ({label: string, run: () => void}|null)} hooks.filterHere
 *   An action that filters the open dataset to the marked location, if it can.
 * @param {{lon: number, lat: number, label: string}|null} initialMark
 */
export function createLookup(map, hooks, initialMark) {
  const layer = L.layerGroup().addTo(map);
  let mark = null;
  let active = false;
  let lookupController = null;
  let hereButton = null;

  function setMark(point, label) {
    layer.clearLayers();
    mark = point ? { lon: point.lon, lat: point.lat, label: label || formatCoords(point) } : null;
    if (mark) {
      L.circleMarker([mark.lat, mark.lon], MARK_STYLE)
        .on('click', () => lookupAt(mark, mark.label))
        .addTo(layer);
    }
    hooks.onMark(mark);
  }

  function setActive(on) {
    active = on;
    if (on) map.closePopup();
    map.getContainer().classList.toggle('lookup-active', on);
    hereButton?.setAttribute('aria-pressed', String(on));
    hereButton?.classList.toggle('active', on);
  }

  function renderResult(point, result) {
    const parts = [];
    parts.push(el('h4', {}, result.addresses.length > 1 ? 'Nearest addresses' : 'Address'));
    parts.push(result.addresses.length
      ? el('ul', {}, result.addresses.map((f) => el('li', {}, f.properties.full_address, distanceNote(f))))
      : el('p', { class: 'muted' }, 'No address within 100 m.'));

    if (result.parcels.length) {
      parts.push(el('h4', {}, 'Parcel'));
      for (const f of result.parcels) {
        const p = f.properties;
        parts.push(el('p', {},
          el('strong', {}, p.appellation || `Parcel ${p.id}`),
          p.parcel_intent ? ` · ${p.parcel_intent}` : '',
          distanceNote(f), ' ',
          el('button', {
            type: 'button',
            class: 'link',
            onclick: () => hooks.onOpen(PARCEL_LAYER.type, PARCEL_LAYER.id, { field: 'id', value: String(p.id) }),
          }, 'Open')));
      }
    }

    if (result.titles.length) {
      parts.push(el('h4', {}, result.titles.length > 1 ? 'Titles' : 'Title'));
      for (const f of result.titles) {
        const p = f.properties;
        parts.push(el('p', {},
          el('strong', {}, p.title_no),
          p.type ? ` · ${p.type}` : '',
          distanceNote(f), ' ',
          copyButton(p.title_no), ' ',
          el('button', {
            type: 'button',
            class: 'link',
            onclick: () => hooks.onOpen(TITLE_LAYER.type, TITLE_LAYER.id, { field: 'title_no', value: p.title_no }),
          }, 'Open')));
      }
    }

    const filter = hooks.filterHere();
    parts.push(el('div', { class: 'here-actions' },
      filter && el('button', { type: 'button', class: 'button small primary', onclick: filter.run }, filter.label),
      el('button', {
        type: 'button',
        class: 'button small',
        onclick: () => {
          setMark(null);
          map.closePopup();
        },
      }, 'Remove marker')));
    return parts;
  }

  /** Marks a point and shows the address, parcel and title there. */
  async function lookupAt(point, label = null) {
    setMark(point, label);
    const body = el('div', { class: 'here-body' }, el('p', { class: 'muted' }, 'Looking up…'));
    const content = el('div', { class: 'here' },
      el('div', { class: 'here-coords' }, formatCoords(point), ' ', copyButton(formatCoords(point))),
      body);
    const popup = L.popup({ maxWidth: 340, minWidth: 220 }).setLatLng([point.lat, point.lon]).setContent(content).openOn(map);
    // Re-lay out (and pan the map to fit) once the body changes size.
    const show = (...children) => {
      body.replaceChildren(...children);
      popup.update();
    };

    const apiKey = hooks.getApiKey();
    if (!apiKey) {
      show(el('p', {}, 'Add an API key to look up addresses, parcels and titles. ',
        el('button', { type: 'button', class: 'link', 'data-open-key': true }, 'Add API key')));
      return;
    }
    lookupController?.abort();
    const controller = new AbortController();
    lookupController = controller;
    try {
      const result = await whatsHere(apiKey, point, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const nearest = result.addresses[0];
      if (!label && nearest && nearest.distance <= 30) setMark(point, nearest.properties.full_address);
      for (const parcel of result.parcels.filter((f) => f.distance === 0 && f.geometry)) {
        L.geoJSON(parcel, { style: () => PARCEL_STYLE, interactive: false }).addTo(layer);
      }
      show(...renderResult(point, result));
    } catch (err) {
      if (err.name === 'AbortError') return;
      show(el('p', { class: 'error-text' }, `Lookup failed: ${err.message}`));
    }
  }

  const toPoint = (latlng) => ({ lon: latlng.lng, lat: latlng.lat });

  const HereControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      hereButton = el('a', {
        href: '#',
        role: 'button',
        class: 'lookup-here',
        title: "What's here? Click the map to see the address, parcel and title at a spot",
        'aria-pressed': 'false',
      }, "What's here?");
      L.DomEvent.on(hereButton, 'click', (e) => {
        L.DomEvent.stop(e);
        setActive(!active);
      });
      return el('div', { class: 'leaflet-bar' }, hereButton);
    },
  });

  const SearchControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const input = el('input', {
        type: 'search',
        class: 'lookup-input',
        placeholder: 'Find an address…',
        'aria-label': 'Find an address',
        autocomplete: 'off',
        role: 'combobox',
        'aria-expanded': 'false',
        'aria-controls': 'lookup-results',
      });
      const list = el('ul', { class: 'lookup-results', id: 'lookup-results', role: 'listbox', hidden: true });
      const box = el('div', { class: 'lookup-search' }, input, list);
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);

      let matches = [];
      let activeIndex = -1;
      let timer = null;
      let controller = null;

      const showMessage = (...message) => {
        matches = [];
        list.replaceChildren(el('li', { class: 'lookup-message' }, ...message));
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      };
      const close = () => {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      };
      const choose = (match) => {
        input.value = match.address;
        close();
        map.setView([match.lat, match.lon], Math.max(map.getZoom(), 18));
        lookupAt({ lon: match.lon, lat: match.lat }, match.address);
      };
      const highlight = (index) => {
        activeIndex = index;
        [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
      };
      const search = async (text) => {
        const apiKey = hooks.getApiKey();
        if (!apiKey) {
          showMessage('Add an API key to search addresses. ',
            el('button', { type: 'button', class: 'link', 'data-open-key': true }, 'Add API key'));
          return;
        }
        controller?.abort();
        controller = new AbortController();
        const { signal } = controller;
        showMessage('Searching…');
        try {
          const found = await geocodeAddress(apiKey, text, { signal });
          if (signal.aborted) return;
          if (!found.length) {
            showMessage('No matching addresses.');
            return;
          }
          matches = found;
          list.replaceChildren(...found.map((m, i) => el('li', {
            role: 'option',
            'aria-selected': 'false',
            onmousedown: (e) => e.preventDefault(),
            onclick: () => choose(matches[i]),
          }, m.address)));
          highlight(-1);
        } catch (err) {
          if (err.name !== 'AbortError') showMessage(`Search failed: ${err.message}`);
        }
      };

      input.addEventListener('input', () => {
        clearTimeout(timer);
        const text = input.value.trim();
        if (text.length < 3) {
          controller?.abort();
          close();
          return;
        }
        timer = setTimeout(() => search(text), 350);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' && matches.length) {
          e.preventDefault();
          highlight(Math.min(activeIndex + 1, matches.length - 1));
        } else if (e.key === 'ArrowUp' && matches.length) {
          e.preventDefault();
          highlight(Math.max(activeIndex - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (matches.length) choose(matches[Math.max(activeIndex, 0)]);
          else if (input.value.trim().length >= 3) search(input.value.trim());
        } else if (e.key === 'Escape') {
          close();
        }
      });
      input.addEventListener('blur', () => setTimeout(close, 150));
      return box;
    },
  });

  map.addControl(new HereControl());
  map.addControl(new SearchControl());
  map.on('click', (e) => {
    if (active) lookupAt(toPoint(e.latlng));
  });
  map.on('contextmenu', (e) => lookupAt(toPoint(e.latlng)));

  if (initialMark) setMark(initialMark, initialMark.label);

  return {
    lookupAt,
    get active() { return active; },
    get mark() { return mark; },
  };
}
