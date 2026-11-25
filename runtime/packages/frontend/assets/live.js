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

const laneKey = (lane) => `forge:lane-collapsed:${lane.dataset.repository}`;

const readLane = (lane) => {
  try {
    const stored = localStorage.getItem(laneKey(lane));
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
    localStorage.setItem(laneKey(lane), String(collapsed));
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

const expandedGroups = new Set();

const showGroup = (body, expanded) => {
  body.toggleAttribute('data-collapsed', !expanded);
  body.querySelector('[data-group-toggle]')?.setAttribute('aria-expanded', String(expanded));
};

const applyGroups = () => {
  for (const body of document.querySelectorAll('tbody[data-cohort-group]')) {
    if (body.querySelector('[data-group-toggle]') !== null) showGroup(body, expandedGroups.has(body.dataset.cohortGroup));
  }
};

applyGroups();

document.addEventListener('click', (event) => {
  const toggle = event.target.closest?.('[data-group-toggle]');
  if (toggle === null || toggle === undefined) return;
  const body = toggle.closest('tbody[data-cohort-group]');
  const group = body.dataset.cohortGroup;
  if (expandedGroups.has(group)) expandedGroups.delete(group);
  else expandedGroups.add(group);
  showGroup(body, expandedGroups.has(group));
});

let traceBars = null;

const applyTraceBars = () => {
  const trace = document.querySelector('[data-trace]');
  if (trace === null) return;
  const buttons = [...trace.querySelectorAll('[data-trace-view]')];
  if (traceBars !== null && !buttons.some((button) => button.dataset.traceView === traceBars && !button.disabled)) traceBars = null;
  const bars = traceBars ?? trace.dataset.bars;
  trace.dataset.bars = bars;
  for (const button of buttons) {
    const selected = button.dataset.traceView === bars;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('bg-surface', selected);
    button.classList.toggle('text-fg', selected);
    button.classList.toggle('shadow-sm', selected);
  }
};

applyTraceBars();

document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-trace-view]');
  if (button === null || button === undefined || button.disabled) return;
  traceBars = button.dataset.traceView;
  applyTraceBars();
});

let selectedStep = null;

let stoppedStep = null;

const traceSteps = () => [...document.querySelectorAll('[data-trace] [data-step]')];

const visibleSteps = () => traceSteps().filter((step) => step.checkVisibility());

const branchOf = (step) => (step.tagName === 'SUMMARY' ? step.parentElement : null);

const parentStep = (step) => {
  const holder = (branchOf(step) ?? step).parentElement.closest('details[data-step-branch]');
  return holder === null ? null : holder.firstElementChild;
};

const applyTrace = () => {
  const steps = traceSteps();
  if (steps.length === 0) return;
  const selected = steps.find((step) => step.dataset.stepKey === selectedStep);
  if (selected === undefined) selectedStep = null;
  const stop = steps.find((step) => step.dataset.stepKey === stoppedStep) ?? selected ?? steps[0];
  for (const step of steps) {
    step.setAttribute('aria-selected', String(step === selected));
    step.tabIndex = step === stop ? 0 : -1;
    const branch = branchOf(step);
    if (branch !== null) step.setAttribute('aria-expanded', String(branch.open));
  }
  for (const detail of document.querySelectorAll('[data-step-detail]')) {
    detail.hidden = detail.dataset.stepDetail !== selectedStep;
  }
  const empty = document.querySelector('[data-detail-empty]');
  if (empty !== null) empty.hidden = selected !== undefined;
};

applyTrace();

const selectStep = (step) => {
  selectedStep = step.dataset.stepKey;
  stoppedStep = selectedStep;
  applyTrace();
};

document.addEventListener('click', (event) => {
  const step = event.target.closest?.('[data-trace] [data-step]');
  if (step === null || step === undefined || event.target.closest('a, [data-step-toggle]')) return;
  event.preventDefault();
  step.focus();
  selectStep(step);
});

document.addEventListener('focusin', (event) => {
  const step = event.target.closest?.('[data-trace] [data-step]');
  if (step === null || step === undefined) return;
  stoppedStep = step.dataset.stepKey;
  applyTrace();
});

document.addEventListener(
  'toggle',
  (event) => {
    if (event.target.matches?.('details[data-step-branch]')) applyTrace();
  },
  true,
);

const moveFrom = (step, offset) => {
  const steps = visibleSteps();
  const target = steps[Math.min(steps.length - 1, Math.max(0, steps.indexOf(step) + offset))];
  target?.focus();
};

const traceKeys = {
  ArrowDown: (step) => moveFrom(step, 1),
  ArrowUp: (step) => moveFrom(step, -1),
  Home: (step) => visibleSteps()[0]?.focus(),
  End: (step) => visibleSteps().at(-1)?.focus(),
  Enter: selectStep,
  ' ': selectStep,
  ArrowRight: (step) => {
    const branch = branchOf(step);
    if (branch === null) return;
    if (branch.open) moveFrom(step, 1);
    else branch.open = true;
  },
  ArrowLeft: (step) => {
    const branch = branchOf(step);
    if (branch?.open) branch.open = false;
    else parentStep(step)?.focus();
  },
};

document.addEventListener('keydown', (event) => {
  const step = event.target.closest?.('[data-trace] [data-step]');
  const handle = traceKeys[event.key];
  if (step !== event.target || handle === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  handle(step);
});

document.addEventListener('keyup', (event) => {
  if (event.key === ' ' && event.target.matches?.('[data-trace] [data-step]')) event.preventDefault();
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
  Idiomorph.morph(document.body, [...next.body.childNodes], {
    morphStyle: 'innerHTML',
    callbacks: {
      beforeNodeMorphed: kept,
      beforeNodeRemoved: kept,
      beforeAttributeUpdated: (name, node) => !(name === 'open' && operatorChose(node)),
    },
  });
  applyLanes();
  applyGroups();
  applyTraceBars();
  applyTrace();
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
  const stream = new URLSearchParams({ page: location.pathname + location.search });
  if (indicator.dataset.version !== undefined) stream.set('version', indicator.dataset.version);
  const events = new EventSource(`/events?${stream}`);
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
