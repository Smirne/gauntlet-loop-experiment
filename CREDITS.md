# Credits and third-party licences

## three.js

MICRO GAUNTLET renders with [three.js](https://threejs.org) **r180**, vendored under
`vendor/three/` with no build step and no package manager.

three.js is © 2010-2025 Three.js Authors and is distributed under the MIT licence. The full
licence text ships alongside the code it covers, at `vendor/three/LICENSE`, which is what the
MIT licence requires of any redistribution — including a browser build uploaded to itch.io.

Vendored from three.js: `build/three.module.js`, `build/three.core.js`, and the
`examples/jsm` modules listed by `git ls-files vendor/`. The `examples/jsm` files carry no
per-file licence header, which is why the licence sits at the root of the vendored tree
rather than being relied upon from the build files' SPDX line alone.

## Everything else

Every other asset in this game is generated at runtime from code in this repository: textures
are baked procedurally (`src/textures/`), car bodies and props are built from primitives
(`src/vehicle/CarModels.js`, `src/world/Props.js`), audio is synthesised (`src/audio/`), and
the type is the browser's own system stack. **There are no imported models, no photographic
textures, no sample libraries and no downloaded fonts**, which is deliberate: it keeps the
whole thing one small repository with one third-party licence to honour.

No screenshots from commercial games are stored in this repository. The critic loop compares
frames against its own earlier iterations and against a written rubric (`REVIEW.md`).
