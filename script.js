// Set this to the deployed backend's base URL before publishing the site.
// The local value below is for development against a locally running
// arunika-backend only.
const API_BASE_URL = 'http://localhost:8080';

const TYPE_LABELS = {
  subscription: 'Langganan',
  content: 'Paket Konten',
};

function formatPriceIdr(priceIdr) {
  return `Rp ${Number(priceIdr).toLocaleString('id-ID')}`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function productCardHtml(pack) {
  const description = pack.description || pack.subtitle || '';
  const typeLabel = TYPE_LABELS[pack.type] || pack.type;
  const badgeClass = pack.type === 'subscription' ? 'subscription' : '';

  const media = pack.image_url
    ? `<img src="${escapeHtml(pack.image_url)}" alt="${escapeHtml(pack.name)}" loading="lazy" />`
    : `<div class="placeholder-icon">✨</div>`;

  const ribbon = pack.is_best_value
    ? `<span class="product-ribbon">Best Value</span>`
    : '';

  return `
    <article class="product-card${pack.is_best_value ? ' is-best-value' : ''}">
      <div class="product-media">
        ${media}
        ${ribbon}
      </div>
      <div class="product-body">
        <span class="product-badge ${badgeClass}">${escapeHtml(typeLabel)}</span>
        <h3>${escapeHtml(pack.name)}</h3>
        <p class="product-description">${escapeHtml(description)}</p>
        <p class="product-price">${formatPriceIdr(pack.price_idr)}</p>
        <p class="product-availability">Tersedia di aplikasi</p>
      </div>
    </article>
  `;
}

function showFallback() {
  document.getElementById('product-loading').hidden = true;
  document.getElementById('product-carousel').hidden = true;
  document.getElementById('product-fallback').hidden = false;
}

function showProducts(packs) {
  const carousel = document.getElementById('product-carousel');
  const grid = document.getElementById('product-grid');
  grid.innerHTML = packs.map(productCardHtml).join('');
  document.getElementById('product-loading').hidden = true;
  document.getElementById('product-fallback').hidden = true;
  carousel.hidden = false;
  initProductCarousel(carousel);
}

// Slow, continuous auto-scroll that reverses direction at each end (a
// "ping-pong" sweep) so the track never has to jump. Pauses on any user
// interaction — pointer, wheel, or touch — and resumes shortly after, so
// manual dragging/scrolling always takes priority. Progress is mirrored by
// a row of dots (one per card) below the carousel, instead of a scrollbar.
function initProductCarousel(track) {
  const SPEED_PX_PER_FRAME = 0.4; // slow motion
  const RESUME_DELAY_MS = 2500;

  const dotsContainer = document.getElementById('product-dots');
  const cards = Array.from(track.querySelectorAll('.product-card'));

  let direction = 1;
  let paused = false;
  let resumeTimer = null;
  let rafId = null;

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
    dot.setAttribute('aria-label', `Ke paket ${index + 1}`);
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
    rafId = requestAnimationFrame(tick);
  }

  track.addEventListener('mouseenter', pause);
  track.addEventListener('mouseleave', scheduleResume);
  track.addEventListener('touchstart', pause, { passive: true });
  track.addEventListener('touchend', scheduleResume);
  track.addEventListener('wheel', () => { pause(); scheduleResume(); }, { passive: true });

  // Click-and-drag support for mouse/trackpad users (touch already scrolls
  // natively via overflow-x).
  let isDragging = false;
  let dragStartX = 0;
  let dragStartScroll = 0;

  track.addEventListener('mousedown', (e) => {
    isDragging = true;
    pause();
    dragStartX = e.pageX;
    dragStartScroll = track.scrollLeft;
    track.classList.add('is-dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    track.scrollLeft = dragStartScroll - (e.pageX - dragStartX);
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    track.classList.remove('is-dragging');
    scheduleResume();
  });

  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

async function loadProducts() {
  try {
    const response = await fetch(`${API_BASE_URL}/premium/packs`);
    if (!response.ok) {
      showFallback();
      return;
    }
    const body = await response.json();
    const packs = Array.isArray(body?.data) ? body.data : [];
    if (packs.length === 0) {
      showFallback();
      return;
    }
    showProducts(packs);
  } catch (error) {
    showFallback();
  }
}

document.addEventListener('DOMContentLoaded', loadProducts);
