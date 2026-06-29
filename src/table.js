// table.js — snooker table geometry. SI units (metres), long axis = x, origin at centre.
//
// Pockets model (pragmatic, the carrom approach): the four rails are treated as full
// axis-aligned cushions and each pocket is a capture CIRCLE; at every step the earliest of
// {cushion bounce, pocket capture} wins, so a ball heading into a pocket is swallowed before
// it can bounce. Corner pockets sit at the rail corners; middle pockets sit on the long rails.
//
// NOTE (faithful-geometry TODO): real pockets have angled JAWS that can rattle a ball back
// out. That needs general ball-vs-segment cushions (finite rails with gaps + diagonal jaw
// segments) and diagonal reflection in collisions.resolveWall. The circle-capture model below
// plays correctly (including middle pockets) but never rattles. Left as a documented
// enhancement so the rest of the game (rules, AI, UI) can be built and played now.

// Inner playing area: 11ft 8.5in × 5ft 10in.
export const TABLE = {
  width: 3.569,
  height: 1.778,
  // Capture radii. Generous in this circle-only model (no jaws): a corner pocket must swallow
  // the ball BEFORE the full-length rail intercepts it ~0.058 m out, so the radius is larger
  // than a real pocket mouth. The consequence is that near-misses pot instead of rattling —
  // acceptable until segmented cushions + angled jaws land (see header TODO).
  cornerPocket: 0.07,
  middlePocket: 0.06,
  baulkFromCushion: 0.737, // baulk line distance from the baulk (−x) cushion face
  dRadius: 0.292, // radius of the "D"
  blackFromTopCushion: 0.324, // black spot distance from the top (+x) cushion face
};

export const HX = TABLE.width / 2;
export const HY = TABLE.height / 2;

// Memoised: the table geometry is constant, but bounds()/pockets() are called on every one of the
// ~thousands of simulations per AI move. Returning cached instances removes that allocation churn.
// (Callers treat both as read-only — verified — so sharing one instance is safe.)
let _bounds;
export const bounds = () => (_bounds ??= { minX: -HX, maxX: HX, minY: -HY, maxY: HY });

// Six pockets: 4 corners + 2 middles (on the long rails at x = 0).
let _pockets;
export const pockets = () =>
  (_pockets ??= [
    { center: { x: -HX, y: -HY }, radius: TABLE.cornerPocket },
    { center: { x: HX, y: -HY }, radius: TABLE.cornerPocket },
    { center: { x: -HX, y: HY }, radius: TABLE.cornerPocket },
    { center: { x: HX, y: HY }, radius: TABLE.cornerPocket },
    { center: { x: 0, y: -HY }, radius: TABLE.middlePocket },
    { center: { x: 0, y: HY }, radius: TABLE.middlePocket },
  ]);

// Standard spot positions. Baulk is at −x; the D bulges toward baulk.
export const baulkX = () => -HX + TABLE.baulkFromCushion;
export const spots = () => {
  const bx = baulkX();
  return {
    yellow: { x: bx, y: -TABLE.dRadius }, // right end of the baulk line (player's view)
    green: { x: bx, y: TABLE.dRadius }, // left end
    brown: { x: bx, y: 0 }, // middle of the baulk line
    blue: { x: 0, y: 0 }, // centre spot
    pink: { x: HX / 2, y: 0 }, // midway between centre and the top cushion
    black: { x: HX - TABLE.blackFromTopCushion, y: 0 },
  };
};

// The "D": semicircle of radius dRadius centred on the brown spot, opening toward −x (baulk).
// A point (x,y) is in the D if it's on/behind the baulk line and within the radius.
export const dCentre = () => ({ x: baulkX(), y: 0 });
export function inD(x, y, ballR = 0) {
  const c = dCentre();
  const dx = x - c.x;
  const dy = y - c.y;
  return dx <= 1e-9 && dx * dx + dy * dy <= (TABLE.dRadius - ballR) * (TABLE.dRadius - ballR) && x >= -HX + ballR;
}
