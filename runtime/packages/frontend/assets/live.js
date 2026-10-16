const indicator = document.getElementById('live');
const newActivity = document.getElementById('new-activity');
const kept = (node) => node !== indicator && node !== newActivity;

const show = (state, text) => {
  indicator.dataset.state = state;
  indicator.textContent = text;
  indicator.hidden = false;
};

const formatElapsed = (milliseconds, limited) => {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (limited && minutes > 0) return `${minutes}m`;
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

const tick = () => {
  const now = Date.now();
  for (const element of document.querySelectorAll('[data-elapsed-since]')) {
    const limit = element.dataset.elapsedLimit;
    const elapsed = formatElapsed(now - Date.parse(element.dataset.elapsedSince), limit !== undefined);
    element.textContent = limit === undefined ? elapsed : `${elapsed} / ${limit}`;
  }
};

tick();
setInterval(tick, 1000);

const toggled = new WeakSet();
const rendered = new WeakMap();

const phone = matchMedia('(max-width: 639px)');

const collapseOnPhone = () => {
  if (!phone.matches) return;
  for (const details of document.querySelectorAll('details[data-collapsed-on-phone]')) {
    if (!toggled.has(details)) details.open = false;
  }
};

const rememberRendered = () => {
  collapseOnPhone();
  for (const details of document.querySelectorAll('details')) {
    if (!toggled.has(details)) rendered.set(details, details.open);
  }
};

rememberRendered();

const operatorChose = (details) => {
  if (details.open !== rendered.get(details)) toggled.add(details);
  return toggled.has(details);
};

const renderedControls = new WeakMap();

const FORM_CONTROLS = 'input:not([type="file"]):not([type="hidden"]), select, textarea';

const controlState = (control) => {
  if (control.type === 'checkbox' || control.type === 'radio') return String(control.checked);
  if (control.tagName === 'SELECT') return JSON.stringify([...control.selectedOptions].map((option) => option.value));
  return control.value;
};

const restoreControl = (control, state) => {
  if (control.type === 'checkbox') {
    control.checked = state === 'true';
  } else if (control.type === 'radio') {
    if (state === 'true') control.checked = true;
  } else if (control.tagName === 'SELECT') {
    const chosen = JSON.parse(state);
    const remaining = [...control.options].filter((option) => chosen.includes(option.value));
    if (remaining.length === 0) return;
    for (const option of control.options) option.selected = remaining.includes(option);
  } else {
    control.value = state;
  }
};

const editedControls = () => {
  const edits = new Map();
  for (const control of document.querySelectorAll(FORM_CONTROLS)) {
    const state = controlState(control);
    if (renderedControls.has(control) && state !== renderedControls.get(control)) edits.set(control, state);
  }
  return edits;
};

const rememberControls = (edits = new Map()) => {
  for (const control of document.querySelectorAll(FORM_CONTROLS)) {
    renderedControls.set(control, controlState(control));
    if (edits.has(control)) restoreControl(control, edits.get(control));
  }
};

rememberControls();

const LANE_KEY = (lane) => `forge:lane-collapsed:${lane.dataset.repository}`;

const readLane = (lane) => {
  try {
    const stored = localStorage.getItem(LANE_KEY(lane));
    if (stored !== null) return stored === 'true';
  } catch {}
  return lane.hasAttribute('data-empty');
};

const showLane = (lane, collapsed) => {
  lane.toggleAttribute('data-collapsed', collapsed);
  lane.querySelector('[data-lane-toggle]')?.setAttribute('aria-expanded', String(!collapsed));
};

const applyLanes = () => {
  for (const lane of document.querySelectorAll('section[data-repository]')) showLane(lane, readLane(lane));
};

applyLanes();

const toggleLane = (header) => {
  const lane = header.closest('section[data-repository]');
  const collapsed = !lane.hasAttribute('data-collapsed');
  showLane(lane, collapsed);
  try {
    localStorage.setItem(LANE_KEY(lane), String(collapsed));
  } catch {}
};

document.addEventListener('click', (event) => {
  const header = event.target.closest?.('[data-lane-toggle]');
  if (header !== null && header !== undefined && !event.target.closest('a')) toggleLane(header);
});

document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-lane-toggle]')) {
    event.preventDefault();
    toggleLane(event.target);
  }
});

const scroller = document.scrollingElement;

const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;

const transcriptLength = () => Number(document.querySelector('[data-transcript]')?.dataset.transcript ?? 0);

const scrollToBottom = () => scroller.scrollTo({ top: scroller.scrollHeight });

newActivity?.addEventListener('click', scrollToBottom);

addEventListener('scroll', () => {
  if (newActivity !== null && atBottom()) newActivity.hidden = true;
});

const assetsOf = (page) =>
  [...page.querySelectorAll('link[href^="/assets/"], script[src^="/assets/"]')]
    .map((element) => element.getAttribute('href') ?? element.getAttribute('src'))
    .join(' ');

const refresh = async () => {
  const response = await fetch(location.href, { headers: { Accept: 'text/html' }, cache: 'no-store' });
  if (!response.ok) return;
  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  if (assetsOf(next) !== assetsOf(document)) {
    location.reload();
    return;
  }
  document.title = next.title;
  const following = newActivity !== null && atBottom();
  const length = transcriptLength();
  const edits = editedControls();
  Idiomorph.morph(document.body, next.body, {
    morphStyle: 'innerHTML',
    callbacks: {
      beforeNodeMorphed: kept,
      beforeNodeRemoved: kept,
      beforeAttributeUpdated: (name, node) => !(name === 'open' && operatorChose(node)),
    },
  });
  applyLanes();
  rememberRendered();
  rememberControls(edits);
  tick();
  if (following) {
    scrollToBottom();
  } else if (newActivity !== null && transcriptLength() > length) {
    newActivity.hidden = false;
  }
};

let refreshing = false;
let stale = false;

const update = async () => {
  stale = true;
  if (refreshing) return;
  refreshing = true;
  try {
    while (stale) {
      stale = false;
      await refresh();
    }
  } catch (error) {
    console.error('forge could not update the page', error);
  } finally {
    refreshing = false;
  }
};

if (indicator !== null) {
  const events = new EventSource(`/events?page=${encodeURIComponent(location.pathname + location.search)}`);
  events.addEventListener('open', () => show('live', 'Live'));
  events.addEventListener('error', () => {
    if (events.readyState === EventSource.CLOSED) {
      indicator.hidden = true;
    } else {
      show('reconnecting', 'Reconnecting…');
    }
  });
  events.addEventListener('change', update);
  events.addEventListener('done', () => {
    events.close();
    indicator.hidden = true;
  });
}
