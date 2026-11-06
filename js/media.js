// Images, barcode scanner, OCR and Open Food Facts lookup
import { loadScript } from './utils.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

// ── Images ───────────────────────────────────────────────
async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {}
  }
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  return img;
}

/** Downscale to `max` px on the longest side, returns a JPEG Blob */
export async function resizeImage(file, max = 1600, quality = 0.82) {
  const img = await decode(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}

/** Small square center-cropped thumbnail as data URL (stored in the sheet) */
export async function thumbDataUrl(file, size = 112) {
  const img = await decode(file);
  const s = Math.min(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.7);
}

// ── Open Food Facts ──────────────────────────────────────
export async function lookupBarcode(code, lang = 'en') {
  if (!/^\d{8,14}$/.test(code)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const fields = `product_name,product_name_${lang},brands,image_front_small_url,quantity`;
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`, {
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== 1 || !j.product) return null;
    const p = j.product;
    let name = (p[`product_name_${lang}`] || p.product_name || '').trim();
    const qty = (p.quantity || '').trim();
    if (name && qty && !name.toLowerCase().includes(qty.toLowerCase())) name += ' ' + qty;
    return { name, brand: (p.brands || '').split(',')[0].trim(), image: p.image_front_small_url || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Barcode / QR scanner ─────────────────────────────────
const SCANNER_LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

export function scanBarcode() {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'scanner';
    root.innerHTML = `
      <div class="scanner-top">
        <span>${t('scan.title')}</span>
        <button class="icon-btn on-dark" data-close aria-label="${t('common.close')}">${icon('x')}</button>
      </div>
      <div class="scanner-stage"><div id="qr-reader"></div><div class="scanner-msg" hidden></div></div>
      <div class="scanner-bottom">
        <p>${t('scan.hint')}</p>
        <label class="btn ghost on-dark">${icon('image')} ${t('scan.fromPhoto')}<input type="file" accept="image/*" hidden></label>
      </div>`;
    document.body.appendChild(root);
    document.body.classList.add('no-scroll');

    let scanner = null;
    let done = false;
    const msg = root.querySelector('.scanner-msg');
    const showMsg = (text) => {
      msg.hidden = false;
      msg.textContent = text;
    };

    async function stop() {
      if (scanner) {
        try {
          if (scanner.isScanning) await scanner.stop();
        } catch {}
        try {
          scanner.clear();
        } catch {}
      }
    }
    async function finish(value) {
      if (done) return;
      done = true;
      await stop();
      root.remove();
      document.body.classList.remove('no-scroll');
      if (value) navigator.vibrate?.(60);
      resolve(value || null);
    }

    root.querySelector('[data-close]').onclick = () => finish(null);
    root.querySelector('input[type=file]').onchange = async (ev) => {
      const file = ev.target.files[0];
      if (!file || !scanner) return;
      await stop();
      try {
        const res = await scanner.scanFile(file, false);
        finish(res);
      } catch {
        showMsg(t('scan.notFound'));
      }
    };

    loadScript(SCANNER_LIB)
      .then(async () => {
        if (done) return;
        const F = window.Html5QrcodeSupportedFormats;
        scanner = new window.Html5Qrcode('qr-reader', {
          verbose: false,
          formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE, F.DATA_MATRIX],
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        });
        try {
          await scanner.start(
            { facingMode: 'environment' },
            {
              fps: 12,
              qrbox: (w, h) => ({
                width: Math.max(120, Math.floor(Math.min(w * 0.85, 380))),
                height: Math.max(80, Math.floor(Math.min(h * 0.45, 220))),
              }),
            },
            (text) => finish(text),
            () => {}
          );
        } catch (e) {
          console.warn(e);
          showMsg(t('scan.noCamera'));
        }
      })
      .catch(() => showMsg(t('scan.libError')));
  });
}

// ── OCR price reader ─────────────────────────────────────
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

/** Returns candidate prices (most likely first), based on the font size of the digits */
export async function readPrices(file, onProgress) {
  await loadScript(TESSERACT);
  const img = await resizeImage(file, 1400, 0.9);
  const { data } = await window.Tesseract.recognize(img, 'eng', {
    logger: (m) => m.status === 'recognizing text' && onProgress?.(m.progress),
  });
  const found = [];
  for (const w of data.words || []) {
    const txt = w.text.replace(/[^\d.,]/g, '');
    const m = txt.match(/^(\d{1,4})[.,](\d{2})$/);
    if (m) found.push({ value: parseFloat(`${m[1]}.${m[2]}`), h: w.bbox.y1 - w.bbox.y0 });
  }
  for (const m of (data.text || '').matchAll(/(\d{1,4})[.,](\d{2})(?!\d)/g)) {
    found.push({ value: parseFloat(`${m[1]}.${m[2]}`), h: 0 });
  }
  found.sort((a, b) => b.h - a.h);
  return [...new Set(found.map((f) => f.value).filter((v) => v > 0))].slice(0, 4);
}
