// Product catalogue in REESOLVE's format: each entry is a product "row" with a
// `shades` array of { name, hex, undertone, depth?, available?, image_url? }.
// These are PLACEHOLDERS — replace this object with their real catalogue export
// (same shape) and the lesson picks shades through lookShade() unchanged.
//
// Keyed by the lesson step; one row per step. A row may also carry a flat `hex`
// used when `shades` is empty.

export const CATALOG = {
  lips: {
    id: 'smashbox-studio-liner',
    brand: 'Smashbox',
    name: 'Studio Extreme Longwear Lip Liner',
    category: 'lip',
    format: 'pencil',
    shades: [
      { name: 'Nude Pink', hex: '#C98F8A', undertone: 'neutral' },
      { name: 'Rosewood', hex: '#9E5F63', undertone: 'cool' },
      { name: 'Berry', hex: '#8E2F5A', undertone: 'cool' },
      { name: 'Classic Red', hex: '#B52532', undertone: 'warm' },
      { name: 'Clear Petal', hex: '#D7A5A0', undertone: 'neutral' },
    ],
  },
  eyes: {
    id: 'ct-luxury-palette',
    brand: 'Charlotte Tilbury',
    name: 'Luxury Palette',
    category: 'eyeshadow',
    format: 'powder',
    shades: [
      { name: 'Taupe', hex: '#8A7466', undertone: 'neutral' },
      { name: 'Soft Beige', hex: '#B49C86', undertone: 'warm' },
      { name: 'Cocoa', hex: '#6E5140', undertone: 'warm' },
      { name: 'Champagne', hex: '#E8D7B0', undertone: 'warm' },
    ],
  },
  lashes: {
    id: 'loreal-lash-paradise',
    brand: "L'Oréal Paris",
    name: 'Lash Paradise Mascara',
    category: 'mascara',
    format: 'liquid',
    hex: '#0A0A0A',
    shades: [{ name: 'Blackest Black', hex: '#0A0A0A', undertone: 'neutral' }],
  },
  face: {
    id: 'nars-light-reflecting',
    brand: 'NARS',
    name: 'Light Reflecting Foundation',
    category: 'foundation',
    format: 'liquid',
    shades: [
      { name: 'Ivory', hex: '#E8C4A6', undertone: 'neutral', depth: 'light' },
      { name: 'Beige', hex: '#D9AC86', undertone: 'warm', depth: 'medium' },
      { name: 'Sand', hex: '#C89A72', undertone: 'warm', depth: 'medium tan' },
      { name: 'Amber', hex: '#9A6B47', undertone: 'warm', depth: 'tan' },
    ],
  },
  blush: {
    id: 'rare-soft-pinch',
    brand: 'Rare Beauty',
    name: 'Soft Pinch Liquid Blush',
    category: 'blush',
    format: 'liquid',
    shades: [
      { name: 'Rose Flush', hex: '#D77A86', undertone: 'cool' },
      { name: 'Peach Pinch', hex: '#E89477', undertone: 'warm' },
      { name: 'Berry Pinch', hex: '#B5476B', undertone: 'cool' },
    ],
  },
  concealer: {
    id: 'maybelline-eraser',
    brand: 'Maybelline',
    name: 'Instant Age Rewind Concealer',
    category: 'concealer',
    format: 'liquid',
    shades: [{ name: 'Brightener', hex: '#F2E2D2', undertone: 'neutral' }],
  },
  contour: {
    id: 'fenty-matchstix',
    brand: 'Fenty Beauty',
    name: 'Match Stix Contour Skinstick',
    category: 'contour',
    format: 'cream',
    shades: [
      { name: 'Amber (cool taupe)', hex: '#6B5548', undertone: 'cool' },
      { name: 'Mocha', hex: '#52403A', undertone: 'cool' },
    ],
  },
  highlight: {
    id: 'ct-hollywood-glow',
    brand: 'Charlotte Tilbury',
    name: 'Hollywood Glow Glide Highlighter',
    category: 'highlighter',
    format: 'cream',
    shades: [{ name: 'Champagne', hex: '#F5ECD6', undertone: 'warm' }],
  },
};