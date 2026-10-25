# Third-party notices

## NASA CGI Moon Kit (Moon textures)

`public/moon/` is derived from NASA's Scientific Visualization Studio
"CGI Moon Kit" (Ernie Wright, 2019; https://svs.gsfc.nasa.gov/4720) by
`scripts/prepare-moon-textures.mjs`:

- `color.jpg`: `lroc_color_poles_4k.tif`, the Lunar Reconnaissance Orbiter
  Camera (LROC) Wide Angle Camera color mosaic, converted to JPEG.
- `slope_east.jpg`, `slope_north.jpg`: terrain slopes computed from
  `ldem_16_uint.tif`, the Lunar Orbiter Laser Altimeter (LOLA) elevation
  grid at 16 pixels per degree.

NASA imagery and data are not subject to copyright in the United States
(NASA Media Usage Guidelines). Credit: NASA's Scientific Visualization
Studio; LRO LROC and LOLA teams.

## OpenStreetMap (map tiles)

The terrain is textured with the standard OpenStreetMap raster tiles
(`https://tile.openstreetmap.org`), streamed at runtime and not redistributed
here. Map data © OpenStreetMap contributors, available under the Open Database
License (https://www.openstreetmap.org/copyright). The app shows this credit on
screen while the terrain is on, as the OSM Foundation tile usage policy
(https://operations.osmfoundation.org/policies/tiles/) requires, and only
requests the tiles in view.

## Terrain Tiles (elevation)

Elevation is streamed from the Terrain Tiles on AWS (Mapzen/Tilezen "Joerd",
Terrarium encoding, https://registry.opendata.aws/terrain-tiles/). Sources and
their credits, listed at
https://github.com/tilezen/joerd/blob/master/docs/attribution.md, include:
3DEP, SRTM and GMTED2010 data courtesy of the U.S. Geological Survey; ETOPO1
(NOAA); Copernicus EU-DEM; and regional data from LINZ, Kartverket, Geoscience
Australia, INEGI, Natural Resources Canada (Open Government Licence – Canada),
the UK Environment Agency and ArcticDEM.

## 3d-tiles-renderer

The terrain's tiling, level of detail and displacement come from
`3d-tiles-renderer` (NASA-AMMOS/3DTilesRendererJS, Apache License 2.0) as an
npm dependency. `src/scene/Terrain.ts` adapts the bump-mapping GLSL of its
`TerrainLambertMaterial`.

## astronomy-engine

Sun and Moon ephemerides use `astronomy-engine` (MIT, Copyright (c) 2019–2023
Donald Cross), the library `@takram/three-atmosphere` also uses.

## three-geospatial (takram)

Rendering uses `@takram/three-atmosphere`, `@takram/three-clouds`,
`@takram/three-geospatial` and `@takram/three-geospatial-effects` from
https://github.com/takram-design-engineering/three-geospatial as npm
dependencies. `tests/reference/takram.tsx` reproduces the storybook story
`clouds/Clouds/Basic` and copies the small `useApplyLocation` helper;
`src/app/applyLocation.ts` and `src/app/localDate.ts` port the same storybook
helpers.

The files in `public/takram/` are byte-identical copies of the default assets
those packages download at runtime (`DEFAULT_LOCAL_WEATHER_URL`,
`DEFAULT_SHAPE_URL`, `DEFAULT_SHAPE_DETAIL_URL`, `DEFAULT_TURBULENCE_URL`,
`DEFAULT_STBN_URL`). `stbn.bin` is a spatiotemporal blue noise texture after
NVIDIA's "Spatiotemporal Blue Noise Masks" (2022).

```
The MIT License (MIT)

Copyright (c) 2024 Shota Matsuda

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Precomputed Atmospheric Scattering (Eric Bruneton)

`@takram/three-atmosphere` ports Bruneton's model, and
`src/scene/spaceViewFix.ts` patches one function of that port
(`GetSkyRadiance`).

```
Copyright (c) 2017 Eric Bruneton
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
this list of conditions and the following disclaimer in the documentation
and/or other materials provided with the distribution.

3. Neither the name of the copyright holders nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```
