// The production API, or a locally running arunika-backend when the site
// itself is served from this machine (development, prerelease_check.sh).
const API_BASE_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? 'http://localhost:8080'
  : 'https://api.haloarunika.com';

// The app has no deep link, so "Beli" opens its Play Store listing. On
// Android that hands off to the Play Store app, which offers "Buka" when
// Arunika is already installed and "Instal" when it isn't.
const APP_URL = 'https://play.google.com/store/apps/details?id=com.arunika';

function formatPriceIdr(priceIdr) {
  return `Rp ${Number(priceIdr).toLocaleString('id-ID')}`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function safeImageUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

// ---------- Catalog: every AR card and fairy tale ----------

function isFreeItem(item) {
  return item.is_free === true || item.price_idr == null;
}

function hasPromo(item) {
  return !isFreeItem(item) && item.strike_price_idr != null && item.strike_price_idr > item.price_idr;
}

function catalogPriceHtml(item) {
  if (isFreeItem(item)) {
    return '<p class="product-price is-free">Gratis</p>';
  }
  const strike = hasPromo(item)
    ? `<s class="product-strike">${formatPriceIdr(item.strike_price_idr)}</s>`
    : '';
  return `<p class="product-price">${strike}${formatPriceIdr(item.price_idr)}</p>`;
}

// Same card as the former "Paket" showcase: image, badge, title, price, plus
// a buy button that sends the visitor to the app.
function catalogCardHtml(item, kind) {
  const image = safeImageUrl(item.image_url);
  const title = item.title || 'Tanpa judul';
  const media = image
    ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" loading="lazy" />`
    : `<div class="placeholder-icon">${kind.icon}</div>`;
  const ribbon = hasPromo(item) && item.discount_percent
    ? `<span class="product-ribbon">Hemat ${Number(item.discount_percent)}%</span>`
    : '';
  const label = isFreeItem(item) ? 'Dapatkan' : 'Beli';

  return `
    <article class="product-card">
      <div class="product-media">
        ${media}
        ${ribbon}
      </div>
      <div class="product-body">
        <span class="product-badge ${kind.badgeClass}">${kind.badge}</span>
        <h3>${escapeHtml(title)}</h3>
        ${catalogPriceHtml(item)}
        <a class="btn btn-primary product-buy" href="${APP_URL}" target="_blank" rel="noopener"
           aria-label="${label} ${escapeHtml(title)} di aplikasi Arunika">${label}</a>
      </div>
    </article>
  `;
}

const KINDS = {
  ar: { icon: '✨', badge: 'Flashcard AR', badgeClass: '' },
  dongeng: { icon: '🌙', badge: 'Dongeng', badgeClass: 'dongeng' },
};

function renderCluster(id, items, kind) {
  const cluster = document.getElementById(id);
  if (items.length === 0) {
    cluster.hidden = true;
    return;
  }
  const track = cluster.querySelector('.product-carousel');
  const grid = cluster.querySelector('.product-grid');
  cluster.querySelector('.catalog-count').textContent = `${items.length} item`;
  grid.innerHTML = items.map((item) => catalogCardHtml(item, kind)).join('');
  // A dead image URL falls back to the icon instead of showing alt text.
  grid.querySelectorAll('.product-media img').forEach((img) => {
    img.addEventListener('error', () => {
      img.outerHTML = `<div class="placeholder-icon">${kind.icon}</div>`;
    }, { once: true });
  });
  cluster.hidden = false;
  initCarousel(track, cluster.querySelector('.product-dots'));
}

async function fetchArCards() {
  const response = await fetch(`${API_BASE_URL}/ar/cards`);
  if (!response.ok) throw new Error(`ar cards: ${response.status}`);
  const body = await response.json();
  const now = Date.now();
  return (Array.isArray(body?.data) ? body.data : [])
    .filter((card) => !card.expires_at || new Date(card.expires_at).getTime() > now);
}

// /fairy-tales is paginated (100 per page at most), so walk every page.
async function fetchFairyTales() {
  const PER_PAGE = 100;
  const MAX_PAGES = 20;
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(`${API_BASE_URL}/fairy-tales?page=${page}&per_page=${PER_PAGE}`);
    if (!response.ok) throw new Error(`fairy tales: ${response.status}`);
    const body = await response.json();
    const pageItems = Array.isArray(body?.data) ? body.data : [];
    items.push(...pageItems);
    if (pageItems.length < PER_PAGE || items.length >= (body?.total ?? 0)) break;
  }
  return items;
}

async function loadCatalog() {
  const [cards, tales] = await Promise.allSettled([fetchArCards(), fetchFairyTales()]);
  const arItems = cards.status === 'fulfilled' ? cards.value : [];
  const taleItems = tales.status === 'fulfilled' ? tales.value : [];

  renderCluster('catalog-ar', arItems, KINDS.ar);
  renderCluster('catalog-dongeng', taleItems, KINDS.dongeng);
  document.getElementById('catalog-loading').hidden = true;
  document.getElementById('catalog-fallback').hidden = arItems.length + taleItems.length > 0;
}

// Slow, continuous auto-scroll that reverses direction at each end (a
// "ping-pong" sweep) so the track never has to jump. Pauses on any user
// interaction — pointer, wheel, or touch — and resumes shortly after, so
// manual dragging/scrolling always takes priority. Progress is mirrored by
// a row of dots (one per card) below the carousel, instead of a scrollbar.
function initCarousel(track, dotsContainer) {
  const SPEED_PX_PER_FRAME = 0.4; // slow motion
  const RESUME_DELAY_MS = 2500;

  const cards = Array.from(track.querySelectorAll('.product-card'));

  let direction = 1;
  let paused = false;
  let resumeTimer = null;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartScroll = 0;

  const isDraggable = () => track.scrollWidth > track.clientWidth + 1;

  function pause() {
    paused = true;
    if (resumeTimer) clearTimeout(resumeTimer);
  }

  function scheduleResume() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; }, RESUME_DELAY_MS);
  }

  // ---- Dots ----
  dotsContainer.innerHTML = '';
  dotsContainer.hidden = cards.length < 2;

  const dots = cards.map((card, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'product-dot';
    dot.setAttribute('aria-label', `Ke item ${index + 1}`);
    dot.addEventListener('click', () => {
      pause();
      const target = card.offsetLeft - track.offsetLeft;
      track.scrollTo({ left: target, behavior: 'smooth' });
      scheduleResume();
    });
    dotsContainer.appendChild(dot);
    return dot;
  });

  let activeDotIndex = -1;
  function syncActiveDot() {
    let closest = 0;
    let closestDistance = Infinity;
    cards.forEach((card, index) => {
      const distance = Math.abs((card.offsetLeft - track.offsetLeft) - track.scrollLeft);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = index;
      }
    });
    if (closest === activeDotIndex) return;
    if (dots[activeDotIndex]) dots[activeDotIndex].classList.remove('is-active');
    dots[closest].classList.add('is-active');
    activeDotIndex = closest;
  }

  syncActiveDot();
  track.addEventListener('scroll', syncActiveDot, { passive: true });

  function tick() {
    if (!paused && isDraggable()) {
      const max = track.scrollWidth - track.clientWidth;
      let next = track.scrollLeft + SPEED_PX_PER_FRAME * direction;
      if (next >= max) {
        next = max;
        direction = -1;
      } else if (next <= 0) {
        next = 0;
        direction = 1;
      }
      track.scrollLeft = next;
    }
    requestAnimationFrame(tick);
  }

  track.addEventListener('mouseenter', pause);
  track.addEventListener('mouseleave', scheduleResume);
  track.addEventListener('touchstart', pause, { passive: true });
  track.addEventListener('touchend', scheduleResume);
  track.addEventListener('wheel', () => { pause(); scheduleResume(); }, { passive: true });

  // Click-and-drag support for mouse/trackpad users (touch already scrolls
  // natively via overflow-x). A drag must not also count as a click on the
  // buy button it started over.
  let dragMoved = false;

  track.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragMoved = false;
    pause();
    dragStartX = e.pageX;
    dragStartScroll = track.scrollLeft;
    track.classList.add('is-dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    if (Math.abs(e.pageX - dragStartX) > 5) dragMoved = true;
    track.scrollLeft = dragStartScroll - (e.pageX - dragStartX);
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    track.classList.remove('is-dragging');
    scheduleResume();
  });

  track.addEventListener('click', (e) => {
    if (dragMoved) {
      e.preventDefault();
      dragMoved = false;
    }
  }, true);

  requestAnimationFrame(tick);
}

// Touch devices have no real hover, so tapping the hero flashcards toggles
// them open/closed; tapping anywhere else closes them.
function initFlashcardStack() {
  const stack = document.querySelector('.flashcard-stack');
  if (!stack || window.matchMedia('(hover: hover)').matches) return;

  stack.addEventListener('click', (e) => {
    e.stopPropagation();
    stack.classList.toggle('is-open');
  });
  document.addEventListener('click', () => stack.classList.remove('is-open'));
}

document.addEventListener('DOMContentLoaded', () => {
  initFlashcardStack();
  loadCatalog();
});
