// world/Decals.js — everything the track remembers.
//
// Two systems live here, because they are the same idea seen twice: marks
// projected onto the driving surface that were not there when the geometry was
// built.
//
// 1. TYRE MARKS. A ring buffer of quads laid along the *real* contact patch
//    path, sampled at the physics rate from vehicle.wheels[i].contactX/Y/Z. Not
//    a trail behind the car's centre — behind each individual wheel, which is
//    why a drifting car leaves four separate arcs that splay apart through the
//    corner instead of one fat ribbon. Width comes from vertical load, opacity
//    from slip, and a locked wheel under braking lays down a darker, wider mark
//    than a spinning one, because that is what a locked wheel does.
//
//    Consecutive segments share the previous segment's leading edge exactly, so
//    the strip never overlaps itself. That matters more than it sounds: these
//    are multiply-blended, and any overlap would double-darken into a visible
//    bead at every joint.
//
// 2. SCENERY STAINS. Instanced quads carrying an atlas of sixteen procedurally
//    drawn spills — milk, juice, oil, water, coffee rings, chalk dust, sawdust,
//    crayon, soot, ink, paint. These are *lit*: they run through a real
//    MeshStandardMaterial with a per-instance roughness, so a milk pool is
//    smooth enough to catch the window highlight and a chalk scuff is not. An
//    unlit decal pasted over a lit floor is one of the fastest ways to look
//    cheap, and it is avoided here for the price of one shader injection.
//
// Both layers sit fractionally proud of the road and lean on polygon offset
// rather than on a large Y lift: a decal that floats visibly above the surface
// at a shallow camera angle is worse than one that z-fights.

import * as THREE from 'three';
import { makeRng, clamp, lerp, TAU } from '../core/Random.js';
import * as SurfacesMod from '../textures/Surfaces.js';
import * as SettingsMod from '../core/Settings.js';

const Surfaces = SurfacesMod.Surfaces ?? SurfacesMod.default ?? null;
const Settings = SettingsMod.Settings ?? SettingsMod.default ?? {};

/* ========================================================== module scratch */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/* ================================================================ tuning */

// Longitudinal pitch of one mark quad. A 9 u car at 90 u/s covers 2.4 u per
// physics tick, so this lays roughly one quad per tick at racing speed and
// degrades gracefully to one per several ticks in the slow corners.
const SEG_STEP = 2.4;
const SEG_STEP_MIN2 = SEG_STEP * SEG_STEP;
// Beyond this the wheel has been picked up and put down somewhere else (a
// respawn, a big jump) and the strip must be broken rather than stretched.
const SEG_BREAK2 = 46 * 46;

const TYRE_HALF = 0.74;         // half the contact patch width at nominal load
const MARK_LIFT = 0.06;         // along the surface normal
const MARK_MIN = 0.055;         // below this the mark is not worth a quad
const MARK_DARK = 0.82;         // how far towards the surface tint a full mark goes
const MARK_LIFE = 42;           // seconds; the last third of it is the fade

const STAIN_LIFT = 0.10;
const MAX_STAINS = 320;

/* ==================================================== the stain atlas =====
 * Sixteen cells, 4x4. Index order is fixed: STAIN_KINDS below is the contract
 * a track definition's `decals` array is written against.
 * ======================================================================== */

export const STAIN_KINDS = {
  milk:         { cell: 0,  roughness: 0.14, opacity: 0.95, color: 0xffffff },
  juice:        { cell: 1,  roughness: 0.20, opacity: 0.90, color: 0xffffff },
  oil:          { cell: 2,  roughness: 0.06, opacity: 0.96, color: 0xffffff },
  water:        { cell: 3,  roughness: 0.08, opacity: 0.80, color: 0xffffff },
  coffeeRing:   { cell: 4,  roughness: 0.42, opacity: 0.90, color: 0xffffff },
  crumbPatch:   { cell: 5,  roughness: 0.88, opacity: 0.85, color: 0xffffff },
  grassStain:   { cell: 6,  roughness: 0.72, opacity: 0.85, color: 0xffffff },
  sawdustPile:  { cell: 7,  roughness: 0.94, opacity: 0.90, color: 0xffffff },
  chalkScuff:   { cell: 8,  roughness: 0.97, opacity: 0.80, color: 0xffffff },
  sootScorch:   { cell: 9,  roughness: 0.90, opacity: 0.85, color: 0xffffff },
  paintSplash:  { cell: 10, roughness: 0.28, opacity: 0.92, color: 0xffffff },
  inkBlot:      { cell: 11, roughness: 0.34, opacity: 0.92, color: 0xffffff },
  crayonScrawl: { cell: 12, roughness: 0.52, opacity: 0.90, color: 0xffffff },
  rubberPatch:  { cell: 13, roughness: 0.66, opacity: 0.75, color: 0xffffff },
  pocket:       { cell: 14, roughness: 0.86, opacity: 1.00, color: 0xffffff },
  dirt:         { cell: 15, roughness: 0.82, opacity: 0.80, color: 0xffffff },
};

const ATLAS_COLS = 4;
const ATLAS_CELL = 1 / ATLAS_COLS;

/** Hazard surfaces that imply a stain, so a definition gets one even if it
 *  ships no explicit `decals` array. */
const HAZARD_STAIN = {
  spilledMilk: 'milk',
  oilSlick: 'oil',
  waterPuddle: 'water',
  chalkLine: 'chalkScuff',
  sawdust: 'sawdustPile',
  crumbs: 'crumbPatch',
};

/* ------------------------------------------------------------ canvas kit */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Closed, wobbly outline. Two sine harmonics plus a slow third give an edge
 * that reads as surface tension rather than as a circle with noise on it.
 */
function blobPath(g, cx, cy, r, rng, wob = 0.26, lobes = 6) {
  const p1 = rng.next() * TAU;
  const p2 = rng.next() * TAU;
  const p3 = rng.next() * TAU;
  const l2 = lobes * 1.9 + 1;
  g.beginPath();
  const n = 96;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const k = 1 + wob * (
      Math.sin(a * lobes + p1) * 0.52 +
      Math.sin(a * l2 + p2) * 0.26 +
      Math.sin(a * 2.0 + p3) * 0.40
    );
    const rr = r * Math.max(0.18, k);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
}

/** Satellite droplets thrown clear of the main pool. */
function droplets(g, cx, cy, r, rng, count, fill, maxR = 0.10) {
  g.fillStyle = fill;
  for (let i = 0; i < count; i++) {
    const a = rng.next() * TAU;
    const d = r * (1.02 + rng.next() * 0.55);
    const rr = r * (0.02 + rng.next() * maxR);
    g.globalAlpha = 0.35 + rng.next() * 0.55;
    g.beginPath();
    g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, rr * (0.6 + rng.next() * 0.7), a, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}

function speckle(g, cx, cy, r, rng, count, colors, sMin, sMax) {
  for (let i = 0; i < count; i++) {
    const a = rng.next() * TAU;
    // sqrt keeps the density uniform per unit area instead of piling up in the
    // middle, which is what a real scatter of crumbs looks like.
    const d = r * Math.sqrt(rng.next()) * 1.02;
    const s = r * (sMin + rng.next() * (sMax - sMin));
    g.fillStyle = colors[(rng.next() * colors.length) | 0];
    g.globalAlpha = 0.45 + rng.next() * 0.55;
    g.beginPath();
    g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s * (0.55 + rng.next() * 0.8), rng.next() * TAU, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}

/** A wet pool: body, denser rim, thin bright meniscus, satellite drops. */
function wetPool(g, cx, cy, r, rng, opts) {
  const { body, rim, sheen, wob = 0.26, lobes = 6, drops = 12, rimWidth = 0.05 } = opts;
  g.save();
  blobPath(g, cx, cy, r * 0.94, rng, wob, lobes);
  const grd = g.createRadialGradient(cx - r * 0.16, cy - r * 0.2, r * 0.06, cx, cy, r);
  grd.addColorStop(0, body[0]);
  grd.addColorStop(0.55, body[1]);
  grd.addColorStop(1, body[2]);
  g.fillStyle = grd;
  g.fill();
  // The rim is where the film is thickest and where a spill actually reads.
  g.lineWidth = r * rimWidth;
  g.strokeStyle = rim;
  g.stroke();
  if (sheen) {
    g.globalAlpha = 0.55;
    g.strokeStyle = sheen;
    g.lineWidth = r * rimWidth * 0.42;
    blobPath(g, cx, cy, r * 0.9, rng, wob * 0.8, lobes);
    g.stroke();
    g.globalAlpha = 1;
  }
  g.restore();
  droplets(g, cx, cy, r * 0.95, rng, drops, rim);
}

/**
 * Draw one atlas cell. `size` is the cell edge in pixels; the stain is kept
 * inside 92% of it so bilinear filtering never drags a neighbouring cell in.
 */
function drawStainCell(g, name, x0, y0, size, rng) {
  const cx = x0 + size * 0.5;
  const cy = y0 + size * 0.5;
  const r = size * 0.42;
  g.save();
  g.beginPath();
  g.rect(x0, y0, size, size);
  g.clip();

  switch (name) {
    case 'milk':
      wetPool(g, cx, cy, r, rng, {
        body: ['rgba(255,255,252,0.97)', 'rgba(246,245,238,0.93)', 'rgba(232,230,220,0.80)'],
        rim: 'rgba(255,255,255,0.95)',
        sheen: 'rgba(214,216,210,0.9)',
        wob: 0.30, lobes: 5, drops: 16,
      });
      // A milk skin dries with a chalky bloom in the shallows.
      speckle(g, cx, cy, r * 0.8, rng, 90, ['rgba(255,255,255,0.5)', 'rgba(238,236,226,0.5)'], 0.01, 0.05);
      break;

    case 'juice':
      wetPool(g, cx, cy, r, rng, {
        body: ['rgba(232,150,42,0.95)', 'rgba(196,104,26,0.92)', 'rgba(150,70,18,0.82)'],
        rim: 'rgba(158,74,20,0.95)',
        sheen: 'rgba(255,206,120,0.8)',
        wob: 0.34, lobes: 7, drops: 18,
      });
      break;

    case 'oil':
      wetPool(g, cx, cy, r, rng, {
        body: ['rgba(28,26,30,0.98)', 'rgba(18,17,20,0.97)', 'rgba(10,10,12,0.90)'],
        rim: 'rgba(8,8,10,0.98)',
        sheen: null,
        wob: 0.30, lobes: 5, drops: 14,
      });
      // Interference fringes where the film thins out. Hue walks with radius,
      // which is exactly what makes an oil slick read as oil and not as ink.
      g.save();
      blobPath(g, cx, cy, r * 0.94, rng, 0.30, 5);
      g.clip();
      for (let i = 0; i < 26; i++) {
        const rr = r * (0.24 + (i / 26) * 0.78);
        const hue = (i * 27 + rng.next() * 22) % 360;
        g.globalAlpha = 0.11 + rng.next() * 0.13;
        g.strokeStyle = `hsl(${hue}, 85%, 58%)`;
        g.lineWidth = r * (0.02 + rng.next() * 0.05);
        blobPath(g, cx + rng.range(-r * 0.1, r * 0.1), cy + rng.range(-r * 0.1, r * 0.1), rr, rng, 0.20, 4);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.restore();
      break;

    case 'water':
      wetPool(g, cx, cy, r, rng, {
        body: ['rgba(96,112,120,0.62)', 'rgba(64,78,88,0.70)', 'rgba(44,56,66,0.60)'],
        rim: 'rgba(150,168,178,0.85)',
        sheen: 'rgba(198,214,224,0.9)',
        wob: 0.32, lobes: 6, drops: 20,
      });
      break;

    case 'coffeeRing': {
      // Coffee dries by depositing everything it carried at the pinned edge —
      // the ring is dark and the middle is almost clear. Two overlapping rings
      // read as a cup that was moved once.
      for (let k = 0; k < 2; k++) {
        const ox = cx + (k ? r * 0.24 : 0);
        const oy = cy + (k ? r * 0.18 : 0);
        const rr = r * (k ? 0.74 : 0.94);
        g.globalAlpha = k ? 0.6 : 1;
        blobPath(g, ox, oy, rr, rng, 0.06, 9);
        const grd = g.createRadialGradient(ox, oy, rr * 0.62, ox, oy, rr);
        grd.addColorStop(0, 'rgba(96,58,28,0.05)');
        grd.addColorStop(0.72, 'rgba(96,58,28,0.16)');
        grd.addColorStop(0.90, 'rgba(74,42,18,0.78)');
        grd.addColorStop(1, 'rgba(58,32,14,0.30)');
        g.fillStyle = grd;
        g.fill();
        g.lineWidth = rr * 0.05;
        g.strokeStyle = 'rgba(62,34,15,0.8)';
        g.stroke();
      }
      g.globalAlpha = 1;
      speckle(g, cx, cy, r * 0.85, rng, 40, ['rgba(80,46,22,0.35)'], 0.01, 0.03);
      break;
    }

    case 'crumbPatch':
      speckle(g, cx, cy, r, rng, 320, [
        'rgba(198,150,86,0.95)', 'rgba(166,118,62,0.95)', 'rgba(226,192,132,0.9)',
        'rgba(122,82,42,0.9)', 'rgba(240,214,164,0.8)',
      ], 0.012, 0.055);
      break;

    case 'grassStain': {
      // Streaked, not blotchy: a grass stain is made by something sliding.
      const ang = rng.range(-0.35, 0.35);
      for (let i = 0; i < 140; i++) {
        const t = rng.next();
        const len = r * (0.16 + rng.next() * 0.7);
        const px = cx + Math.cos(ang) * lerp(-r, r, t) + rng.range(-r * 0.22, r * 0.22);
        const py = cy + Math.sin(ang) * lerp(-r, r, t) + rng.range(-r * 0.3, r * 0.3);
        g.globalAlpha = 0.16 + rng.next() * 0.5;
        g.strokeStyle = rng.bool(0.5) ? 'rgba(74,112,38,1)' : 'rgba(102,142,54,1)';
        g.lineWidth = r * (0.012 + rng.next() * 0.035);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
        g.stroke();
      }
      g.globalAlpha = 1;
      speckle(g, cx, cy, r * 0.9, rng, 70, ['rgba(58,92,30,0.7)', 'rgba(126,158,70,0.6)'], 0.008, 0.03);
      break;
    }

    case 'sawdustPile': {
      blobPath(g, cx, cy, r * 0.88, rng, 0.28, 6);
      const grd = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r * 0.9);
      grd.addColorStop(0, 'rgba(216,186,132,0.92)');
      grd.addColorStop(0.7, 'rgba(196,164,110,0.72)');
      grd.addColorStop(1, 'rgba(180,148,96,0)');
      g.fillStyle = grd;
      g.fill();
      speckle(g, cx, cy, r * 0.95, rng, 300, [
        'rgba(232,204,152,0.9)', 'rgba(198,166,110,0.9)', 'rgba(160,126,76,0.8)',
      ], 0.008, 0.032);
      break;
    }

    case 'chalkScuff': {
      blobPath(g, cx, cy, r * 0.9, rng, 0.34, 5);
      const grd = g.createRadialGradient(cx, cy, r * 0.06, cx, cy, r * 0.92);
      grd.addColorStop(0, 'rgba(214,226,232,0.72)');
      grd.addColorStop(0.62, 'rgba(196,212,220,0.42)');
      grd.addColorStop(1, 'rgba(186,204,214,0)');
      g.fillStyle = grd;
      g.fill();
      speckle(g, cx, cy, r * 0.85, rng, 180, ['rgba(226,238,244,0.55)', 'rgba(178,198,210,0.45)'], 0.006, 0.026);
      break;
    }

    case 'sootScorch': {
      blobPath(g, cx, cy, r * 0.86, rng, 0.24, 7);
      const grd = g.createRadialGradient(cx, cy, r * 0.04, cx, cy, r * 0.9);
      grd.addColorStop(0, 'rgba(14,12,12,0.94)');
      grd.addColorStop(0.45, 'rgba(32,26,24,0.72)');
      grd.addColorStop(0.8, 'rgba(52,42,36,0.34)');
      grd.addColorStop(1, 'rgba(60,48,40,0)');
      g.fillStyle = grd;
      g.fill();
      droplets(g, cx, cy, r * 0.8, rng, 22, 'rgba(20,16,14,0.7)', 0.06);
      break;
    }

    case 'paintSplash': {
      const base = 'rgba(38,110,178,';
      blobPath(g, cx, cy, r * 0.62, rng, 0.36, 5);
      g.fillStyle = base + '0.96)';
      g.fill();
      // Radiating fingers: a splash has direction and momentum.
      for (let i = 0; i < 16; i++) {
        const a = rng.next() * TAU;
        const len = r * (0.55 + rng.next() * 0.55);
        const w = r * (0.03 + rng.next() * 0.09);
        g.globalAlpha = 0.7 + rng.next() * 0.3;
        g.fillStyle = base + '0.95)';
        g.beginPath();
        g.moveTo(cx + Math.cos(a - 0.14) * r * 0.5, cy + Math.sin(a - 0.14) * r * 0.5);
        g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        g.lineTo(cx + Math.cos(a + 0.14) * r * 0.5, cy + Math.sin(a + 0.14) * r * 0.5);
        g.closePath();
        g.fill();
        g.beginPath();
        g.arc(cx + Math.cos(a) * len, cy + Math.sin(a) * len, w, 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      droplets(g, cx, cy, r * 0.75, rng, 20, base + '0.9)', 0.07);
      break;
    }

    case 'inkBlot': {
      blobPath(g, cx, cy, r * 0.7, rng, 0.30, 6);
      const grd = g.createRadialGradient(cx - r * 0.1, cy - r * 0.12, r * 0.04, cx, cy, r * 0.76);
      grd.addColorStop(0, 'rgba(22,24,44,0.98)');
      grd.addColorStop(0.7, 'rgba(14,16,34,0.96)');
      grd.addColorStop(1, 'rgba(10,12,28,0.88)');
      g.fillStyle = grd;
      g.fill();
      for (let i = 0; i < 10; i++) {
        const a = rng.next() * TAU;
        const len = r * (0.68 + rng.next() * 0.32);
        g.strokeStyle = 'rgba(14,16,32,0.9)';
        g.lineWidth = r * (0.02 + rng.next() * 0.06);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
        g.quadraticCurveTo(
          cx + Math.cos(a + 0.3) * len * 0.8, cy + Math.sin(a + 0.3) * len * 0.8,
          cx + Math.cos(a) * len, cy + Math.sin(a) * len
        );
        g.stroke();
      }
      droplets(g, cx, cy, r * 0.72, rng, 16, 'rgba(14,16,32,0.85)', 0.05);
      break;
    }

    case 'crayonScrawl': {
      const hues = ['rgba(214,58,44,', 'rgba(46,120,196,', 'rgba(232,176,38,', 'rgba(64,150,78,', 'rgba(140,72,168,'];
      for (let s = 0; s < 9; s++) {
        const col = hues[(rng.next() * hues.length) | 0];
        const ax = cx + rng.range(-r * 0.7, r * 0.7);
        const ay = cy + rng.range(-r * 0.7, r * 0.7);
        const ang = rng.next() * TAU;
        const len = r * (0.5 + rng.next() * 1.0);
        // Wax lays down in broken bands, not solid lines.
        for (let k = 0; k < 9; k++) {
          const off = (k - 4) * r * 0.028;
          g.globalAlpha = 0.20 + rng.next() * 0.55;
          g.strokeStyle = col + '1)';
          g.lineWidth = r * (0.012 + rng.next() * 0.024);
          g.beginPath();
          const nx = -Math.sin(ang) * off;
          const ny = Math.cos(ang) * off;
          g.moveTo(ax + nx, ay + ny);
          g.quadraticCurveTo(
            ax + Math.cos(ang + 0.4) * len * 0.6 + nx, ay + Math.sin(ang + 0.4) * len * 0.6 + ny,
            ax + Math.cos(ang) * len + nx, ay + Math.sin(ang) * len + ny
          );
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      break;
    }

    case 'rubberPatch': {
      blobPath(g, cx, cy, r * 0.9, rng, 0.24, 5);
      const grd = g.createRadialGradient(cx, cy, r * 0.06, cx, cy, r * 0.94);
      grd.addColorStop(0, 'rgba(26,25,24,0.80)');
      grd.addColorStop(0.6, 'rgba(34,32,30,0.52)');
      grd.addColorStop(1, 'rgba(40,38,36,0)');
      g.fillStyle = grd;
      g.fill();
      for (let i = 0; i < 70; i++) {
        const y = cy + rng.range(-r * 0.8, r * 0.8);
        g.globalAlpha = 0.1 + rng.next() * 0.35;
        g.strokeStyle = 'rgba(18,17,16,1)';
        g.lineWidth = r * (0.008 + rng.next() * 0.024);
        g.beginPath();
        g.moveTo(cx - r * (0.4 + rng.next() * 0.5), y);
        g.lineTo(cx + r * (0.4 + rng.next() * 0.5), y + rng.range(-r * 0.06, r * 0.06));
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    }

    case 'pocket': {
      // A table pocket seen from above: a black mouth with a leather-brown
      // shoulder and a hard inner edge.
      g.beginPath();
      g.arc(cx, cy, r * 0.96, 0, TAU);
      const shoulder = g.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 0.96);
      shoulder.addColorStop(0, 'rgba(58,38,22,0.98)');
      shoulder.addColorStop(0.7, 'rgba(42,28,16,0.94)');
      shoulder.addColorStop(1, 'rgba(30,20,12,0.5)');
      g.fillStyle = shoulder;
      g.fill();
      g.beginPath();
      g.arc(cx, cy - r * 0.03, r * 0.62, 0, TAU);
      const mouth = g.createRadialGradient(cx, cy - r * 0.12, r * 0.05, cx, cy, r * 0.62);
      mouth.addColorStop(0, 'rgba(2,2,3,1)');
      mouth.addColorStop(0.75, 'rgba(6,6,8,1)');
      mouth.addColorStop(1, 'rgba(18,16,16,1)');
      g.fillStyle = mouth;
      g.fill();
      break;
    }

    default: {
      blobPath(g, cx, cy, r * 0.88, rng, 0.28, 6);
      const grd = g.createRadialGradient(cx, cy, r * 0.06, cx, cy, r * 0.9);
      grd.addColorStop(0, 'rgba(96,80,62,0.80)');
      grd.addColorStop(0.65, 'rgba(84,70,54,0.48)');
      grd.addColorStop(1, 'rgba(76,64,50,0)');
      g.fillStyle = grd;
      g.fill();
      speckle(g, cx, cy, r * 0.9, rng, 120, ['rgba(70,58,44,0.6)', 'rgba(112,94,72,0.5)'], 0.008, 0.03);
    }
  }

  g.restore();
}

/** RGBA atlas of every stain kind, drawn once per session. */
function buildStainAtlas(size, seed) {
  const cell = size / ATLAS_COLS;
  const canvas = makeCanvas(size, size);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  const names = Object.keys(STAIN_KINDS);
  for (const name of names) {
    const spec = STAIN_KINDS[name];
    const col = spec.cell % ATLAS_COLS;
    const row = (spec.cell / ATLAS_COLS) | 0;
    // A per-cell stream keeps every stain deterministic and independent of the
    // order the cells happen to be drawn in.
    drawStainCell(g, name, col * cell, row * cell, cell, makeRng((seed ^ (spec.cell * 0x9e3779b1)) >>> 0));
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // No mipmaps: at 4x4 cells the first few levels would bleed neighbouring
  // stains into each other, and these are low-frequency shapes anyway.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The tyre-mark mask. u runs across the contact patch, v along it. Red channel
 * only — the colour comes from the surface tint, this is purely the shape.
 */
function buildMarkTexture(w, h, seed) {
  const rng = makeRng((seed ^ 0x5c1d) >>> 0);
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;

  // Longitudinal patchiness: rubber is not laid down evenly, it stutters.
  const patch = new Float32Array(h);
  let acc = 0;
  for (let y = 0; y < h; y++) {
    acc = acc * 0.86 + (rng.next() - 0.5) * 0.4;
    patch[y] = clamp(0.78 + acc + Math.sin(y * 0.21) * 0.08, 0.35, 1);
  }
  // Tread: five ribs with grooves between them. The grooves lay no rubber, so
  // the mark has structure instead of being a solid bar.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const e = Math.sin(Math.PI * u);                 // soft shoulders
      const edge = Math.pow(clamp(e, 0, 1), 0.55);
      const rib = 0.72 + 0.28 * Math.cos(u * Math.PI * 2 * 5);
      const grain = 0.90 + rng.next() * 0.14;
      const v = clamp(edge * rib * patch[y] * grain, 0, 1);
      const o = (y * w + x) * 4;
      const b = (v * 255) | 0;
      d[o] = b; d[o + 1] = b; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------------------------------------------------- shaders */

const MARK_VERT = /* glsl */`
attribute vec2 aMark;      // x = birth time, y = strength
attribute vec3 aColor;
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
uniform float uTime;
uniform float uLife;
void main() {
  vUv = uv;
  vColor = aColor;
  float age = uTime - aMark.x;
  // Full strength for the first two thirds of its life, then out. Fading from
  // birth would make a fresh mark look like a stale one.
  float k = 1.0 - clamp( ( age - uLife * 0.66 ) / ( uLife * 0.34 ), 0.0, 1.0 );
  vFade = aMark.y * k * step( 0.0, age );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MARK_FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
void main() {
  float m = texture2D( uMap, vUv ).r;
  float a = clamp( vFade * m, 0.0, 1.0 );
  // Multiply blending: white is a no-op, so the mark is expressed entirely as
  // how far towards its tint it drags whatever the road already put there.
  gl_FragColor = vec4( mix( vec3( 1.0 ), vColor, a ), 1.0 );
}
`;

/* ============================================================ the system */

export class Decals {
  name = 'decals';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.enabled = true;
    /** Set false by fx/Trails.js if it would rather own the ground marks. */
    this.ownsTyreMarks = true;

    this.group = new THREE.Group();
    this.group.name = 'decals';
    this.group.matrixAutoUpdate = false;

    const q = ctx?.settings?.quality ?? Settings?.quality ?? 'high';
    this.quality = q;
    this.maxSegments = q === 'low' ? 900 : q === 'medium' ? 1900 : 3600;
    this.atlasSize = q === 'low' ? 512 : q === 'medium' ? 1024 : 2048;

    this.clock = 0;
    this.head = 0;          // next segment slot
    this.filled = 0;        // segments written so far, capped at maxSegments
    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;

    this.markMesh = null;
    this.markGeo = null;
    this.markMat = null;
    this.markTex = null;

    this.stainMesh = null;
    this.stainMat = null;
    this.stainTex = null;
    this.stainCount = 0;
    this.stainAttr = null;

    this._wheels = new Map();   // vehicle -> per-wheel trail state
    this._tintCache = new Map();
    this._trackApplied = null;
    this._pendingStains = [];
    this._ready = false;
  }

  /* ------------------------------------------------------------------ init */

  async init() {
    const seed = this.ctx?.seed ?? this.ctx?.track?.seed ?? 1337;

    try {
      this.markTex = buildMarkTexture(64, 256, seed);
      this._buildMarkLayer();
    } catch (err) {
      console.warn('[Decals] tyre-mark layer unavailable:', err);
    }
    try {
      this.stainTex = buildStainAtlas(this.atlasSize, seed);
      this._buildStainLayer();
    } catch (err) {
      console.warn('[Decals] stain layer unavailable:', err);
    }

    this.ctx?.scene?.add?.(this.group);
    this.group.updateMatrixWorld(true);

    this.ctx?.bus?.on?.('track:ready', (track) => {
      try { this.applyTrack(track); } catch (err) { console.error('[Decals] applyTrack failed', err); }
    });
    // Race resets clear the marks but keep the authored stains.
    this.ctx?.bus?.on?.('race:restart', () => this.clearMarks());

    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.decals = this;
    }
    this._ready = true;
    if (this.ctx?.track) this.applyTrack(this.ctx.track);
    return this;
  }

  _buildMarkLayer() {
    const n = this.maxSegments;
    const verts = n * 4;
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const mark = new Float32Array(verts * 2);
    const col = new Float32Array(verts * 3);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      const o = i * 6;
      idx[o] = v; idx[o + 1] = v + 2; idx[o + 2] = v + 1;
      idx[o + 3] = v; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
      // Unused slots collapse to a point, so they rasterise nothing at all.
      for (let k = 0; k < 4; k++) mark[(v + k) * 2 + 1] = 0;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aMark', new THREE.BufferAttribute(mark, 2));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    // The buffer is written in ring order all over the playfield, so a bounding
    // sphere would be wrong within a frame of being computed. Cull manually.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.markTex },
        uTime: { value: 0 },
        uLife: { value: MARK_LIFE },
      },
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      transparent: true,
      blending: THREE.MultiplyBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -12,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'decals:tyreMarks';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 6;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    this.markGeo = geo;
    this.markMat = mat;
    this.markMesh = mesh;
    this.group.add(mesh);
  }

  _buildStainLayer() {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    // uv1 so the material's aoMap path, if the factory ever enables one, has a
    // channel to read rather than silently sampling channel 0.
    const uv = geo.getAttribute('uv');
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv.array, uv.itemSize));

    const stain = new Float32Array(MAX_STAINS * 4);
    const attr = new THREE.InstancedBufferAttribute(stain, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aStain', attr);
    this.stainAttr = attr;

    const mat = new THREE.MeshStandardMaterial({
      map: this.stainTex,
      transparent: true,
      depthWrite: false,
      roughness: 0.6,
      metalness: 0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      envMapIntensity: 1.0,
      name: 'decals:stains',
    });

    const cell = ATLAS_CELL.toFixed(6);
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aStain;
varying float vStainRough;
varying float vStainOpacity;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
vStainRough = aStain.z;
vStainOpacity = aStain.w;
#ifdef USE_MAP
  vMapUv = vMapUv * ${cell} + aStain.xy;
#endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vStainRough;
varying float vStainOpacity;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.a *= vStainOpacity;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp( vStainRough, 0.03, 1.0 );`);
    };
    mat.customProgramCacheKey = () => 'mg:stain';

    const mesh = new THREE.InstancedMesh(geo, mat, MAX_STAINS);
    mesh.name = 'decals:stains';
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.stainMat = mat;
    this.stainMesh = mesh;
    this.group.add(mesh);
  }

  /* ------------------------------------------------------- track binding */

  /**
   * Read a track definition's `decals` array (and, failing that, infer stains
   * from any hazard that overrides the surface). Idempotent per track.
   */
  applyTrack(track) {
    const t = track || this.ctx?.track;
    if (!t || this._trackApplied === t) return this;
    this._trackApplied = t;
    this.clearStains();
    this.clearMarks();

    // The definition names its own time of day and its own fog. Nothing else in
    // the boot order does this, because Lighting is constructed before a track
    // exists — see the report accompanying this module.
    const light = this.ctx?.lighting;
    if (light) {
      const want = t.lightingPreset || t.def?.lighting;
      if (want && light.presetName !== want && typeof light.setPreset === 'function') {
        try { light.setPreset(want, { transition: 0 }); } catch (err) { /* preset unknown */ }
      }
      const amb = t.ambient || t.def?.ambient;
      if (amb && typeof light.setFog === 'function') {
        try { light.setFog(amb.fogColor, amb.fogDensity); } catch (err) { /* no fog */ }
      }
    }

    const list = Array.isArray(t.def?.decals) ? t.def.decals : null;
    if (list) {
      for (const d of list) this.addStain(d.kind || 'dirt', d);
    } else if (Array.isArray(t.hazards)) {
      // Fallback so a definition that ships hazards but no decals still gets a
      // visible spill under every surface override.
      for (const h of t.hazards) {
        const kind = HAZARD_STAIN[h.surface];
        if (!kind) continue;
        this.addStain(kind, {
          t: h.t,
          lateral: h.lateral || 0,
          radius: Math.max(8, (h.width > 0 ? h.width : 24) * 0.5),
          aspect: h.length > 0 ? clamp(h.length / Math.max(8, h.width || 24), 0.6, 2.6) : 1.4,
        });
      }
    }

    // Anything queued before a track existed can only be resolved now.
    const pending = this._pendingStains.slice();
    this._pendingStains.length = 0;
    for (const p of pending) {
      if (this._resolvePlacement(p)) this._writeStain(p);
    }
    return this;
  }

  /* -------------------------------------------------------------- stains */

  /**
   * Place one scenery stain.
   * @param {string} kind a STAIN_KINDS key
   * @param {object} o { position:[x,z]|[x,y,z] } or { t, lateral }, plus
   *        radius, aspect, rotation, opacity, roughness, color
   */
  addStain(kind, o = {}) {
    const spec = STAIN_KINDS[kind] || STAIN_KINDS.dirt;
    const entry = {
      spec,
      x: 0,
      z: 0,
      yaw: o.rotation ?? 0,
      radius: o.radius ?? 14,
      aspect: o.aspect ?? 1,
      opacity: clamp(o.opacity ?? spec.opacity, 0, 1),
      roughness: clamp(o.roughness ?? spec.roughness, 0.02, 1),
      color: o.color ?? spec.color,
      t: o.t,
      lateral: o.lateral ?? 0,
      position: o.position,
    };
    if (!this.stainMesh) return this;
    if (this.stainCount >= MAX_STAINS) return this;
    if (!this._resolvePlacement(entry)) {
      // No track yet: park it until one arrives.
      this._pendingStains.push(entry);
      return this;
    }
    this._writeStain(entry);
    return this;
  }

  /** Fill entry.x/z/yaw from either world coordinates or a track parameter. */
  _resolvePlacement(entry) {
    if (Array.isArray(entry.position)) {
      entry.x = entry.position[0] ?? 0;
      entry.z = entry.position.length >= 3 ? (entry.position[2] ?? 0) : (entry.position[1] ?? 0);
      return true;
    }
    const track = this._trackApplied || this.ctx?.track;
    if (!track || entry.t == null || !track.surfacePoint) return false;
    const s = track.sampleAt(entry.t);
    const p = track.surfacePoint(entry.t, entry.lateral, _v0);
    entry.x = p.x;
    entry.z = p.z;
    // Track-relative stains lie along the ribbon unless told otherwise, which is
    // what makes a spill read as having run down the road.
    entry.yaw = (entry.yaw || 0) + Math.atan2(s.tangent.x, s.tangent.z);
    return true;
  }

  _writeStain(entry) {
    const mesh = this.stainMesh;
    if (!mesh || this.stainCount >= MAX_STAINS) return;
    const i = this.stainCount++;
    const spec = entry.spec;

    const y = this._groundAt(entry.x, entry.z) + STAIN_LIFT;
    this._normalAt(entry.x, entry.z, _v1);
    _q0.setFromUnitVectors(UP, _v1);
    _q1.setFromAxisAngle(UP, entry.yaw);
    _q0.multiply(_q1);

    const sx = Math.max(1, entry.radius * 2 * entry.aspect);
    const sz = Math.max(1, entry.radius * 2);
    _m0.compose(_v0.set(entry.x, y, entry.z), _q0, _v2.set(sx, 1, sz));
    mesh.setMatrixAt(i, _m0);

    _c0.set(entry.color);
    mesh.setColorAt(i, _c0);

    const a = this.stainAttr.array;
    const col = spec.cell % ATLAS_COLS;
    const row = (spec.cell / ATLAS_COLS) | 0;
    a[i * 4] = col * ATLAS_CELL;
    a[i * 4 + 1] = row * ATLAS_CELL;
    a[i * 4 + 2] = entry.roughness;
    a[i * 4 + 3] = entry.opacity;

    mesh.count = this.stainCount;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.stainAttr.needsUpdate = true;
  }

  clearStains() {
    this.stainCount = 0;
    if (this.stainMesh) this.stainMesh.count = 0;
    return this;
  }

  /* ----------------------------------------------------------- tyre marks */

  clearMarks() {
    if (!this.markGeo) return this;
    const mark = this.markGeo.getAttribute('aMark');
    const arr = mark.array;
    for (let i = 1; i < arr.length; i += 2) arr[i] = 0;
    mark.needsUpdate = true;
    this.head = 0;
    this.filled = 0;
    this.markGeo.setDrawRange(0, 0);
    this._wheels.clear();
    return this;
  }

  /** fx/Trails.js may call this if it would rather draw the ground marks. */
  disableTyreMarks() {
    this.ownsTyreMarks = false;
    this.clearMarks();
    if (this.markMesh) this.markMesh.visible = false;
    return this;
  }

  _groundAt(x, z) {
    const track = this._trackApplied || this.ctx?.track;
    if (!track?.heightAt) return 0;
    try {
      const y = track.heightAt(x, z);
      return Number.isFinite(y) ? y : 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Ground normal, forced into the upper hemisphere. The sign guard is not
   * defensive padding: world/Track.js currently builds its frame normal as
   * cross(right, tangent), which is -up, and a decal quad oriented to it would
   * be flipped through the floor.
   */
  _normalAt(x, z, out) {
    out.set(0, 1, 0);
    const track = this._trackApplied || this.ctx?.track;
    if (!track?.normalAt) return out;
    try {
      const n = track.normalAt(x, z, out);
      if (n && Number.isFinite(n.x + n.y + n.z) && n.lengthSq() > 1e-6) {
        out.copy(n);
        if (out.y < 0) out.negate();
      } else {
        out.set(0, 1, 0);
      }
    } catch (err) {
      out.set(0, 1, 0);
    }
    return out;
  }

  /** Surface-specific mark colour, pre-mixed towards white so a full-strength
   *  mark darkens the road rather than erasing it. Cached per surface name. */
  _tintFor(surface) {
    const key = surface || 'default';
    const hit = this._tintCache.get(key);
    if (hit) return hit;
    let hex = 0x1a1a1a;
    try {
      const v = Surfaces?.skidTint?.(key);
      if (typeof v === 'number') hex = v;
    } catch (err) { /* the default tint is a fine answer */ }
    _c1.set(hex);                                   // -> linear working space
    const c = {
      r: 1 - (1 - _c1.r) * MARK_DARK,
      g: 1 - (1 - _c1.g) * MARK_DARK,
      b: 1 - (1 - _c1.b) * MARK_DARK,
    };
    this._tintCache.set(key, c);
    return c;
  }

  _wheelRecords(vehicle) {
    let recs = this._wheels.get(vehicle);
    if (!recs) {
      recs = [];
      for (let i = 0; i < 4; i++) {
        recs.push({
          active: false, hasEdge: false,
          x: 0, y: 0, z: 0,
          lx: 0, ly: 0, lz: 0,   // trailing edge, left of travel
          rx: 0, ry: 0, rz: 0,   // trailing edge, right of travel
          v: 0,                   // accumulated distance, for the texture
        });
      }
      this._wheels.set(vehicle, recs);
    }
    return recs;
  }

  /**
   * One quad from the previous trailing edge to the new one. Sharing the edge
   * is what keeps a continuous strip from double-darkening at its joints.
   */
  _pushSegment(rec, lx, ly, lz, rx, ry, rz, strength, tint, dv) {
    const geo = this.markGeo;
    if (!geo) return;
    const slot = this.head;
    this.head = (this.head + 1) % this.maxSegments;
    if (this.filled < this.maxSegments) this.filled++;

    const pos = geo.getAttribute('position').array;
    const uvA = geo.getAttribute('uv').array;
    const mk = geo.getAttribute('aMark').array;
    const cl = geo.getAttribute('aColor').array;

    const v = slot * 4;
    const p = v * 3;
    // 0: previous left, 1: previous right, 2: new right, 3: new left
    pos[p] = rec.lx; pos[p + 1] = rec.ly; pos[p + 2] = rec.lz;
    pos[p + 3] = rec.rx; pos[p + 4] = rec.ry; pos[p + 5] = rec.rz;
    pos[p + 6] = rx; pos[p + 7] = ry; pos[p + 8] = rz;
    pos[p + 9] = lx; pos[p + 10] = ly; pos[p + 11] = lz;

    const v0 = rec.v;
    const v1 = rec.v + dv;
    const u = v * 2;
    uvA[u] = 0; uvA[u + 1] = v0;
    uvA[u + 2] = 1; uvA[u + 3] = v0;
    uvA[u + 4] = 1; uvA[u + 5] = v1;
    uvA[u + 6] = 0; uvA[u + 7] = v1;

    for (let k = 0; k < 4; k++) {
      mk[u + k * 2] = this.clock;
      mk[u + k * 2 + 1] = strength;
      const c = (v + k) * 3;
      cl[c] = tint.r; cl[c + 1] = tint.g; cl[c + 2] = tint.b;
    }

    rec.v = v1;
    if (slot < this._dirtyLo) this._dirtyLo = slot;
    if (slot > this._dirtyHi) this._dirtyHi = slot;
  }

  /**
   * Sample every wheel's contact patch and lay rubber where the tyre model says
   * it is scrubbing. Runs on the fixed tick so the path is sampled at 120 Hz
   * regardless of frame rate — and so `?t=12` fast-forwards lay marks too.
   */
  fixedUpdate(fdt, ctx) {
    this.clock += fdt;
    if (!this.enabled || !this.ownsTyreMarks || !this.markGeo) return;
    const vehicles = ctx?.vehicles || this.ctx?.vehicles;
    if (!vehicles || !vehicles.length) return;

    for (let vi = 0; vi < vehicles.length; vi++) {
      const car = vehicles[vi];
      const wheels = car?.wheels;
      if (!Array.isArray(wheels) || wheels.length < 4) continue;
      const recs = this._wheelRecords(car);
      const loadRef = car.tires?.loadRef ?? 65;

      for (let i = 0; i < 4; i++) {
        const w = wheels[i];
        const rec = recs[i];
        if (!w) continue;

        const hard = w.surfaceHardness ?? 1;
        const inten = w.markIntensity ?? 0;
        if (!w.grounded || hard < 0.28 || inten < MARK_MIN) {
          rec.active = false;
          rec.hasEdge = false;
          continue;
        }

        const cx = w.contactX;
        const cy = w.contactY;
        const cz = w.contactZ;
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) { rec.active = false; continue; }

        if (!rec.active) {
          rec.active = true;
          rec.hasEdge = false;
          rec.x = cx; rec.y = cy; rec.z = cz;
          continue;
        }

        const dx = cx - rec.x;
        const dz = cz - rec.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < SEG_STEP_MIN2) continue;
        if (d2 > SEG_BREAK2) {
          // Teleported: start a fresh strip rather than drawing a 40 u smear.
          rec.hasEdge = false;
          rec.x = cx; rec.y = cy; rec.z = cz;
          continue;
        }

        const d = Math.sqrt(d2);
        const inv = 1 / d;
        // Perpendicular to travel, in the plane of the contact normal, so the
        // strip lies flat on a banked road instead of cutting into it.
        let ny = w.normalY;
        let nx = w.normalX;
        let nz = w.normalZ;
        if (!(ny > 0.05)) { nx = 0; ny = 1; nz = 0; }
        _v0.set(dx * inv, (cy - rec.y) * inv, dz * inv);
        _v1.set(nx, ny, nz).normalize();
        _v2.crossVectors(_v1, _v0);
        if (_v2.lengthSq() < 1e-8) _v2.set(dz * inv, 0, -dx * inv);
        _v2.normalize();

        // Load widens the patch; a heavily loaded outside front is visibly a
        // broader mark than an unloaded inside rear, and that is the tell that
        // makes these read as tyre marks rather than as a painted line.
        const loadK = clamp((w.load ?? loadRef) / Math.max(1e-3, loadRef), 0.35, 1.9);
        const halfW = TYRE_HALF * (0.66 + 0.44 * loadK);

        let s = inten;
        if (w.locked) s = Math.min(1, s * 1.30 + 0.22);       // braking: darker
        else if (w.spinning) s = Math.min(1, s * 1.12 + 0.10);
        s *= hard;
        s *= clamp(0.55 + 0.45 * loadK, 0.35, 1.15);
        s = clamp(s, 0, 1);
        if (s < MARK_MIN) { rec.x = cx; rec.y = cy; rec.z = cz; continue; }

        const liftX = _v1.x * MARK_LIFT;
        const liftY = _v1.y * MARK_LIFT;
        const liftZ = _v1.z * MARK_LIFT;
        const lx = cx - _v2.x * halfW + liftX;
        const ly = cy - _v2.y * halfW + liftY;
        const lz = cz - _v2.z * halfW + liftZ;
        const rx = cx + _v2.x * halfW + liftX;
        const ry = cy + _v2.y * halfW + liftY;
        const rz = cz + _v2.z * halfW + liftZ;

        if (!rec.hasEdge) {
          rec.lx = lx; rec.ly = ly; rec.lz = lz;
          rec.rx = rx; rec.ry = ry; rec.rz = rz;
          rec.hasEdge = true;
          rec.v = 0;
          rec.x = cx; rec.y = cy; rec.z = cz;
          continue;
        }

        const tint = this._tintFor(w.surface);
        this._pushSegment(rec, lx, ly, lz, rx, ry, rz, s, tint, d / 5.5);

        rec.lx = lx; rec.ly = ly; rec.lz = lz;
        rec.rx = rx; rec.ry = ry; rec.rz = rz;
        rec.x = cx; rec.y = cy; rec.z = cz;
      }
    }
  }

  /* ------------------------------------------------------------- per frame */

  update(dt, ctx) {
    if (!this._ready) return;
    if (!this._trackApplied && (ctx?.track || this.ctx?.track)) {
      try { this.applyTrack(ctx?.track || this.ctx.track); } catch (err) { /* retried next frame */ }
    }
    if (this.markMat) this.markMat.uniforms.uTime.value = this.clock;
    this._flush();
  }

  /** Upload only the slots that were written since the last frame. */
  _flush() {
    if (this._dirtyHi < this._dirtyLo || !this.markGeo) return;
    const lo = this._dirtyLo;
    const hi = this._dirtyHi;
    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;

    const geo = this.markGeo;
    const upload = (name, itemSize) => {
      const attr = geo.getAttribute(name);
      if (!attr) return;
      if (typeof attr.addUpdateRange === 'function') {
        attr.addUpdateRange(lo * 4 * itemSize, (hi - lo + 1) * 4 * itemSize);
      }
      attr.needsUpdate = true;
    };
    upload('position', 3);
    upload('uv', 2);
    upload('aMark', 2);
    upload('aColor', 3);

    geo.setDrawRange(0, this.filled * 6);
  }

  /* --------------------------------------------------------------- config */

  setEnabled(v) {
    this.enabled = !!v;
    this.group.visible = !!v;
    return this;
  }

  applySettings(settings) {
    const s = settings || this.ctx?.settings || Settings;
    const on = s?.post?.decals !== false;
    this.setEnabled(on);
    return this;
  }

  onResize() {}

  info() {
    return {
      segments: this.filled,
      maxSegments: this.maxSegments,
      stains: this.stainCount,
      ownsTyreMarks: this.ownsTyreMarks,
      atlas: this.atlasSize,
    };
  }

  dispose() {
    this.markGeo?.dispose?.();
    this.markMat?.dispose?.();
    this.markTex?.dispose?.();
    this.stainMesh?.geometry?.dispose?.();
    this.stainMat?.dispose?.();
    this.stainTex?.dispose?.();
    this.group.parent?.remove?.(this.group);
    this.markGeo = null;
    this.markMat = null;
    this.markMesh = null;
    this.stainMesh = null;
    this.stainMat = null;
    this._wheels.clear();
    this._ready = false;
  }
}

export const DecalSystem = Decals;
export default Decals;
