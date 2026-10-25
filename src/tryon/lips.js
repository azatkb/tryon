// MediaPipe Face Mesh lip landmark indices (468/478-point canonical mesh).
// Ordered to trace a continuous boundary so they form a fillable polygon.

// Outer lip boundary: upper-outer left->right, then lower-outer right->left.
export const LIPS_OUTER = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, // upper outer  (L -> R)
  375, 321, 405, 314, 17, 84, 181, 91, 146,         // lower outer  (R -> L)
];

// Inner lip boundary (the mouth opening) — cut out so we don't paint teeth/tongue.
export const LIPS_INNER = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, // upper inner  (L -> R)
  324, 318, 402, 317, 14, 87, 178, 88, 95,           // lower inner  (R -> L)
];

// A few lower-lip points, used to find a centroid for the gloss highlight.
export const LOWER_LIP = [17, 84, 314, 405, 321, 375, 146, 91, 181];
