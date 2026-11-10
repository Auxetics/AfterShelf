export function openGalleryViewer(dialog, gallery, index, { loadMore, restoreFocus }) {
  if (dialog.open || !gallery.photos[index]) return;
  const find = selector => dialog.querySelector(selector);
  const stage = find('.gallery-stage');
  const image = find('.viewer-photo');
  const strip = find('.gallery-strip');
  const more = find('.viewer-more');
  const status = find('.gallery-viewer-status');
  const previous = find('.viewer-prev'), next = find('.viewer-next');
  const thumbnails = [];
  const listeners = new AbortController();
  const on = (element, name, listener) => element.addEventListener(name, listener, { signal: listeners.signal });
  let loading = false, error = '', swipe;
  let scrollDistance = 0, lastWheel = 0, lastSlide = -Infinity;

  function render() {
    const photo = gallery.photos[index];
    if (image.getAttribute('src') !== photo.src) image.src = photo.src;
    image.alt = 'Thread photo ' + (index + 1);
    status.textContent = loading ? 'Loading more photos…' : error || `Photo ${index + 1} of ${gallery.photos.length}`;
    previous.setAttribute('aria-disabled', String(index === 0 || loading));
    next.setAttribute('aria-disabled', String(loading || (index === gallery.photos.length - 1 && !gallery.hasMore)));
    more.hidden = !gallery.hasMore;
    more.setAttribute('aria-disabled', String(loading));
    for (const [i, item] of gallery.photos.entries()) {
      if (thumbnails[i]) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-thumbnail';
      button.setAttribute('aria-label', 'Show photo ' + (i + 1));
      const thumb = document.createElement('img');
      thumb.className = 'gallery-image';
      thumb.src = item.src;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      button.append(thumb);
      more.before(button);
      thumbnails.push(button);
      on(button, 'click', () => { if (!loading) { index = i; error = ''; render(); } });
    }
    thumbnails.forEach((button, i) => button.setAttribute('aria-current', String(index === i)));
    const selected = thumbnails[index].getBoundingClientRect();
    const bounds = strip.getBoundingClientRect();
    if (selected.left < bounds.left || selected.right > bounds.right) {
      strip.scrollLeft += (selected.left + selected.right - bounds.left - bounds.right) / 2;
    }
  }

  async function move(step) {
    if (loading || index + step < 0) return;
    if (index + step < gallery.photos.length) {
      index += step;
      error = '';
      render();
    } else if (step > 0) await fetchMore();
  }

  async function fetchMore() {
    if (loading || !gallery.hasMore) return;
    const firstNew = gallery.photos.length;
    loading = true;
    render();
    try {
      gallery = await loadMore();
      if (gallery.photos.length > firstNew) index = firstNew;
      error = gallery.photos.length === firstNew ? 'No additional photos loaded.' : '';
    } catch (failure) {
      error = failure.message;
    } finally {
      loading = false;
      if (dialog.open && !listeners.signal.aborted) render();
    }
  }

  on(previous, 'click', () => { void move(-1); });
  on(next, 'click', () => { void move(1); });
  on(more, 'click', () => { void fetchMore(); });
  on(find('.viewer-close'), 'click', () => dialog.close());
  on(dialog, 'keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    void move(event.key === 'ArrowLeft' ? -1 : 1);
  });
  on(stage, 'pointerdown', event => {
    if (event.pointerType === 'mouse' || event.target.closest('button')) return;
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
    stage.setPointerCapture(event.pointerId);
  });
  on(stage, 'pointercancel', () => { swipe = null; });
  on(stage, 'pointerup', event => {
    if (swipe?.id !== event.pointerId) return;
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) void move(dx > 0 ? -1 : 1);
  });
  on(stage, 'wheel', event => {
    if (event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const now = performance.now();
    if (now - lastWheel > 180) scrollDistance = 0;
    lastWheel = now;
    scrollDistance += event.deltaX;
    if (Math.abs(scrollDistance) < 65 || now - lastSlide < 400) return;
    lastSlide = now;
    void move(Math.sign(scrollDistance));
    scrollDistance = 0;
  });
  on(dialog, 'close', () => {
    listeners.abort();
    image.removeAttribute('src');
    thumbnails.forEach(button => button.remove());
    strip.scrollLeft = 0;
    restoreFocus();
  });
  dialog.showModal();
  render();
}
