/** A QR code as one SVG path in module units, quiet zone included. */
export interface QrShape {
  /** Width and height in modules, quiet zone included: use as the viewBox. */
  size: number;
  /** Dark modules, one subpath per horizontal run. */
  path: string;
}

/** The standard quiet zone. Scanners need it to find the code's edges. */
export const QR_MARGIN = 4;

/**
 * Turns a module matrix into an SVG path, merging each row's runs of dark
 * modules into one rectangle so the path stays small and renders crisp.
 */
export function qrShape(modules: { size: number; data: ArrayLike<number | boolean> }, margin = QR_MARGIN): QrShape {
  const { size, data } = modules;
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && data[y * size + x]) x++;
      path += `M${start + margin} ${y + margin}h${x - start}v1h${start - x}z`;
    }
  }
  return { size: size + margin * 2, path };
}

/**
 * Builds the QR code for a sign-in link in the browser, so the token-bearing
 * image never goes through the server or a log. The encoder (~25 kB) loads on
 * first use rather than with the app.
 */
export async function makeQr(text: string): Promise<QrShape> {
  const mod = await import('qrcode');
  // CommonJS package: the named export or the default one, depending on the bundler
  const create = mod.create ?? (mod as unknown as { default: typeof mod }).default.create;
  return qrShape(create(text, { errorCorrectionLevel: 'M' }).modules);
}
