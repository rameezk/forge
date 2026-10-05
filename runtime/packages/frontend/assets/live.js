const indicator = document.getElementById('live');
const newActivity = document.getElementById('new-activity');
const kept = (node) => node !== indicator && node !== newActivity;

const show = (state, text) => {
  indicator.dataset.state = state;
  indicator.textContent = text;
  indicator.hidden = false;
};

const formatElapsed = (milliseconds) => {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

const tick = () => {
  const now = Date.now();
  for (const element of document.querySelectorAll('[data-elapsed-since]')) {
    element.textContent = formatElapsed(now - Date.parse(element.dataset.elapsedSince));
  }
};

tick();
setInterval(tick, 1000);

const toggled = new WeakSet();
const rendered = new WeakMap();

const rememberRendered = () => {
  for (const details of document.querySelectorAll('details')) {
    if (!toggled.has(details)) rendered.set(details, details.open);
  }
};

rememberRendered();

const operatorChose = (details) => {
  if (details.open !== rendered.get(details)) toggled.add(details);
  return toggled.has(details);
};

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
  Idiomorph.morph(document.body, next.body, {
    morphStyle: 'innerHTML',
    callbacks: {
      beforeNodeMorphed: kept,
      beforeNodeRemoved: kept,
      beforeAttributeUpdated: (name, node) => !(name === 'open' && operatorChose(node)),
    },
  });
  rememberRendered();
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
  const events = new EventSource(`/events?page=${encodeURIComponent(location.pathname)}`);
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
