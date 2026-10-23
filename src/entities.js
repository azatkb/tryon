// Makeup entity taxonomy (per signed contract). Each makeup type is a SEPARATE
// entity, grouped by face area. `region` names the renderer region; `catalog`
// names the product category in catalog.js (REESOLVE CatalogProduct.category).
//
//   Lips : Lip Liner, Lipstick
//   Eyes : Eyeshadow, Eyeliner, Mascara, Brows
//   Face : Foundation, Concealer, Blush, Highlight

export const AREAS = [
  { id: 'lips', label: 'Lips' },
  { id: 'eyes', label: 'Eyes' },
  { id: 'face', label: 'Face' },
];

export const ENTITIES = [
  // Lips
  { id: 'lip-liner',  area: 'lips', name: 'Lip Liner', region: 'lipLiner',  catalog: 'lip-liner',  family: 'pink-nude', impl: true },
  { id: 'lipstick',   area: 'lips', name: 'Lipstick',  region: 'lips',      catalog: 'lipstick',   family: 'pink-nude', finish: 'satin', impl: true },
  // Eyes
  { id: 'eyeshadow',  area: 'eyes', name: 'Eyeshadow', region: 'eyes',      catalog: 'eyeshadow',  family: 'neutral',   impl: true },
  { id: 'eyeliner',   area: 'eyes', name: 'Eyeliner',  region: 'eyeliner',  catalog: 'eyeliner',   family: null,        impl: true },
  { id: 'mascara',    area: 'eyes', name: 'Mascara',   region: 'mascara',   catalog: 'mascara',    family: null,        impl: true },
  { id: 'brows',      area: 'eyes', name: 'Brows',     region: 'brows',     catalog: 'brows',      family: null,        impl: true },
  // Face
  { id: 'foundation', area: 'face', name: 'Foundation',region: 'foundation',catalog: 'foundation', family: null,        impl: true },
  { id: 'concealer',  area: 'face', name: 'Concealer', region: 'concealer', catalog: 'concealer',  family: null,        impl: true },
  { id: 'blush',      area: 'face', name: 'Blush',     region: 'blush',     catalog: 'blush',      family: 'rosy',      impl: true },
  { id: 'highlight',  area: 'face', name: 'Highlight', region: 'highlight', catalog: 'highlight',  family: 'champagne', impl: true },
];

export const entitiesByArea = (areaId) => ENTITIES.filter((e) => e.area === areaId);
export const entityById = (id) => ENTITIES.find((e) => e.id === id) || null;
