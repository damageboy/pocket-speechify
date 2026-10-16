// Computed colors are not necessarily rgb(): Chrome preserves color(), oklch(),
// etc. Let its canvas color parser convert those to rendered sRGB, not a regex
// that mistakes lightness/chroma/hue for red/green/blue.
let colorContext;
function readColor(value) {
  if (!value || value === 'transparent') return [0, 0, 0, 0];
  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const [r, g, b, a = 1] = rgb[1].split(/[,\s/]+/).map(Number);
    return [r, g, b, a];
  }
  colorContext ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = value;
  colorContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

function composite([r, g, b, a = 1], background) {
  return [r, g, b].map((channel, i) => channel * a + background[i] * (1 - a));
}

function backgroundColor(element) {
  const layers = [];
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.backgroundImage && style.backgroundImage !== 'none') return null;
    const color = readColor(style.backgroundColor);
    layers.push(color);
    if (color[3] === 1) break;
  }
  // Pages with no painted background normally use the browser's white canvas.
  // A dark UA canvas is not necessarily black: leave it unchanged when unknown.
  if (layers.every(color => color[3] < 1) && getComputedStyle(document.documentElement).colorScheme.includes('dark')) return null;
  return layers.reverse().reduce((background, color) => composite(color, background), [255, 255, 255]);
}

const linear = channel => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
function luminance(rgb) {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Oklab conversion matrices: https://www.w3.org/TR/css-color-4/#color-conversion-code
function oklab(rgb) {
  const [r, g, b] = rgb.map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function lavender(lightness, chroma) {
  // Keep our blue/lavender hue (280 degrees), reducing chroma to fit sRGB.
  for (let c = chroma; ; c *= 0.8) {
    const a = c * Math.cos(280 * Math.PI / 180), b = c * Math.sin(280 * Math.PI / 180);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (rgb.every(value => value >= 0 && value <= 1) || c < 0.0001) {
      return rgb.map(value => Math.round(255 * Math.max(0, Math.min(1,
        value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055))));
    }
  }
}

const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const cssColor = rgb => `rgb(${rgb.join(', ')})`;
const fallback = { paragraph: 'transparent', word: 'transparent', underline: true };

/** Pick fills for all text in a DOM range, preserving its foreground colors. */
export function highlightColors(range) {
  const root = range.commonAncestorContainer;
  const elements = new Set();
  if (root.nodeType === Node.TEXT_NODE) elements.add(root.parentElement);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent.trim() && range.intersectsNode(node)) elements.add(node.parentElement);
    }
  }
  const samples = [];
  for (const element of elements) {
    // These effects change the final pixels, not just the declared background.
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if ((style.opacity && Number(style.opacity) < 1) ||
          (style.filter && style.filter !== 'none') ||
          (style.mixBlendMode && style.mixBlendMode !== 'normal')) return fallback;
    }
    const style = getComputedStyle(element);
    const foreground = readColor(style.getPropertyValue('-webkit-text-fill-color') || style.color);
    const background = backgroundColor(element);
    if (!background || !foreground[3]) return fallback;
    const original = contrast(composite(foreground, background), background);
    samples.push({ foreground, background, minimum: Math.max(4.5, Math.min(7, original)) });
  }
  if (!samples.length) return fallback;

  const base = oklab(samples[0].background);
  const direction = luminance(composite(samples[0].foreground, samples[0].background)) < luminance(samples[0].background) ? -1 : 1;
  function choose(chroma, offset) {
    const target = base[0] + direction * offset;
    const candidates = [];
    for (let step = 0; step <= 100; step++) {
      const rgb = lavender(step / 100, chroma);
      const ratios = samples.map(sample => contrast(composite(sample.foreground, rgb), rgb));
      const safe = samples.every((sample, i) => ratios[i] >= sample.minimum &&
        (luminance(composite(sample.foreground, rgb)) > luminance(rgb)) ===
        (luminance(composite(sample.foreground, sample.background)) > luminance(sample.background)));
      if (safe) candidates.push({ rgb, enhanced: ratios.every(ratio => ratio >= 7), cost: Math.abs(step / 100 - target) });
    }
    // Prefer 7:1 whenever possible. Never lower existing contrast below 7:1
    // (or its original value if already below 7), with an absolute 4.5:1 floor.
    candidates.sort((a, b) => Number(b.enhanced) - Number(a.enhanced) || a.cost - b.cost);
    return candidates[0]?.rgb;
  }
  const paragraph = choose(0.025, 0.06), word = choose(0.085, 0.16);
  if (!paragraph || !word) return fallback;
  // A perceptual separation target, not an accessibility contrast threshold.
  // When contrast constraints squeeze the two fills together, add a word cue.
  const underline = distance(oklab(paragraph), oklab(word)) < 0.06;
  return { paragraph: cssColor(paragraph), word: cssColor(word), underline };
}
