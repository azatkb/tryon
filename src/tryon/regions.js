// Eyeshadow regions, derived from MediaPipe Face Mesh.
// We take each eye's upper lash line and build a band ABOVE it (toward the brow)
// by offsetting the lash points upward by a fraction of the eye's height — this
// hugs the eye shape and sits on the lid without covering the eyeball.

// Upper lash line (outer corner -> inner corner).
export const EYE_R_LASH = [33, 246, 161, 160, 159, 158, 157, 173, 133];
export const EYE_L_LASH = [263, 466, 388, 387, 386, 385, 384, 398, 362];

// Vertical reference (upper lid centre, lower lid centre) to gauge eye height.
export const EYE_R_V = [159, 145];
export const EYE_L_V = [386, 374];

// How far up the lid the shadow reaches, in multiples of eye height.
export const EYE_LIFT = 1.35;

// Full eye opening (upper + lower lid) — used to cut eyes out of the foundation mask.
export const EYE_R_FULL = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
export const EYE_L_FULL = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];

// Nose region (bridge → sides → alae → base) — used to keep makeup off the nose.
export const NOSE = [6, 129, 98, 2, 327, 358];

// Eyebrow outlines (closed loops: upper edge → lower edge) for brow fill/tint.
export const BROW_R = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
export const BROW_L = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];

// Cheek apples (blush centres) and face-width refs for the blush radius.
export const CHEEK_R = 205;
export const CHEEK_L = 425;
export const FACE_SIDE_L = 234;
export const FACE_SIDE_R = 454;

// Face oval (jaw + forehead perimeter) — the foundation region.
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
