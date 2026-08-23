// Where a square avatar crop should start on a freshly picked image, and how far it may roam.
//
// Centring the square is right for a landscape or square photo, but wrong for a portrait: people
// frame themselves with the head high in the picture, so the middle of a tall image is the torso.
// A tall picture therefore starts near the top, leaving a small margin above the hair.
const TOP_MARGIN = 0.12;

export function initialCrop(width, height, zoom = 1) {
  const side = Math.min(width, height) / zoom;
  const cx = width / 2;
  const cy = height > width ? side / 2 + (height - side) * TOP_MARGIN : height / 2;
  return { cx, cy, side };
}

// The crop may grow past the short side of a long photo, so a tall subject fits whole with blank
// margins beside it. Zooming out further than the long side would only add empty space.
export function minZoom(width, height) {
  return Math.min(width, height) / Math.max(width, height);
}

// A crop wider than the image cannot be panned along that axis: centre it and let the blank show.
export function clampCrop(cx, cy, side, width, height) {
  const axis = (v, len) => (side >= len ? len / 2 : Math.min(Math.max(v, side / 2), len - side / 2));
  return { cx: axis(cx, width), cy: axis(cy, height) };
}
