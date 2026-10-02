const indicator = document.getElementById('live');

const show = (state, text) => {
  indicator.dataset.state = state;
  indicator.textContent = text;
  indicator.hidden = false;
};

const refresh = async () => {
  const response = await fetch(location.href, { headers: { Accept: 'text/html' }, cache: 'no-store' });
  if (!response.ok) return;
  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  document.title = next.title;
  Idiomorph.morph(document.body, next.body, {
    morphStyle: 'innerHTML',
    callbacks: { beforeNodeMorphed: (node) => node !== indicator },
  });
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
