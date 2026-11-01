# Consistent, production-ready sprite animation with free tools (local + Codex)

Research for DEADFARM, 22 October 2026. Constraints: free tools only, local generation plus Codex image generation, an RTX 5070 Laptop GPU with **8 GB VRAM**, and the house locks (32×64 cell, 57 px figure, 10 px head, five drawn views, Resurrect 64 plus the survivor's colours).

## The answer in one paragraph

No generator, local or Codex, keeps a character identical across dozens of frames by itself. Every free pipeline that works does the same thing:
- **It locks the parts that must not change.** That means the skeleton and motion, the size, the pixel grid, the palette and the timing, using deterministic tools.
- **It lets AI decide only appearance,** once per character, on a few master images.
- **It snaps and measures every frame** before accepting it.

For you that means four steps:
- **Motion:** from a skeleton, with Sprite Studio or a Blender rig.
- **Look:** from Codex (gpt-image-2), through charpipe's template edits and pose-locked row edits.
- **Snap and checks:** the tools you already have.
- **Local models:** used only where they add something cheaply, mainly control-driven video passes and LoRA-free stills. They are not the source of truth.

## Why frames drift, and what fixes each cause

| Cause of drift | What it looks like | Lock that fixes it |
|---|---|---|
| Each frame generated separately | the face, hair and folds change frame to frame (boiling) | generate a whole row in **one** image (Codex keeps identity within an image), or don't generate per frame at all |
| No fixed pose | the size pops, the stride shuffles, limbs vanish | a pose per frame from a skeleton: OpenPose/depth control, or a pose sheet given as the edit base |
| Free grid detection | the block size wanders ±10% between strips | snap at the **known** block size (charpipe searches only near 8x; SpriteKiln's `match_reference` does the same) |
| Free colours | greys drift, a cue colour is lost | lock to a master palette in Lab, keeping listed exceptions (charpipe) |
| Video zoom and walk-in | the figure grows or shrinks over a clip | anchor on the feet per frame (SpriteKiln "Stabilize Sprite Frames"; your `snap_row.py`) |
| Video upper body | the head and arms morph, hands are lost | take only the legs from video (your `hybrid8.py`), or drive the video with a control signal |

## The routes, compared for your machine

| Route | Consistency | Quality | Fits 8 GB? | Verdict |
|---|---|---|---|---|
| **Sprite Studio** (procedural 3D mannequin → pixels, this folder) | total: deterministic, 8 directions in sync | clean mannequin; no folds or painted hair | CPU, about 12 ms a frame | Use as the **source of truth for motion**, and directly for NPC and zombie variety and placeholders |
| **Codex pose-locked edit** (Sprite Studio `pose_sheet.png` + your master drawing + `prompt_codex.txt`) | good within one image; detail may still boil a little between frames | highest of the free options; matches charpipe's look | cloud, on your ChatGPT plan | **Main art route for hero animations.** Snap at the guide's block size and check every pair |
| **Paint transfer** (map each frame's pixels back to the rest pose by body-part surface coordinate, then copy the drawing's colour) | total: detail cannot boil | as good as the master drawing, close to the body | CPU | **Recommended next build step** (see below). It is the Aarthificial UV-lookup and Dead Cells idea, applied to your charpipe drawings |
| Wan 2.2 I2V A14B GGUF (installed) + pixel-animation LoRA | legs good; upper body and size drift (your sg8 result) | painterly motion | runs with offload, slowly | Keep for organic secondary motion and reference; not the source of truth |
| Wan VACE driven by Sprite Studio's depth or OpenPose sheets | the control signal locks motion and silhouette | painterly | 1.3B plausibly fits 8 GB at 480p; 14B does not | **Worth one test**: it fixes the drift the I2V route had, because the motion comes from your skeleton |
| Qwen-Image-Edit-2511 + Multiple-Angles LoRA (8-direction turnarounds) | good per view; left and right sometimes swapped | high | GGUF Q4 with offload (about 12 GB of weights): slow | Codex already does your turnarounds through charpipe; use this only if Codex quota runs out |
| FLUX.2 klein 4B / Z-Image Turbo (Apache-2.0) | stills only | good with pixel LoRAs | fp8 or GGUF on 8 GB | Fast local stills and edits (props, portraits) when you don't want to spend Codex calls |
| TRELLIS.2 mesh → Blender rig → render → snap (`work/q/m3d`) | deterministic | about 50% of pixels differ from the drawing at rest | yes | Solved structure, not likeness. Paint transfer onto that mesh is the same idea as row 3 |
| Paid tools (PixelLab, Retro Diffusion, Scenario) | — | — | — | Excluded (not free) |

## Recommended pipeline

1. **Design the character once (existing).** charpipe asks Codex to redraw the mannequin template, then snaps and gates the result. That gives five 32×64 master views on the house grid and palette.
2. **Author the motion in Sprite Studio.** Pick the state (idle, walk, run, attack, hurt, death, pant, shamble), tune stride, bob and arm swing, and set per-frame durations (holds on extremes, 50 ms smears). Check the timeline, onion skin and diff, then export:
   - the sprite sheet (motion truth, 8 directions)
   - the **AI guide pack** for the views you will paint
3. **Put the look on the motion.** Pick one of three tiers:
   - **Direct:** use the procedural sprites as they are, locked to the DEADFARM master palette. Right for crowds, background NPCs and placeholders.
   - **Codex row edit:**
     - **Inputs:** `pose_sheet.png` first, the matching master drawing upscaled 8x second, and `prompt_codex.txt` as the prompt. The prompt carries the pose, grid and frame-copy locks, each said once, as the pixel-animation skill recommends.
     - **Snap:** use the guide's block size. `layout.json` gives the block size, origin and cell.
     - **Check:** load the result in **Inspect file** at that pixel scale. Reroll any row with a size pop, a head-width change or a jump cut. Never hand-resize.
   - **Paint transfer** (to build next): every pixel the renderer draws already knows its body part and where on that part it sits. Two pieces are missing:
     - fitting the mannequin to each master view (the reference overlay already shows the fit)
     - a lookup pass that copies the drawing's colour for each animated pixel
     
     That gives drawn-quality frames that cannot drift. Codex is then only needed for poses the rest view can't supply, such as an attack's raised arm.
4. **Polish.** Run `subpixel.py breathe` on idles and `shift --region` for the one secondary part. Add smears only between anticipation and extension. Do hand fixes in Aseprite.
5. **Gate.** Run `anim_check.py --loop --sheet` and Sprite Studio's checker, which use the same thresholds. Put durations in the manifest, not in duplicated frames.

## Practical notes

**Codex (gpt-image-2)**
- It has been Codex CLI's default image model since 21 April 2026. It is reached through the built-in `$imagegen` skill with your ChatGPT login.
- The skill's guidance is one `image_gen` call per asset; don't use a count parameter to get variants.
- Transparency is unreliable, so keep the flat #FF00FF background and key it out, as charpipe does.
- Remember `PYTHONUTF8=1`, and that codex.exe is not on your PATH.

**Local video on 8 GB**
- Use the Q4_K_S GGUF and the lightx2v 4-step LoRAs (both already in `tools/ComfyUI/models`).
- Frame counts must be 4n+1 and sizes divisible by 16; stay around 480p.
- Use a grey or green background, never white: white parts vanish in background removal.
- Expect 10–20 minutes per clip. Run tests in the background.

**Snapping:** you already have better than the free tools: `snapraw.py` and `pixelfix.py` with a known block size and the master palette. Pixel Snapper (MIT) and DeAI PixelKit (an Aseprite extension) are the free general-purpose equivalents.

**Customisation at runtime:**
- **Recolours:** use `parts.json`. Sprite Studio exports every material's ramp, in the same spirit as `survivor.parts.json`.
- **Swappable items:** that needs either per-item layer sheets on a shared base (the LPC approach; Sprite Studio exports layer sheets that rebuild the frame exactly) or a UV-lookup shader.

**Licences for a commercial Steam release:**
- Wan 2.x, Qwen-Image-Edit, FLUX.2 klein **4B** and Z-Image Turbo are Apache-2.0.
- FLUX.2 klein **9B** is non-commercial.
- SAM 3 is under Meta's own licence.
- Check each LoRA separately.

## What I could not verify

- Whether Wan VACE 1.3B runs pose, depth and reference inputs together within 8 GB. The sources only support "plausible at 480p". It needs one test run.
- The `styly-agents/Wan2-2-pixel-animate` LoRA that SpriteKiln uses. Its model card gave no usage details.
- Identity consistency figures for Qwen's multi-angle LoRA. Only vendor claims were found.

## Three experiments, in order

1. **Codex row edit vs sg8.** Export the guide pack for side walk. Run one Codex edit with the side master, snap at 8x, and compare it with `web/assets/sg8` side_walk in Inspect: heights, head width, jump cuts. This tells you whether pose-locked Codex rows beat the hybrid Wan legs.
2. **Paint-transfer prototype.** Fit the mannequin to `character_rig/master/drawings/side_R.png` with the reference overlay, then add the lookup pass. If the rest frame matches the drawing pixel for pixel, the walk inherits the drawing's detail.
3. **VACE control test.** Turn `depth_sheet.png` frames into a 4n+1 control clip, run Wan VACE 1.3B with the survivor master as the reference, and snap. This checks whether a control-driven video holds the upper body where I2V did not.

## Result of experiment 1 (22 October 2026)

Run: the Sprite Studio side-walk guide pack, then one `sprite-gen gen --provider codex` edit (pose sheet + side master at 8x, charpipe-style prompt, 76 s on the subscription), then a snap at the template's 8x with the master-palette lock and positions kept. Files are in `work/codex_row_walk/`.

| | frames | height | head | colours | orphans | silhouette change per pair | colour change per pair (mean) | head pixels changed per pair | checker |
|---|---|---|---|---|---|---|---|---|---|
| Sprite Studio (pose source) | 8 | 56 | 10 | 31–35 | 12–28 | 18–29% | 16–44% (32%) | 2% (hair sway) | clean |
| Codex row, snapped | 8 | 56 | 11 | 62–71 | 28–33 | 17–28% | 39–59% (50%) | 35% | 3 frames at 6.0–6.4% orphans |
| Codex + head lock | 8 | 56 | 11 | 64–70 | 27–33 | 17–28% | 33–54% (44%) | 0% (head pasted) | 1 frame at 6.2% |
| sg8 as shipped | 16 | 57 | 10 | 46–59 | 12–34 | 4–22% | 14–36% (27%) | 0% (head pasted) | clean |

- **The pose lock held.**
  - The silhouettes overlap the pose source by 0.91–0.95 (mean 0.94).
  - Height and feet row were the same in every frame. No jump cuts, no size pops and no drift.
  - The grid snapped at exactly 8.0 px, with no pixels lost.
- **The look is the survivor's.** One call gave the beard, hair highlights, collar, buckle and denim folds, at the house pixel size.
- **The fine detail boils.**
  - The head is redrawn in every frame: 35% of its pixels change per pair, against 0% for sg8.
  - Colour change per pair is 50% against the pose source's 32% for the same motion. About 18 points of that is redrawn detail, which shimmers at 100 ms a frame.
  - Locking the head (the hybrid8 trick) removes the head's share; the shirt and jeans still boil.
- **It is slightly off the house lock.** The head is 11 px wide instead of 10. There are 5 colours outside the master palette, and painterly speckle sits right at the orphan limit.

Verdict: a pose-locked Codex row is the fastest route to a good-looking key pose or a one-shot (attack, hurt), where frames are short or held. For loops it is not production-ready on its own. Detail must come from one painted source and be carried onto every frame deterministically: that is paint transfer, using the master or one chosen Codex frame as the texture.

**Follow-up: a new side walk from that row** (`work/side_walk_new/final/`, made by `stabilize.js`). Rendering the whole walk from a consensus skin on the mannequin's silhouette (the first attempt, in `attempt1_transfer/`) lost the face and smeared the thin arms, because Codex's parts sit a pixel or two off the mannequin. What worked:
- Keep Codex's drawings and outlines.
- Lock the head to one consensus drawing.
- Recolour cloth and skin interiors from the colour each mannequin surface point agrees on across frames, but only where Codex and the mannequin agree on the material.

Changed pixels per frame pair:

| Region | Codex as painted | New walk | Floor (motion alone) |
|---|---|---|---|
| Head | 34% | **0%** | 1% |
| Chest | 59% | 50% | 34% |
| Legs | 78% | 74% | 61% |

`anim_check.py --loop` reports no problems: 56 px tall, feet on row 63 and the head 11 px wide in every frame.

## Sources

- SpriteKiln, a free local ComfyUI toolkit for sprites, rotations, animation, equipment layers and normal maps: https://github.com/brunocpf/spritekiln
- comfyui-2d-character-pipeline (Qwen-Image-Edit pose edits → Wan 2.2 → VACE cosmetic layers aligned to the base): https://github.com/mor-o/comfyui-2d-character-pipeline
- 3D-model route with depth and pose ControlNet in ComfyUI (TawusGames): https://tawusgames.itch.io/ai-gen-sprite-tutorial
- Clean spritesheets in ComfyUI, generating at 2–4x and downscaling (Apatero): https://apatero.com/blog/generate-clean-spritesheets-comfyui-guide-2025
- Codex `$imagegen` skill: https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/imagegen/SKILL.md
- Image generation in Codex CLI with gpt-image-2: https://codex.danielvaughan.com/2026/04/27/codex-cli-image-generation-gpt-image-2-visual-development-workflows/
- Aarthificial's UV-mapped sprite animation, explained: https://dev.to/derlin/this-guy-may-just-have-revolutionized-2d-pixel-animation-37ip
- A UV-lookup shader re-implementation: https://final-punch-games.itch.io/pixel-mapping-shader-for-gamemaker
- Aseprite community thread on UV and lookup exports: https://community.aseprite.org/t/export-indexed-color-as-uv-coordinate-pixels-and-a-palette-lookup-texture/14154
- Dead Cells' 3D-to-pixel pipeline (low-resolution render without smoothing, plus normal maps): https://wnhub.io/news/art/item-13775
- Qwen-Image-Edit-2509, keypoint-map pose control: https://huggingface.co/Qwen/Qwen-Image-Edit-2509
- Qwen-Image-Edit-2511 Multiple-Angles LoRA: https://stable-diffusion-art.com/qwen-image-edit-multiple-angle-lora/
- A local Qwen-Image-Edit consistency issue: https://github.com/Comfy-Org/ComfyUI/issues/9455
- Wan 2.2 VACE pose-driven workflow: https://www.runcomfy.com/comfyui-workflows/wan-2-2-vace-in-comfyui-pose-driven-motion-video-workflow
- Wan2GP VACE notes: https://github.com/deepbeepmeep/Wan2GP/blob/main/docs/VACE.md
- Wan2.1 VACE 1.3B: https://huggingface.co/wan-ai/wan2.1-vace-1.3b
- FLUX.2 [klein] (4B Apache-2.0, 9B non-commercial): https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence
- Pixel Snapper, an MIT grid-and-palette snapper: https://korben.info/en/pixel-snapper-fix-ai-pixel-art.html
- DeAI PixelKit, an Aseprite extension: https://masaka0411.itch.io/deai-pixelkit
- LPC generator layers, as used by the Godot plugin: https://opengameart.org/forumtopic/godot-35-lpc-character-spritesheet-plugin-now-in-asset-library
- Project and skill docs: `DEADFARM/art/charpipe/README.md`, `~/.claude/skills/pixel-animation/references/*`, `DEADFARM/web/README.md`
