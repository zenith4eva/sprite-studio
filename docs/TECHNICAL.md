# Sprite Studio: technical notes

> Full reference for every mode. Paths under `work/wan_sheet/` and `DEADFARM/` refer to the author's own project folder and are not in this repo. `wan_gen.py` and `interp.py` are included in [`tools/`](../tools). For the quick guide, see the [README](../README.md).

A browser tool that builds a pixel-art character from options, animates it in eight directions, and lets you check every animation frame by frame. It also inspects sprite sheets made elsewhere (Codex, Wan, pix3d, hand-drawn) with the same checks.

Serve the folder and open it in a browser:

```bash
python -m http.server 5190
```

Then open http://localhost:5190/. The bundled samples load from `samples/`. The other **Project …** entries point at the author's project folder and only open when the studio is served from there.

No install, no build step, no network.

## How it makes consistent frames

The character is a small 3D mannequin built from ellipsoids and tapered capsules. A skeleton poses it, and each frame is ray-cast straight into pixels:

- **Silhouette:** 3×3 samples per pixel, decided by majority vote. Alpha is binary, so edges never blend into a background they won't have.
- **Colour:** each material has a 5-shade, hue-shifted ramp, and every pixel snaps to one shade.
- **Lines:** dark outlines, plus interior lines wherever one part passes in front of another.
- **Clean-up:** lone shade pixels, lone material pixels and pinholes are fixed.

Clothing, hair and gear belong to the same 3D figure, so they follow every pose in every direction. Nothing is generated, so nothing drifts:

- the head stays 10 px wide
- the feet stay on row 63
- all eight directions stay in sync frame for frame

Proportions match the DEADFARM house adult: 57 px standing in a 32×64 footprint, 10 px head, feet on row 63. Fractional motion, such as the idle's breath, moves shading before it moves pixels. That is the sub-pixel rule from the pixel-animation skill.

## Generate

- **Character (left panel):**
  - body type, height, build, shoulders, hips, head, skin
  - 10 hair styles, facial hair, eye colour
  - 7 tops, 5 bottoms, 3 kinds of shoes, 5 hats
  - belt, backpack, glasses, gloves, scarf
  - 4 weapons
  - zombie mode: decay, torn cloth, blood
  - pixel style: outline mode, ink colour, palette lock, contrast, camera tilt
- **Presets:** survivor (your master drawing), farmer, hoodie, ranger, medic, shambler, runner. **Randomise** rolls an outfit.
- **Animations:** idle (breathing), walk, run, attack (light swing with smears), hurt, death (collapse), winded pant and zombie shamble.
  - Each has sliders: stride, bob, arm swing, lean, timing and so on.
  - Walk, run, idle, pant and shamble have a frame-count choice of 4–16.
  - Default timings follow `pixel-animation/references/timing.md`: holds on the extremes, 50 ms smears, a held follow-through.
- **Direction:** the compass picks one of eight. The strip under it plays all eight in sync.

## Check, frame by frame

- **Transport:** play/pause, step, first/last, speed (0.25x–2x), and loop, ping-pong or once.
- **Timeline:** every frame with its duration and its kind against the previous frame. Click a duration to edit it.
- **Overlays:**
  - onion skin: red is the previous frame, blue the next
  - diff: pixels changed since the previous frame
  - guides: the feet row in cyan, the top of the figure, the 57 px line and the centre line
  - pixel grid
  - orphan pixels
  - a reference drawing, drawn semi-transparent with its feet on the ground row
- **Previews:** 1x and 2x, beside the zoomed view.
- **Check panel:** the same numbers as `anim_check.py`, with the same thresholds:
  - height, feet row and head width
  - colours and orphans
  - silhouette change per pair, with its kind: duplicate, sub-pixel, whole-pixel or jump-cut
  - a problem list, most important first

Keys: <kbd>Space</kbd> play, <kbd>←</kbd>/<kbd>→</kbd> step, <kbd>A</kbd>/<kbd>D</kbd> turn, <kbd>O</kbd> onion, <kbd>F</kbd> diff.

## Inspect file

Switch to **Inspect file** and drop in any of these:
- a strip
- a grid sheet
- an atlas PNG with its manifest JSON (DEADFARM / sprite-gen format: `frame_layout.rows` + `animation.rows`)

Slicing:
- **Pixel scale** divides upscaled art back to 1x; each block takes its most common colour.
- **#FF00FF** is keyed out.
- **Cell size** is guessed from the gaps between figures.
- **Check as** sets the tolerances: an idle may not move its feet, a run may lift them. It is picked from the row name when it can be.

Tested on `DEADFARM/web/assets/sg8/survivor.png` at pixel scale 2: 30 rows, 80×80 frames, with the manifest's durations.

## Export

| Button | What you get |
|---|---|
| Strip PNG | the current animation and direction, one row, cropped to the narrowest cell (32, 48 or 64) that fits |
| GIF | the current animation at 4x on the current background (transparent on checker) |
| Sprite sheet (.zip) | every ticked animation × 8 directions (or the 5 drawn views): `name.png`, `name.json` (atlas manifest with `durations_ms`, loop modes and `frame_layout.rows` rects), `name.parts.json` (every material's ramp, for runtime recolours), optional per-layer sheets (body, hair, top, bottom, shoes, hat, acc, weapon, fx; stacking them gives back the full frame) and a normal map for lit sprites |
| AI guide pack (.zip) | for the current animation and direction: `pose_sheet.png` (the frames at up to 8x on #FF00FF, laid out on the 1536×1024 Codex template), `openpose_sheet.png` (COCO-18), `depth_sheet.png`, `normal_sheet.png`, `mask_sheet.png`, `frames/NN.png`, `layout.json` and `prompt_codex.txt` (the pose, grid and frame-copy locks, written for a Codex edit) |

**Save JSON** and **Load JSON** store a character. The last character, animation settings and timing edits are kept in the browser between sessions.

## Video → Sheet (Wan clip to game-ready sheet)

This mode follows the workflow from Chong-U's "Stop Generating Fake Pixel Art Game Sprites" video, with Wan 2.2 as the motion source in place of GPT Image pose boards:

1. **Anchor.** Load the master pixel art. A 1x drawing is used as is. A large AI image is keyed, cut to the figure and pixel-snapped. Its palette locks every frame. **Wan start PNG** writes the anchor scaled up with nearest neighbour on flat green at a Wan size (512×640, 8x). `work/wan_sheet/wan_gen.py` runs Wan 2.2 I2V A14B Q8 locally: 49 frames in about 4 minutes.
2. **Recover + snap.** Drop the MP4 or its PNG frames. For each frame:
   - key the background (colour distance plus hue, which kills the green fringe)
   - keep the figure's own blobs by bounding box, never a grid crop
   - snap it with a port of Sprite Fusion Pixel Snapper (MIT) on a **rigid grid**: one block size for the whole clip (median figure height ÷ anchor height), with the step and phase fitted to the frame's edges
   - map colours to the anchor palette in Lab
   
   The rigid grid matters: the snapper's elastic walker let the figure creep from 57 to 62 px. On a rigid grid it holds 56–57.

   **Size changes (Track size drift, on by default).** Video frames don't hold one size: Wan drifts the figure toward or away from the camera, or zooms slowly. The back walk shrinks 7.5% over its 49 frames (456 → 422 video px), and the front run grows about 3%. One block size for the whole clip would turn that into a figure that grows or shrinks on the sheet, so each frame gets its own block size. The clip's overall size is the median figure height over the anchor height; the change from frame to frame follows the **head's width** in video px (rolling median over about one second). Head width changes with distance but not with pose: the back run's height swings 446–474 while its head stays 78–80. A first version tracked the figure height instead, and on the side run the crouches and flights pulled it around enough to put a jump cut back in; tracking by head width holds that run at one size and still follows the back walk from 8.04 down to 7.53. The grid fit then searches ±4% around that size and locks onto the blocks actually in the frame. Without tracking, the back walk's late frames lock 3% too large.
3. **Curate.** Thumbnails; click to drop a frame. **Find loop** matches shape *and* shading. A side view's silhouette repeats every half step, but the near and far legs differ in shade, so it finds the full stride. Front and back views are nearly mirror-symmetric too, and the half stride scores worse there as well (back run: 0.31 at the half, 0.17 at the full stride). Wan's first frames (the still easing in) are skipped automatically: about 10 frames at 16 fps, 20 at 32. Each extra loop frame costs a little, so a two- or three-stride loop that matches only slightly better loses to one stride.
4. **Anchor frames.** Feet go on the ground row. x comes from the head, matched to frame 1, or from the torso or box centre. Use Onion (O) and nudge any frame with Shift + arrows.
5. **Pack.** Fixed cells (default 32×64) with a bottom-centre pivot. The zip holds:
   - the sheet PNG and its atlas JSON (pivot, durations, source frames, block size)
   - `parts.json`
   - one layer sheet per part
   - the customised sheet and its script
   - a 4x GIF
6. **Parts + code.** Every anchor colour maps to a part (outline, skin, eyes, hair, hat, top, bottom, shoes, gear); fix the guesses in the table. Position settles the rest: above the tracked neck only head parts exist, and a head colour below it is gear, or shoes near the feet. The script box runs against the packed frames:

```js
api.recolor("top", "#56663a");      // shirt, keeping its shade ramp
api.recolor("bottom", "#4a3626");
api.hide("gear");
api.swapHead(heads.farmer);          // heads from other characters or a PNG
api.eachFrame((f, i, t) => { /* t.partAt(x, y), t.head = head box */ });
```

The same API runs in a game: `js/parts.js` has no dependencies and loads in a browser or in Node. Call `SpriteParts.create(partsJson).customise(frames, api => …)`, where frames are `{ W, H, rgba }`. `parts.json` also carries the head box for every frame, for hats and attachments.

**Fast motion (runs):** at 16 fps a jog jumps 35–41% between frames. Dropping to every second frame makes that worse (36–51%). `work/wan_sheet/interp.py` adds in-betweens on the *raw* clip with DIS optical flow (`--n 1` doubles it to 32 fps) before snapping, so each in-between is a real intermediate pose. Where the two warps disagree by more than `--agree` (default 40), as on a fast forearm the flow can't follow, averaging would give a ghosted double arm. So each such region takes one warp whole: the one whose flow is more forward-backward consistent there. `--blend` restores plain averaging. Load that clip from Project clips. For runs and jumps, set **Height from the video** in step 4. Flight frames then leave the ground: it measures against a rolling floor and ignores 1 px wobble.

**Shading boil:** each frame's video shading snaps to the palette on its own, so a shirt that hasn't changed still flickers between ramp steps. **Stabilise shading** in step 4 (on by default) fixes most of it:
- for each part, it finds the shift (±3 px) that lines the part up with the previous frame
- matched pixels that are the same part and within a Lab ΔE of the strength (default 14) take the previous frame's colour
- bigger shading changes still come through
- it goes round the loop twice so the seam settles, then folds stray single pixels back in

Boil, measured as the share of part-matched pixels that change colour, drops from 30% to 10% on the run and from 23% to 8% on the walk. `anim_check`'s col% barely moves, because it compares fixed positions and so mostly measures the motion itself.

Results are in `work/wan_sheet/final/`. Each sheet comes with `_4x`, `_custom_4x` and `_before_after` previews; in `_before_after` the top row is unstabilised and the bottom row stabilised.
- `survivor_side_walk`: 15 frames at 63 ms. `anim_check` finds no problems.
- `survivor_side_run`: 22 frames at 31 ms, built from the flow-doubled clip. All pairs are whole-pixel moves, with two flight phases of 2–5 px. The checker still notes the run's crouch (52–57 px, head steady at 10) and one loose fragment.
- The first 16 fps run is kept in `old_run_16fps/`.

**Cleanup after packing (all on by default, step 4):**
- **Lock the head to the anchor drawing.** The face is 3 or 4 px across, and snapped from video it boils: eyes drop out for a frame, a mouth mark appears, the hair outline flips sides. Every frame takes the anchor's own head instead, placed where it best covers the frame's head (overlap search within 3 px across and 2 px up and down, holding the last frame's spot unless another is clearly better), so the head keeps the video's bob and sway. On a 3/4 view this also stops the face turning to profile when the body twists. The new head often sits a pixel or two higher than the old one, so below its jaw line each column gets the frame's own neck and collar back; without that, 9 of the 10 views had a see-through strip under the chin.
- **Restore the outline on hands, legs and shoes.** The drawings outline 79–94% of their silhouette edge in a dark line; snapped frames lose some of it around hands and hips (the front walk was down to 70%). An edge pixel of skin, trousers or shoes takes the drawing's outline colour when the same part carries on inward behind it, so a 2×2 hand keeps its colour.
- **Loose fragments.** Islands under 5 px that sit apart from the body are dropped after snapping and again after stabilising.

**8 directions.** The survivor has five drawn views in `DEADFARM/art/sg/survivor8/drawings/` (side_R, front34, front, back34, back), and each gets its own Wan walk and run clip. `work/wan_sheet/gen_dirs.sh` queues the eight new clips at the side clips' settings; its prompt asks the figure to keep facing one way at one size and distance, with "walking toward the camera, getting bigger, zoom" in the negative prompt. `norm_names.py` renames the frames, `interp.py` doubles the runs, and the panel lists every clip and anchor. `work/wan_sheet/make_8dir.py` then packs `final/survivor_8dir_walk` and `survivor_8dir_run`:
- rows run E, SE, S, SW, W, NW, N, NE; W, SW and NW are mirrors of E, SE and NE
- every cell is padded, centred, to the widest view (40×64: a run's punch needs it), so the pivot stays at the bottom centre
- each direction is retimed to the side view's stride time (walk 945 ms, run 682 ms), because every Wan clip strides at its own pace (walk 14–18 frames, run 20–24); a turn then keeps the step rate
- `preview_8dir.py` writes an animated compass GIF of each

**Retrying the 3/4 views.** `gen_34_retry.sh` re-ran both 3/4 views, walk and run, with seeds 21, 33 and 45. The prompt pins the shoulder and hip angle, and "side view, profile view, turning sideways, twisting torso" goes in the negative prompt. Every seed twisted the same way, so the twist is how Wan moves a 3/4 figure, not bad luck. With the head locked, what's left measures as arm occlusion rather than turning: the chest stays 12–17 px against the 3/4 drawing's 13 and the side drawing's 8. The original seeds won every 3/4 slot. They are the cleanest by the checker and the steadiest by eye; the others added jump cuts, 28–29-frame loops, a washed-out forearm or sparkle specks.

**Retrying the back run.** The first back run pumped both arms out sideways together, a flap rather than a run. `gen_back_run_retry.sh` asks for elbows tucked at 90 degrees, swinging opposite each other, with "both arms moving together, arms flapping, elbows sticking out" in the negative prompt. Seed 33 got it right: one hand shows beside the hip at a time, swapping each stride, and the 20-frame loop is clean. Seed 21 had a jump cut and seed 45 flapped again.

**Playable page.** `work/wan_sheet/play/index.html` loads the three atlases from `play/assets/` and puts the survivor on a farm field: WASD or arrows to move, Shift to run, drag on touch screens (drag further to run). The standing pose is the drawing for each direction. Walk and run share each direction's stride time, so the stride phase carries across turns and gait changes. Ground speed is matched to the planted foot (34 px/s walking, 66 running) so the feet don't skate. T plays at quarter speed, G shows the cell box, ground line and pivot, C spins him through all eight directions, and the strip under the field shows the row being played with the current frame marked. Serve Desktop/AI and open `/work/wan_sheet/play/`; `make_8dir.py walk run idle` rebuilds the atlases, then copy them into `play/assets/`.

Check across directions: walk height is 56–57 px against the drawings' 57 in every direction, each head is its drawing's width (9 or 10 px) in every frame, and the feet sit on row 63 in every row. The run's median height differs by pose, not size (side 55 crouched, front 58 and back 59 upright with high knees), and the head widths still match.

Fixed: the run's in-betweens used to smear the fast forearm into a tan blob or a double hand. The run now in `work/wan_sheet/final` uses the pick-don't-blend in-betweens; the old blended version is in `final/old_run_blend/`, and the blended raw frames are in `raw_run_s11_x2_blend/`.

## Limits

- The look is a clean mannequin, not a painting:
  - no cloth folds or painted hair strands
  - hands are blobs
  - faces are 1-pixel eyes, brows and mouth
- Humanoids only. Each animation is a hand-tuned procedural pose; editing the curves still means editing `js/pose.js`.
- Asymmetric details (the messy-hair tufts, a weapon in the right hand) are rendered per direction. Export all 8 directions rather than mirroring when they matter.
- Side views read best for death and attack; front and back views of a fall are foreshortened.

See [`RESEARCH.md`](RESEARCH.md) for how this fits a production pipeline with Codex and local models.

## Files

`js/core.js` math, colour and ramps · `js/model.js` options, presets, proportions and materials · `js/pose.js` skeleton, IK and animations · `js/build.js` the outfit → primitives · `js/render.js` ray-cast pixel renderer · `js/analyze.js` checker · `js/io.js` PNG, GIF, ZIP, sheets and slicing · `js/vidsheet.js` Pixel Snapper port, keying, recovery, loop finding, anchoring, packing · `js/parts.js` part map and customisation API (also the game runtime) · `js/vidpanel.js` Video → Sheet UI · `js/app.js` UI


**Trudge and pant.** The game's survivor set also has a tired walk and a tired stand. Both ended up as the existing clean loops on new timing, built by `make_8dir.py`: *trudge* is the walk 1.35x slower (a 1.28 s stride, 25 px/s), and *pant* is the idle's breathing frames played fast with no rest (0.68 s a breath). New poses were tried and rejected: a hunched Wan walk read as a zombie shamble, a hand-on-the-side walk read as injured, and a hunched pant read as leaning. They're kept in `work/wan_sheet/final/old_trudge_hunched/`, `old_trudge_stitch/` and `idle/pant_*.png` (`make_pant.py`). The field test page drives both from stamina: running drains it in about 4 s; run dry and he trudges and pants until it is back to 60%. `Y` forces the tired state.
