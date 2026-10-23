// Product catalogue in REESOLVE's format: each entry is a product "row" with a
// `shades` array of { name, hex, undertone, depth?, available?, image_url? }.
// Keyed by entity catalog category (see entities.js). PLACEHOLDERS — replace this
// object with their real CatalogProduct export (same shape); lookShade() unchanged.

export const CATALOG = {
  // ── Lips ──
  'lip-liner': {
    id: 'smashbox-studio-liner', brand: 'Smashbox', name: 'Studio Extreme Longwear Lip Liner',
    category: 'lip-liner', format: 'pencil',
    shades: [
      { name: 'Nude Pink', hex: '#B87A74', undertone: 'neutral' },
      { name: 'Rosewood', hex: '#9E5F63', undertone: 'cool' },
      { name: 'Berry', hex: '#7E2A4E', undertone: 'cool' },
      { name: 'Brick', hex: '#9C4A3C', undertone: 'warm' },
    ],
  },
  lipstick: {
    id: 'mac-satin', brand: 'MAC', name: 'Satin Lipstick',
    category: 'lipstick', format: 'bullet',
    shades: [
      { name: 'Nude Rose', hex: '#C98F8A', undertone: 'neutral' },
      { name: 'Mauve', hex: '#9A5C6E', undertone: 'cool' },
      { name: 'Berry', hex: '#8E2F5A', undertone: 'cool' },
      { name: 'Classic Red', hex: '#B52532', undertone: 'warm' },
      { name: 'Coral', hex: '#E06A50', undertone: 'warm' },
    ],
  },
  // ── Eyes ──
  eyeshadow: {
    id: 'ct-luxury-palette', brand: 'Charlotte Tilbury', name: 'Luxury Palette',
    category: 'eyeshadow', format: 'powder',
    shades: [
      { name: 'Taupe', hex: '#8A7466', undertone: 'neutral' },
      { name: 'Soft Beige', hex: '#B49C86', undertone: 'warm' },
      { name: 'Cocoa', hex: '#6E5140', undertone: 'warm' },
      { name: 'Plum', hex: '#6E3B57', undertone: 'cool' },
    ],
  },
  eyeliner: {
    id: 'stila-stay-all-day', brand: 'Stila', name: 'Stay All Day Liquid Eyeliner',
    category: 'eyeliner', format: 'liquid',
    shades: [
      { name: 'Intense Black', hex: '#0A0A0A', undertone: 'neutral' },
      { name: 'Brown', hex: '#3A2A20', undertone: 'warm' },
    ],
  },
  mascara: {
    id: 'loreal-lash-paradise', brand: "L'Oréal Paris", name: 'Lash Paradise Mascara',
    category: 'mascara', format: 'liquid',
    shades: [{ name: 'Blackest Black', hex: '#0A0A0A', undertone: 'neutral' }],
  },
  brows: {
    id: 'benefit-precisely', brand: 'Benefit', name: 'Precisely, My Brow Pencil',
    category: 'brows', format: 'pencil',
    shades: [
      { name: 'Soft Brown', hex: '#5A4436', undertone: 'neutral' },
      { name: 'Deep Brown', hex: '#3C2C22', undertone: 'neutral' },
      { name: 'Taupe', hex: '#6B5A4A', undertone: 'cool' },
      { name: 'Ebony', hex: '#241A14', undertone: 'neutral' },
    ],
  },
  // ── Face ──
  foundation: {
    id: 'nars-light-reflecting', brand: 'NARS', name: 'Light Reflecting Foundation',
    category: 'foundation', format: 'liquid',
    shades: [
      { name: 'Ivory', hex: '#E8C4A6', undertone: 'neutral', depth: 'light' },
      { name: 'Beige', hex: '#D9AC86', undertone: 'warm', depth: 'medium' },
      { name: 'Sand', hex: '#C89A72', undertone: 'warm', depth: 'medium tan' },
      { name: 'Amber', hex: '#9A6B47', undertone: 'warm', depth: 'tan' },
    ],
  },
  concealer: {
    id: 'maybelline-eraser', brand: 'Maybelline', name: 'Instant Age Rewind Concealer',
    category: 'concealer', format: 'liquid',
    shades: [
      { name: 'Light', hex: '#F2DDC6', undertone: 'neutral', depth: 'light' },
      { name: 'Medium', hex: '#E0B994', undertone: 'warm', depth: 'medium' },
      { name: 'Deep', hex: '#B88458', undertone: 'warm', depth: 'tan' },
    ],
  },
  blush: {
    id: 'rare-soft-pinch', brand: 'Rare Beauty', name: 'Soft Pinch Liquid Blush',
    category: 'blush', format: 'liquid',
    shades: [
      { name: 'Rose Flush', hex: '#D77A86', undertone: 'cool' },
      { name: 'Peach Pinch', hex: '#E89477', undertone: 'warm' },
      { name: 'Berry Pinch', hex: '#B5476B', undertone: 'cool' },
    ],
  },
  highlight: {
    id: 'ct-hollywood-glow', brand: 'Charlotte Tilbury', name: 'Hollywood Glow Glide Highlighter',
    category: 'highlighter', format: 'cream',
    shades: [
      { name: 'Champagne', hex: '#F5ECD6', undertone: 'warm' },
      { name: 'Rose Gold', hex: '#F0D9C0', undertone: 'warm' },
    ],
  },
};
