const indicator = document.getElementById('live');
const newActivity = document.getElementById('new-activity');
const kept = (node) => node !== indicator && node !== newActivity;

const show = (state, text) => {
  indicator.dataset.state = state;
  indicator.textContent = text;
  indicator.hidden = false;
};

const toggled = new WeakSet();

document.addEventListener('click', (event) => {
  const summary = event.target instanceof Element ? event.target.closest('summary') : null;
  if (summary?.parentElement instanceof HTMLDetailsElement) toggled.add(summary.parentElement);
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
  Idiomorph.morph(document.body, next.body, {
    morphStyle: 'innerHTML',
    callbacks: {
      beforeNodeMorphed: kept,
      beforeNodeRemoved: kept,
      beforeAttributeUpdated: (name, node) => !(name === 'open' && toggled.has(node)),
    },
  });
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
