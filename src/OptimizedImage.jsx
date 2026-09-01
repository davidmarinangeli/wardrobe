import { forwardRef, useCallback, useState } from "react";
import { Image } from "@unpic/react";

const IPX_OPTIONS = { ipx: { baseURL: "/_ipx" } };
const DEFAULT_BREAKPOINTS = [160, 240, 320, 480, 640, 800, 960, 1280];

function sourcePath(src) {
  if (!src || typeof src !== "string") return src;
  return src.split(/[?#]/, 1)[0];
}

export const OptimizedImage = forwardRef(function OptimizedImage({
  src,
  alt = "",
  sizes = "100vw",
  breakpoints = DEFAULT_BREAKPOINTS,
  quality = 80,
  priority = false,
  loading,
  decoding,
  onLoad,
  ...props
}, ref) {
  const normalizedSource = sourcePath(src);

  // Large photos (modeled shots are ~1264x848) stream in top-down. Without a
  // loaded flag the card sits half-painted for seconds and reads as broken;
  // `data-loaded` lets the stylesheet hold a placeholder until it lands.
  const [loaded, setLoaded] = useState(false);

  const handleLoad = useCallback((event) => {
    setLoaded(true);
    onLoad?.(event);
  }, [onLoad]);

  // An image restored from cache can be complete before React attaches onLoad.
  const markIfCached = useCallback((node) => {
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
    if (node?.complete && node.naturalWidth) setLoaded(true);
  }, [ref]);

  const shared = { "data-loaded": loaded || undefined, onLoad: handleLoad };

  if (!normalizedSource || normalizedSource.startsWith("data:") || normalizedSource.startsWith("blob:") || normalizedSource.startsWith("/api/")) {
    return <img ref={markIfCached} src={src} alt={alt} sizes={sizes} loading={loading || (priority ? "eager" : "lazy")} decoding={decoding || "async"} {...shared} {...props} />;
  }

  return (
    <Image
      ref={markIfCached}
      src={normalizedSource}
      alt={alt}
      fallback="ipx"
      options={IPX_OPTIONS}
      operations={{ ipx: { quality } }}
      layout="fullWidth"
      unstyled
      sizes={sizes}
      breakpoints={breakpoints}
      priority={priority}
      loading={loading}
      decoding={decoding}
      {...shared}
      {...props}
    />
  );
});
