/** The filter itself. Rendered once, referenced by `backdrop-filter: url(#id)`. */
export function GlassFilter({ svg }) {
  if (!svg) return null;
  const { id, width, height, mapUrl, scale } = svg;
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }}>
      <filter
        id={id}
        x="0"
        y="0"
        width={width}
        height={height}
        filterUnits="userSpaceOnUse"
        primitiveUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feImage href={mapUrl} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result="map" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={scale}
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
