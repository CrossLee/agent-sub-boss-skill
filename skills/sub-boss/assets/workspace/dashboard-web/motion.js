// Presentation-only motion. Task state and evidence never change in this module.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const blockSelector = ".page-heading, .overview-hero, .priority-card, .attention-row, .evidence-overview, .board-card, .task-table tbody tr, .detail-section, .theme-option";
const observed = new Set();
const revealed = new WeakSet();
const animations = new Map();
const counters = new Map();
let counterFrame = 0;
let pointerFrame = 0;
let pointerCard = null;
let pointerPosition = null;

export function motionEnabled() {
  return !document.documentElement.classList.contains("motion-paused") && !reducedMotion.matches && !document.hidden;
}

function tween(element, frames, options) {
  if (!element?.isConnected || !motionEnabled()) return;
  const animation = element.animate(frames, { duration: 850, easing: "cubic-bezier(.2,.75,.2,1)", ...options });
  animations.set(animation, element);
  animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
  return animation;
}

function tickCounters(now) {
  for (const [element, run] of counters) {
    if (!element.isConnected) { counters.delete(element); continue; }
    const progress = Math.max(0, Math.min(1, (now - run.start) / run.duration));
    const eased = 1 - Math.pow(1 - progress, 4);
    element.textContent = String(Math.round(run.value * eased));
    if (progress >= 1) counters.delete(element);
  }
  counterFrame = counters.size ? requestAnimationFrame(tickCounters) : 0;
}

function countUp(root, delay = 0) {
  root.querySelectorAll("[data-count-value]").forEach((element) => {
    const value = Number(element.dataset.countValue);
    if (!Number.isFinite(value) || value < 0) return;
    if (!motionEnabled() || value === 0) { element.textContent = String(value); return; }
    element.textContent = "0";
    counters.set(element, { value, start: performance.now() + delay, duration: 1600 });
  });
  if (counters.size && !counterFrame) counterFrame = requestAnimationFrame(tickCounters);
}

function playBlock(element) {
  if (!motionEnabled()) return;
  const delay = Number(element.dataset.motionDelay || 0);
  const isCard = element.matches(".priority-card, .board-card, .theme-option");
  const isRow = element.matches("tr, .attention-row");
  tween(element, [
    { opacity: 0, transform: isRow ? "translateX(-14px)" : `translateY(${isCard ? 28 : 18}px) scale(${isCard ? .965 : .99})` },
    { opacity: 1, transform: "translate(0,0) scale(1)" },
  ], { duration: isCard ? 1000 : 800, delay, fill: "backwards" });
  countUp(element, delay + 160);
  element.querySelectorAll(".meter-track > span").forEach((bar, index) => {
    tween(bar, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 1350, delay: delay + index * 110, fill: "backwards" });
  });
  const cover = element.querySelector(".chart-cover");
  if (cover) tween(cover, [{ "--chart-reveal": "0deg" }, { "--chart-reveal": "360deg" }], { duration: 1850, delay: 200, fill: "backwards", easing: "cubic-bezier(.2,.7,.25,1)" });
  element.querySelectorAll(".evidence-cell").forEach((cell, index) => {
    tween(cell, [{ opacity: 0, transform: "translateY(12px) scale(.94)" }, { opacity: 1, transform: "none" }], { delay: delay + index * 85, duration: 650, fill: "backwards" });
  });
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    entry.target.classList.toggle("motion-offscreen", !entry.isIntersecting);
    if (!entry.isIntersecting) {
      for (const [animation, element] of animations) {
        if (entry.target === element || entry.target.contains(element)) { animation.cancel(); animations.delete(animation); }
      }
      for (const [element, run] of counters) {
        if (entry.target.contains(element)) { element.textContent = String(run.value); counters.delete(element); }
      }
    }
    if (entry.isIntersecting && !revealed.has(entry.target)) {
      revealed.add(entry.target);
      playBlock(entry.target);
    }
  }
}, { threshold: .08 });

function prune() {
  for (const element of observed) {
    if (!element.isConnected) { observer.unobserve(element); observed.delete(element); }
  }
  for (const [animation, element] of animations) {
    if (!element.isConnected) { animation.cancel(); animations.delete(animation); }
  }
  for (const element of counters.keys()) if (!element.isConnected) counters.delete(element);
}

export function animateIn(root, { replay = false } = {}) {
  if (!root) return;
  prune();
  const blocks = [...root.querySelectorAll(blockSelector)];
  if (root.matches?.(blockSelector)) blocks.unshift(root);
  const groupIndexes = new Map();
  for (const element of blocks) {
    const group = element.parentElement;
    const index = groupIndexes.get(group) || 0;
    groupIndexes.set(group, index + 1);
    element.dataset.motionDelay = String(Math.min(index * 95, 480));
    if (!observed.has(element)) { observed.add(element); observer.observe(element); }
    if (replay) {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      if (visible) { revealed.add(element); playBlock(element); }
    }
  }
}

function settle() {
  for (const animation of animations.keys()) animation.cancel();
  animations.clear();
  for (const [element, run] of counters) element.textContent = String(run.value);
  counters.clear();
  cancelAnimationFrame(counterFrame);
  counterFrame = 0;
  resetPointer();
}

export function replayMotion(root = document.querySelector("#pageContent")) {
  settle();
  if (motionEnabled()) animateIn(root, { replay: true });
}

export function syncMotion() {
  document.body.classList.toggle("page-hidden", document.hidden);
  if (!motionEnabled()) settle();
  document.dispatchEvent(new CustomEvent("motionpreferencechange"));
}

function resetPointer() {
  if (pointerCard) {
    pointerCard.style.removeProperty("--tilt-x");
    pointerCard.style.removeProperty("--tilt-y");
  }
  pointerCard = null;
  pointerPosition = null;
  cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
}

document.addEventListener("pointermove", (event) => {
  if (!motionEnabled() || event.pointerType !== "mouse") return;
  const card = event.target.closest(".priority-card, .board-card");
  if (!card) { resetPointer(); return; }
  if (pointerCard !== card) resetPointer();
  pointerCard = card;
  pointerPosition = { x: event.clientX, y: event.clientY };
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    if (!pointerCard?.isConnected || !pointerPosition) return;
    const bounds = pointerCard.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (pointerPosition.x - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (pointerPosition.y - bounds.top) / bounds.height));
    pointerCard.style.setProperty("--tilt-x", `${(0.5 - y) * 5}deg`);
    pointerCard.style.setProperty("--tilt-y", `${(x - 0.5) * 5}deg`);
    pointerCard.style.setProperty("--pointer-x", `${x * 100}%`);
    pointerCard.style.setProperty("--pointer-y", `${y * 100}%`);
  });
}, { passive: true });
document.addEventListener("pointerout", (event) => { if (!event.relatedTarget) resetPointer(); });
document.addEventListener("visibilitychange", syncMotion);
reducedMotion.addEventListener("change", syncMotion);
syncMotion();
