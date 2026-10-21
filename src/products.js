// Prototype product catalogue. Brands/shades are fictional placeholders for the
// demo — in production these rows come from REESOLVE's real brand/shade data
// (measured or brand-supplied colour), keyed by SKU.
export const PRODUCTS = [
  { id: 'lume-vm-red',    brand: 'Lumé',       line: 'Velvet Matte', shade: 'Classic Red',  hex: '#B52532', finish: 'matte' },
  { id: 'lume-vm-brick',  brand: 'Lumé',       line: 'Velvet Matte', shade: 'Brick',        hex: '#A14B3C', finish: 'matte' },
  { id: 'at9-sk-coral',   brand: 'Atelier 9',  line: 'Satin Kiss',   shade: 'Coral Heat',   hex: '#E06A50', finish: 'satin' },
  { id: 'at9-sk-berry',   brand: 'Atelier 9',  line: 'Satin Kiss',   shade: 'Berry',        hex: '#8E2F5A', finish: 'satin' },
  { id: 'noir-pp-plum',   brand: 'Noir Rouge', line: 'Pure Pigment', shade: 'Deep Plum',    hex: '#6E2746', finish: 'matte' },
  { id: 'noir-pp-ox',     brand: 'Noir Rouge', line: 'Pure Pigment', shade: 'Oxblood',      hex: '#6B1F2A', finish: 'matte' },
  { id: 'soft-dt-nude',   brand: 'Söft',       line: 'Daily Tint',   shade: 'Nude Rose',    hex: '#B47A74', finish: 'satin' },
  { id: 'soft-dt-mauve',  brand: 'Söft',       line: 'Daily Tint',   shade: 'Mauve',        hex: '#9A5C6E', finish: 'satin' },
  { id: 'glace-hs-cherry',brand: 'Glacé',      line: 'High Shine',   shade: 'Cherry Gloss', hex: '#C0304A', finish: 'gloss' },
  { id: 'glace-hs-peony', brand: 'Glacé',      line: 'High Shine',   shade: 'Peony',        hex: '#D66A86', finish: 'gloss' },
];

// Eyeshadow shades (placeholder palette for the demo).
export const EYE_SHADES = [
  { id: 'eye-bronze', brand: 'Atelier 9', shade: 'Bronze',   hex: '#9A6B3F' },
  { id: 'eye-copper', brand: 'Atelier 9', shade: 'Copper',   hex: '#B5602F' },
  { id: 'eye-taupe',  brand: 'Söft',      shade: 'Taupe',    hex: '#8A7466' },
  { id: 'eye-plum',   brand: 'Noir Rouge',shade: 'Plum',     hex: '#6E3B57' },
  { id: 'eye-emerald',brand: 'Noir Rouge',shade: 'Emerald',  hex: '#2F6E5A' },
  { id: 'eye-navy',   brand: 'Lumé',      shade: 'Navy',     hex: '#34415E' },
  { id: 'eye-rose',   brand: 'Lumé',      shade: 'Rose Gold',hex: '#C08A74' },
];

// Foundation shades (skin tones) — subtle, evens the complexion.
export const FOUNDATION_SHADES = [
  { id: 'fnd-porcelain', shade: 'Porcelain', hex: '#F0D3BE' },
  { id: 'fnd-ivory',     shade: 'Ivory',     hex: '#E8C4A6' },
  { id: 'fnd-beige',     shade: 'Beige',     hex: '#D9AC86' },
  { id: 'fnd-sand',      shade: 'Sand',      hex: '#C89A72' },
  { id: 'fnd-honey',     shade: 'Honey',     hex: '#B5835C' },
  { id: 'fnd-amber',     shade: 'Amber',     hex: '#9A6B47' },
  { id: 'fnd-espresso',  shade: 'Espresso',  hex: '#6E4A33' },
];

// Blush shades (cheek colour).
export const BLUSH_SHADES = [
  { id: 'blush-rose',   shade: 'Rose',    hex: '#D77A86' },
  { id: 'blush-peach',  shade: 'Peach',   hex: '#E89477' },
  { id: 'blush-coral',  shade: 'Coral',   hex: '#E57359' },
  { id: 'blush-berry',  shade: 'Berry',   hex: '#B5476B' },
  { id: 'blush-mauve',  shade: 'Mauve',   hex: '#B56B86' },
  { id: 'blush-nude',   shade: 'Nude',    hex: '#C98F7E' },
];

// Hair colours — needs the segmentation model (hair is outside the face mesh).
export const HAIR_SHADES = [
  { id: 'hair-black',    shade: 'Jet Black',   hex: '#1E1A18' },
  { id: 'hair-brown',    shade: 'Chestnut',    hex: '#5A3A24' },
  { id: 'hair-auburn',   shade: 'Auburn',      hex: '#7A3320' },
  { id: 'hair-blonde',   shade: 'Blonde',      hex: '#C9A063' },
  { id: 'hair-platinum', shade: 'Platinum',    hex: '#D8CBB0' },
  { id: 'hair-red',      shade: 'Copper Red',  hex: '#9A4324' },
  { id: 'hair-burgundy', shade: 'Burgundy',    hex: '#5E2030' },
  { id: 'hair-blue',     shade: 'Blue',        hex: '#2C3E66' },
];