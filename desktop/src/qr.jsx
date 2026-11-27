// A QR code drawn client-side as one SVG path (qrcode-generator does the
// encoding). Nothing is fetched and no HTML string is injected.
import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** The dark modules of `text` as a square matrix of booleans. */
export function qrMatrix(text, level = "M") {
  const code = qrcode(0, level);
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => code.isDark(row, col)));
}

/** One `M x y h1 v1 h-1 z` square per dark module, offset by the quiet zone. */
export function qrPath(matrix, margin = 4) {
  let path = "";
  matrix.forEach((cells, row) => cells.forEach((dark, col) => {
    if (dark) path += `M${col + margin} ${row + margin}h1v1h-1z`;
  }));
  return path;
}

export function QrCode({ text, size = 176, label }) {
  const { path, extent } = useMemo(() => {
    const matrix = qrMatrix(text);
    return { path: qrPath(matrix), extent: matrix.length + 8 };
  }, [text]);
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label ?? `QR code for ${text}`}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      data-testid="qr-code"
    >
      {/* Always dark on white, also in dark mode: phone cameras expect it. */}
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
