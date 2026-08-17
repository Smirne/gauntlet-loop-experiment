// world/tracks/kitchen.js — BREAKFAST RUSH
//
// The default circuit, and the one every reviewer sees first. It is a lap of a
// varnished oak breakfast table at about ten past seven in the morning: low
// window light raking across the grain from the east, one long shadow per
// object, and a spilled carton of milk nobody has dealt with yet.
//
// LAYOUT — 1856 u, counter-clockwise, five distinct corner characters:
//
//   t 0.00-0.16  THE LONG RUN      main straight down the front edge of the
//                                  table. Gentle S so it is never dead flat.
//   t 0.16-0.22  TURN ONE          R78 fast left, taken flat in a good car.
//   t 0.22-0.29  THE BUTTER JUMP   east straight; a stack of toast has been
//                                  laid across it and makes a real ramp.
//   t 0.29-0.34  THE SPILL         R70 sweeper whose exit is under a sheet of
//                                  milk. Grip drops from 1.00 to 0.42 mid-
//                                  corner. This is the signature moment.
//   t 0.34-0.49  CEREAL CANYON     north straight, running over a newspaper
//                                  and then into toast crumbs.
//   t 0.49-0.58  THE TOASTER       R28 double-apex hairpin, the slowest corner
//                                  on the circuit, walled on the outside by two
//                                  cereal boxes.
//   t 0.58-0.72  CUTLERY DRAWER    infield straight into a genuine R26 chicane
//                                  across a glazed tile: fast in, no grip out.
//   t 0.72-0.79  JAM LOOP          R42 right-hand 180 — the only right-hander
//                                  on the lap, which is why it catches people.
//   t 0.79-0.93  THE CRUMB RUN     infield return leg, deliberately wide so
//                                  there are two viable lines through it.
//   t 0.93-1.00  SUGAR BOWL        R47 sweeping left hairpin back onto the
//                                  main straight.
//
// The alternate line is at the Crumb Run: the short way hugs the inside over
// bare oak (grip 0.96) and the long way stays out on varnish (grip 1.00). Over
// a lap the outside is worth about a tenth, which is exactly the kind of choice
// that should not be obvious.

export default {
  id: 'kitchen',
  name: 'BREAKFAST RUSH',
  theme: 'kitchen',
  lighting: 'morning',
  seed: 1337,
  laps: 3,
  difficulty: 1,

  // Start line placed 140 u into the main straight: the twelve grid slots fall
  // entirely on the straight behind it, and there is still 190 u of run to the
  // braking point for Turn One.
  startT: 0.075,
  gridSize: 12,

  surface: 'varnishedWood',
  offTrackSurface: 'oak',
  groundSurface: 'oak',
  shoulderWidth: 9,
  roadRaise: 0.55,
  groundRelief: 0.26,
  roadRelief: 0.11,
  groundPad: 360,

  // Centreline. Generated from a filleted skeleton and resampled at an even 22 u
  // so the spline's own curvature never exceeds the corner radius it was
  // designed for — the tightest arc on the lap is R26 against a 12 u half width.
  path: [
    [-154, 0, -151], [-132, 0, -151], [-110, 0, -152], [-88, 0, -153], [-66, 0, -154], [-44, 0, -155],
    [-21, 0, -156], [1, 0, -156], [23, 0, -155], [45, 0, -153], [67, 0, -150], [89, 0, -148],
    [111, 0, -146], [133, 0, -145], [154, 0, -140], [173, 0, -129], [188, 0, -113], [198, 0, -93],
    [202, 0, -71], [202, 0, -49], [202, 0, -27], [202, 0, -5], [202, 0, 17], [202, 0, 39],
    [202, 0, 61], [196, 0, 83], [184, 0, 101], [167, 0, 115], [147, 0, 123], [125, 0, 125],
    [103, 0, 126], [81, 0, 127], [59, 0, 127], [37, 0, 126], [15, 0, 123], [-7, 0, 121],
    [-29, 0, 119], [-51, 0, 117], [-73, 0, 117], [-95, 0, 118], [-118, 0, 119], [-140, 0, 120],
    [-162, 0, 120], [-183, 0, 116], [-195, 0, 99], [-196, 0, 77], [-194, 0, 55], [-178, 0, 40],
    [-156, 0, 39], [-134, 0, 41], [-112, 0, 43], [-90, 0, 44], [-68, 0, 42], [-47, 0, 36],
    [-27, 0, 27], [-6, 0, 22], [14, 0, 31], [34, 0, 41], [55, 0, 36], [74, 0, 26],
    [96, 0, 27], [117, 0, 20], [131, 0, 4], [136, 0, -18], [130, 0, -39], [114, 0, -54],
    [93, 0, -60], [71, 0, -62], [49, 0, -63], [27, 0, -62], [5, 0, -60], [-16, 0, -56],
    [-38, 0, -52], [-60, 0, -50], [-82, 0, -50], [-104, 0, -51], [-127, 0, -52], [-149, 0, -53],
    [-170, 0, -57], [-188, 0, -69], [-198, 0, -89], [-200, 0, -111], [-192, 0, -131], [-175, 0, -145],
  ],

  // Width is a design tool, not a constant: wide where overtaking should happen,
  // pinched where the driver should be made to commit.
  widthProfile: [
    { t: 0.00, width: 32 },   // main straight — three cars abreast
    { t: 0.13, width: 30 },
    { t: 0.19, width: 26 },   // Turn One tightens on entry
    { t: 0.25, width: 29 },   // the jump needs room to land crooked
    { t: 0.32, width: 26 },   // the spill
    { t: 0.40, width: 31 },   // Cereal Canyon, the second overtaking place
    { t: 0.47, width: 27 },
    { t: 0.52, width: 23 },   // hairpin: no room at all
    { t: 0.57, width: 24 },
    { t: 0.63, width: 28 },
    { t: 0.67, width: 24 },   // chicane
    { t: 0.71, width: 24 },
    { t: 0.76, width: 25 },   // Jam Loop
    { t: 0.82, width: 31 },   // the Crumb Run, wide on purpose
    { t: 0.88, width: 30 },
    { t: 0.94, width: 24 },   // Sugar Bowl
    { t: 0.98, width: 27 },
  ],

  // Ten surfaces around a lap. Each boundary also gets a band of gaffa tape from
  // TrackBuilder, which is exactly what somebody taping a circuit to a table
  // would have done, and it hides the material seam.
  surfaceSpans: [
    { from: 0.000, to: 0.115, surface: 'varnishedWood' },
    // Worn patches where the varnish is gone. These were 'oak' — which is also
    // groundSurface, so for a fifth of the lap the road was made of the table
    // and simply vanished. Two critics reported that independently, one as "an
    // entire hairpin has no road" and one as "the kerbs have detached from the
    // road edge"; the kerbs were fine, the road they bordered was invisible.
    // Pine keeps the bare-timber read and is a different timber from the table.
    { from: 0.115, to: 0.215, surface: 'pine' },
    { from: 0.215, to: 0.335, surface: 'varnishedWood' },
    { from: 0.335, to: 0.430, surface: 'paper' },        // yesterday's newspaper
    { from: 0.430, to: 0.500, surface: 'crumbs' },       // and where the toast was cut
    { from: 0.500, to: 0.625, surface: 'varnishedWood' },
    { from: 0.625, to: 0.715, surface: 'ceramicTile' },  // the trivet under the chicane
    { from: 0.715, to: 0.800, surface: 'varnishedWood' },
    { from: 0.800, to: 0.905, surface: 'pine' },   // second worn patch; see above
    { from: 0.905, to: 1.000, surface: 'varnishedWood' },
  ],

  hazards: [
    // The jump. 8.5 u of lift over 30 u with an abrupt lip: about 0.26 s of air
    // and 24 u of carry at 95 u/s, which is two and a half car lengths.
    { type: 'ramp', id: 'butterJump', t: 0.243, length: 30, height: 8.5, width: 27 },

    // The milk. No mesh — world/Decals.js paints the pool, and the surface
    // override is what the tyres feel. Two patches: the main sheet across the
    // exit, then a narrower trail that has run down the camber.
    { type: 'milk', id: 'milkSheet', t: 0.322, length: 54, width: 26, surface: 'spilledMilk' },
    { type: 'milk', id: 'milkTrail', t: 0.358, length: 30, width: 13, offset: 8, surface: 'spilledMilk' },

    // The newspaper has rucked up where it was folded.
    { type: 'bump', id: 'foldA', t: 0.366, length: 15, height: 1.7, width: 30 },
    { type: 'bump', id: 'foldB', t: 0.398, length: 15, height: 1.5, width: 30 },

    // The lip of the trivet, on the way into the chicane.
    { type: 'bump', id: 'trivetLip', t: 0.628, length: 12, height: 1.2, width: 28 },
    { type: 'bump', id: 'trivetExit', t: 0.712, length: 12, height: 1.2, width: 28 },

    // Marmalade, on the inside of the Crumb Run. Cheap on the outside line.
    { type: 'milk', id: 'jam', t: 0.848, length: 36, width: 15, offset: -8, surface: 'spilledMilk' },
  ],

  // Barriers only on the outsides that matter: the two fast sweepers, both
  // hairpins and the one right-hander. Everywhere else the table edge is open,
  // which is what makes the walled corners read as deliberate.
  walls: [
    { from: 0.150, to: 0.232, side: 'right', height: 4.2 },
    { from: 0.282, to: 0.350, side: 'right', height: 4.2 },
    { from: 0.492, to: 0.588, side: 'right', height: 3.8 },
    { from: 0.706, to: 0.796, side: 'left', height: 3.6 },
    { from: 0.915, to: 1.000, side: 'right', height: 4.0 },
  ],

  // Projected stains, consumed by world/Decals.js. `t`/`lateral` follow the
  // ribbon; `position` is world XZ for anything out on the table.
  decals: [
    { kind: 'milk', t: 0.322, lateral: 0, radius: 30, aspect: 1.9, opacity: 1.0 },
    { kind: 'milk', t: 0.340, lateral: 12, radius: 17, aspect: 1.4, opacity: 0.9 },
    { kind: 'milk', t: 0.358, lateral: 8, radius: 14, aspect: 2.2, opacity: 0.85 },
    { kind: 'milk', t: 0.302, lateral: -9, radius: 12, aspect: 1.3, opacity: 0.7 },
    { kind: 'milk', position: [188, 132], radius: 26, aspect: 1.5, rotation: 0.6, opacity: 0.95 },
    { kind: 'juice', t: 0.848, lateral: -8, radius: 19, aspect: 1.7, opacity: 0.85 },
    { kind: 'juice', t: 0.866, lateral: -14, radius: 11, opacity: 0.6 },
    { kind: 'coffeeRing', position: [30, -12], radius: 9 },
    { kind: 'coffeeRing', position: [46, -20], radius: 8, opacity: 0.7 },
    { kind: 'coffeeRing', position: [-118, 84], radius: 9, opacity: 0.8 },
    { kind: 'coffeeRing', position: [-262, 18], radius: 10, opacity: 0.75 },
    { kind: 'crumbPatch', t: 0.455, lateral: 4, radius: 26, aspect: 1.6, opacity: 0.8 },
    { kind: 'crumbPatch', t: 0.478, lateral: -10, radius: 18, opacity: 0.7 },
    { kind: 'crumbPatch', position: [-70, -14], radius: 22, opacity: 0.65 },
    { kind: 'crumbPatch', position: [-296, -96], radius: 30, opacity: 0.6 },
    { kind: 'rubberPatch', t: 0.185, lateral: 6, radius: 22, aspect: 2.6, opacity: 0.5 },
    { kind: 'rubberPatch', t: 0.535, lateral: -6, radius: 16, aspect: 2.2, opacity: 0.55 },
    { kind: 'rubberPatch', t: 0.955, lateral: -5, radius: 18, aspect: 2.4, opacity: 0.5 },
  ],

  props: [
    /* ---- the composition: what the camera sees behind the action ---------- */

    // Three cereal boxes make the wall of the Toaster hairpin. They are 30 u
    // tall against a 2.8 u car, which is most of what sells the scale.
    //
    // They used to stand at 92 / 46 / 132 on three different radii with three
    // unrelated yaws, and at that spacing they read as three boxes that happen
    // to be over there. Set on one radius, 27 u apart with their printed faces
    // all turned the same way, they read as somebody having STOOD THEM UP to
    // stop cars leaving the hairpin — which is the story, and it is also what
    // the `walls` entry across 0.492-0.588 has always been describing.
    // Measured against the real ribbon rather than the control points: the new
    // three clear the driving surface by 31.8-33.1 u at their centres and by
    // 26.6-28.1 u at their nearest CORNER, where the old three cleared it by
    // 30.1/46.4/31.2 at the centre and 17.4/33.8/19.7 at the corner. Two of the
    // three used to sit closer to the road than any of these do. Arranging them
    // did not cost a single unit of margin; it bought 9.
    { model: 'cerealBox', position: [-239, 0, 56], yaw: 1.60, scale: 1.05, color: 0x2f6c4f },
    { model: 'cerealBox', position: [-241, 0, 83], yaw: 1.54, scale: 1.18 },
    { model: 'cerealBox', position: [-238, 0, 110], yaw: 1.63, scale: 0.95, color: 0xe8a02c },

    // The carton that caused the whole problem, lying on its side above the
    // spill with its gable pointing back down the corner.
    { model: 'milkCarton', t: 0.318, lateral: 31, y: 4.6, rotation: [1.30, 2.35, 0], scale: 1.1 },
    { model: 'milkCarton', position: [246, 0, 62], yaw: -0.5, scale: 1.0 },
    { model: 'milkCarton', position: [-292, 0, -166], yaw: 0.8, scale: 1.05 },

    // Breakfast, laid out in the middle of the circuit where the chase camera
    // looks straight through it.
    { model: 'cerealBowl', position: [-42, 0, -10], yaw: 0.4, scale: 1.15 },
    { model: 'cutlerySpoon', position: [-25, 3.1, -5], rotation: [0.28, 1.05, 0.10] },
    { model: 'mug', position: [30, 0, -12], yaw: 0.9 },
    { model: 'jamJar', position: [64, 0, -6], yaw: 0.2 },
    { model: 'jamJar', position: [-268, 0, 24], yaw: -0.9, scale: 1.1 },
    { model: 'mug', position: [-300, 0, 132], yaw: 0.3, scale: 1.1 },
    { model: 'cerealBox', position: [304, 0, 168], yaw: -0.35, scale: 1.2, color: 0x3d63a8 },
    { model: 'cerealBox', position: [-330, 0, -40], yaw: 0.9, scale: 1.1 },

    // THE CASE. Eight moulded pockets, all of them empty, lid thrown back — the
    // object that answers why there is a racetrack on a breakfast table, and the
    // only prop on it whose emptiness is the point.
    //
    // It stands in the long infield pocket between the main straight and the
    // return leg, so the circuit reads as having been laid AROUND it rather than
    // through empty table, and so it is behind the action on the longest straight
    // on the lap instead of off in a corner where nothing is looked at.
    //
    // Placement arithmetic, because at 30.8 u with the lid up it is as tall as a
    // cereal box and it is the only tall prop inside the circuit. Yawed to 1.53
    // it lies along the pocket, presenting its 30 u width across the gap and its
    // 43 u depth down it: it occupies x -99..-55, z -117..-85, and its NEAREST
    // CORNER — not its centre — is 19.6 u clear of the driving surface, with the
    // centre 36.1 u clear. That is the widest margin this pocket allows a case
    // this size; a sweep of the whole pocket at four yaws tops out at 20.6. For
    // scale, two of the three cereal boxes that used to stand at the Toaster
    // hairpin had 17.4 and 19.7 u of corner clearance, so nothing here is closer
    // to a road than what already shipped.
    //
    // And it cannot occlude, which is the constraint that actually matters:
    // both boundaries of this pocket are near-parallel STRAIGHTS running past
    // it, so there is no corner where a chase camera has to look across this
    // ground at road its own car is about to reach.
    { model: 'carCase', position: [-72, 0, -101], yaw: 1.53 },

    // The toast that makes the ramp: two slices propped either side of the lip
    // so the jump reads as improvised rather than as a moulded kicker.
    { model: 'toast', t: 0.240, lateral: -25, rotation: [0, 0.4, 0.55] },
    { model: 'toast', t: 0.246, lateral: 25, rotation: [0, -0.3, -0.5] },
    { model: 'toast', t: 0.262, lateral: 29, rotation: [0.2, 1.1, 0] },

    /* ---- the abandoned breakfast ------------------------------------------ */

    // The one thing on this table that says why there is a racetrack on it.
    // Somebody was eating at the east side; the box of cars came out; the whole
    // place setting went into the corner in a single arm sweep and nobody has
    // been back for it. It sits outside Turn One, which is where the player
    // looks under braking at the end of the longest straight on the lap.
    //
    // What makes it read as one event rather than ten objects: everything is
    // within a couple of centimetres of its neighbour, the cereal box went over
    // backwards with its printed panel to the ceiling and its top pointing away
    // down the sweep, the toast is propped against the carton where it slid,
    // and the mug rolled clear of the huddle. The `propZones` entries below
    // wipe the verge scatter between this and the circuit and gather the field
    // scatter around it, so the cleared lane reads as cleared.
    //
    // These positions were laid out against each model's real oriented
    // footprint — a bowl is 15 u across, a cereal box on its back sweeps about
    // 24 x 36 — and checked pairwise. Seventeen of the forty-five pairs sit
    // within 6 u of each other and the deepest contact is 1.8 u, which is a
    // slice of toast lying on a coaster rather than through it. Move one and
    // re-check its neighbours.
    { model: 'cerealBowl', position: [250, 0, -110], yaw: 0.85, scale: 1.05 },
    { model: 'toast', position: [261.5, 0, -100.5], rotation: [0, -0.52, 0.42], settle: true },
    { model: 'milkCarton', position: [272, 0, -96], yaw: 0.62 },
    { model: 'jamJar', position: [255, 0, -95], yaw: 0.4 },
    { model: 'coaster', position: [246, 0, -96], yaw: 0.4 },
    { model: 'toast', position: [237, 0, -101], yaw: 1.35 },
    // Flat on its back, top end pointing off toward the table edge: the one
    // object that actually shows the direction the arm went. `settle` asks
    // world/Props.js for the lift that puts its lowest corner on the table,
    // measured from the merged geometry rather than guessed from the builder.
    { model: 'cerealBox', position: [283, 0, -113], rotation: [-1.5708, -2.498, 0], settle: true, scale: 1.1, color: 0xc8542a },
    { model: 'cutleryKnife', position: [234, 0, -114], yaw: 2.05 },
    { model: 'cutlerySpoon', position: [258, 0, -126], yaw: 2.30 },
    // On its side, well clear of the rest — the beat that dates the whole
    // tableau to the moment the cars arrived.
    { model: 'mug', position: [238, 0, -127], rotation: [0, 1.10, 1.5708], settle: true },

    // Cutlery on the verge of the chicane, aligned with the ribbon so it reads
    // as somebody's place setting rather than as scatter.
    { model: 'cutleryKnife', t: 0.655, lateral: -27, yaw: 0.06 },
    { model: 'cutleryFork', t: 0.668, lateral: -31, yaw: -0.04 },
    { model: 'cutlerySpoon', t: 0.681, lateral: -35, yaw: 0.02 },
    { model: 'cutleryKnife', t: 0.706, lateral: 28, yaw: 3.2 },

    { model: 'eggShell', position: [-96, 0, -18], yaw: 0.5 },
    { model: 'eggShell', position: [-88, 0, -26], yaw: 2.1, scale: 0.9 },
    { model: 'coaster', position: [-58, 0, -22], yaw: 0.7 },
    // Was [140, -14], which is 7.6 u INSIDE the Jam Loop's racing surface — a
    // collidable, knockable disc sitting on the road with nothing in the
    // definition saying it was meant to be a hazard. Moved 20 u outward into
    // the same pocket, where it now clears the ribbon by 12 u.
    { model: 'coaster', position: [160, 0, -12], yaw: 0.2 },

    /* ---- scattered dressing ---------------------------------------------- */

    { model: 'sugarCube', count: 46, band: 'verge', offset: [8, 26], spacing: 3, tilt: 0.22, scale: [0.85, 1.25] },
    { model: 'cornflake', count: 130, band: 'verge', offset: [6, 30], spacing: 2, tilt: 0.5, scale: [0.7, 1.4] },
    { model: 'cornflake', count: 40, band: 'field', clear: 18, spacing: 6, tilt: 0.5, scale: [0.8, 1.5] },
    { model: 'coin', count: 14, band: 'verge', offset: [9, 28], spacing: 8, tilt: 0.08 },
    { model: 'bottleCap', count: 12, band: 'verge', offset: [8, 30], spacing: 9, tilt: 0.3 },
    { model: 'eggShell', count: 10, band: 'verge', offset: [12, 34], spacing: 12, tilt: 0.35, scale: [0.8, 1.15] },
    { model: 'toast', count: 4, band: 'field', clear: 26, spacing: 26, tilt: 0.12, scale: [0.9, 1.1] },
    { model: 'coaster', count: 3, band: 'field', clear: 24, spacing: 22 },
    { model: 'pencil', count: 3, band: 'field', clear: 26, spacing: 30, tilt: 0.05 },
    { model: 'sugarCube', count: 26, band: 'field', clear: 20, spacing: 5, tilt: 0.25, scale: [0.85, 1.3] },

    // Background silhouettes, kept well clear of the ribbon so they frame the
    // action instead of blocking it.
    //
    // These counts are all HALVED, and the reason is worth keeping. They used
    // to read as a quota rather than as a breakfast: nine mugs, ten cereal
    // boxes, six bowls and eight jars on one table, evenly distributed, which
    // is what a table looks like when nobody sat at it. Restraint is the point
    // — these are background objects competing with eight cars for attention,
    // and the budget the cuts freed went into the abandoned breakfast above,
    // which is a story where six identical mugs was not. What survives here now
    // gathers, because world/Props.js draws four field candidates in five from
    // a cluster zone.
    { model: 'cerealBox', count: 2, band: 'field', clear: 52, spacing: 46, tilt: 0.03, scale: [0.9, 1.25] },
    { model: 'milkCarton', count: 1, band: 'field', clear: 50, spacing: 42, tilt: 0.03, scale: [0.9, 1.1] },
    { model: 'jamJar', count: 2, band: 'field', clear: 40, spacing: 28, scale: [0.9, 1.15] },
    { model: 'mug', count: 2, band: 'field', clear: 38, spacing: 26, scale: [0.9, 1.1] },
    { model: 'cerealBowl', count: 1, band: 'field', clear: 42, spacing: 34 },
    // Fourteen loose knives, forks and spoons scattered across a table is the
    // same failure in miniature. Two of each, and the place settings that read
    // as place settings are the hand-placed ones on the chicane verge and in
    // the abandoned breakfast.
    { model: 'cutleryFork', count: 2, band: 'field', clear: 34, spacing: 24, tilt: 0.04 },
    { model: 'cutleryKnife', count: 2, band: 'field', clear: 34, spacing: 24, tilt: 0.04 },
    { model: 'cutlerySpoon', count: 2, band: 'field', clear: 34, spacing: 24, tilt: 0.04 },
  ],

  // Where the loose dressing gathers, and the lane that was cleared for the
  // circuit. Consumed by world/Props.js: a zone biases where a scatter
  // candidate is DRAWN and never approves one — the road keep-out and the
  // spacing test still decide whether anything may exist there — so the worst a
  // badly placed zone can do is waste attempts.
  propZones: [
    // Somebody's place, in the infield pocket between the return leg and the
    // Crumb Run, around the bowl and mug and jam jar the props list puts there.
    // The pocket is narrow, so what can actually land in it skews short: crumbs
    // and sugar, which is the right story as well as the safe outcome.
    { x: 6, z: -16, rx: 52, rz: 24, yaw: 0.06, weight: 1.0 },
    // The abandoned breakfast outside Turn One. Crumbs where somebody ate.
    { x: 258, z: -108, rx: 34, rz: 30, yaw: 0.4, weight: 1.3 },
    // ...and the lane the arm swept clear between the two, running along the
    // circuit the way a forearm sweeps. Nothing scatters here, so the gap
    // between the tableau and the road reads as deliberate rather than as an
    // accident of the blue noise.
    { x: 226, z: -96, rx: 22, rz: 46, yaw: 0.0, kind: 'swept' },
  ],

  ambient: {
    fogColor: 0xd9d0bd,
    fogDensity: 0.00055,
    dustDensity: 1.15,
  },
};
