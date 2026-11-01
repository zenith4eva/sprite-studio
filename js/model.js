// Character model: the option catalogue, presets, body proportions and the material table.
(function (SS) {
  'use strict';

  SS.CATALOG = {
    bodyType: [['male', 'Male'], ['female', 'Female']],
    hair: [['bald', 'Bald'], ['buzz', 'Buzz cut'], ['short', 'Short'], ['messy', 'Messy'], ['swept', 'Swept fringe'],
      ['bob', 'Bob'], ['long', 'Long'], ['ponytail', 'Ponytail'], ['mohawk', 'Mohawk'], ['afro', 'Afro']],
    facial: [['none', 'None'], ['stubble', 'Stubble'], ['mustache', 'Mustache'], ['beard', 'Beard']],
    top: [['none', 'Bare'], ['tshirt', 'T-shirt'], ['buttonshirt', 'Button shirt, rolled sleeves'], ['longsleeve', 'Long sleeve'],
      ['hoodie', 'Hoodie'], ['jacket', 'Open jacket'], ['tank', 'Tank top']],
    bottom: [['jeans', 'Jeans'], ['cargo', 'Cargo pants'], ['shorts', 'Shorts'], ['skirt', 'Skirt'], ['overalls', 'Overalls']],
    shoes: [['boots', 'Boots'], ['sneakers', 'Sneakers'], ['barefoot', 'Barefoot']],
    hat: [['none', 'None'], ['cap', 'Cap'], ['beanie', 'Beanie'], ['bandana', 'Bandana'], ['hood', 'Hood up'], ['strawhat', 'Straw hat']],
    weapon: [['none', 'None'], ['machete', 'Machete'], ['bat', 'Bat'], ['axe', 'Axe'], ['pipe', 'Pipe']],
    outline: [['selout', 'Sel-out (lit side tinted)'], ['ink', 'Ink (all dark)'], ['soft', 'Soft (material dark)'], ['none', 'None']],
    palette: [['free', 'Free (hue-shifted ramps)'], ['deadfarm', 'DEADFARM master (R64 + survivor)'], ['resurrect64', 'Resurrect 64 only']],
  };

  SS.defaultCharacter = () => ({
    name: 'survivor',
    body: { type: 'male', height: 57, build: 1, shoulders: 1, hips: 1, head: 1 },
    skin: '#e19968',
    face: { eyes: '#1e130c', facial: 'none' },
    hair: { style: 'messy', color: '#553926' },
    top: { type: 'buttonshirt', color: '#595750', accent: '#45443f', under: '#c2b49a' },
    bottom: { type: 'jeans', color: '#22314d' },
    shoes: { type: 'boots', color: '#624a30', sole: '#2a2927' },
    hat: { type: 'none', color: '#6e2727' },
    extras: { belt: true, beltColor: '#4f3421', backpack: false, packColor: '#5f5a36', glasses: false, gloves: false, gloveColor: '#3e3546', scarf: false, scarfColor: '#b33831' },
    weapon: { type: 'none' },
    zombie: { on: false, decay: 0.7, torn: 0.35, blood: 0.3 },
    style: { outline: 'ink', ink: '#1e130c', palette: 'free', tilt: 0, light: 0.55 },
  });

  const merge = (base, over) => {
    const out = JSON.parse(JSON.stringify(base));
    for (const k of Object.keys(over || {})) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) out[k] = merge(out[k] || {}, over[k]);
      else out[k] = over[k];
    }
    return out;
  };
  SS.mergeCharacter = (over) => merge(SS.defaultCharacter(), over);

  SS.PRESETS = {
    survivor: { body: { build: 1.18 } },  // fitted to the master side drawing (silhouette IoU 0.87)
    farmer: { name: 'farmer', hair: { style: 'short', color: '#8a7a68' }, face: { facial: 'stubble' }, hat: { type: 'strawhat', color: '#d9b26a' },
      top: { type: 'tshirt', color: '#9e4539', accent: '#6e2727' }, bottom: { type: 'overalls', color: '#3d5a8c' },
      shoes: { type: 'boots', color: '#4c3e24' }, extras: { belt: false } },
    hoodie: { name: 'hoodie', hair: { style: 'swept', color: '#2b211c' }, top: { type: 'hoodie', color: '#4a5a52', accent: '#323d38' },
      bottom: { type: 'cargo', color: '#5b5639' }, shoes: { type: 'sneakers', color: '#c7c2b4', sole: '#f2efe6' }, extras: { belt: false } },
    ranger: { name: 'ranger', body: { type: 'female', height: 55, shoulders: 0.95 }, skin: '#c98a62', hair: { style: 'ponytail', color: '#7a3a24' },
      top: { type: 'jacket', color: '#4f4a2c', accent: '#3a3620', under: '#c7c0aa' }, bottom: { type: 'jeans', color: '#2d3a55' },
      shoes: { type: 'boots', color: '#3e2f22' }, extras: { backpack: true, packColor: '#6b5a3a' } },
    medic: { name: 'medic', skin: '#a8714a', hair: { style: 'buzz', color: '#1d1714' }, face: { facial: 'beard' },
      top: { type: 'longsleeve', color: '#c9ccc4', accent: '#a12f2f' }, bottom: { type: 'cargo', color: '#3e3d4a' },
      shoes: { type: 'sneakers', color: '#3a3a40', sole: '#d8d4c8' }, extras: { glasses: true, belt: true, beltColor: '#2a2a30' } },
    shambler: { name: 'shambler', skin: '#9aa58a', face: { eyes: '#e8df9a' }, hair: { style: 'messy', color: '#3b3226' },
      top: { type: 'buttonshirt', color: '#6c6a5a', accent: '#4a4838', under: '#8f8670' }, bottom: { type: 'jeans', color: '#2c3446' },
      shoes: { type: 'boots', color: '#4a3a2a' }, zombie: { on: true, decay: 0.85, torn: 0.3, blood: 0.25 } },
    runner: { name: 'runner', skin: '#a3ab92', face: { eyes: '#f2e6a0' }, hair: { style: 'short', color: '#222018' },
      top: { type: 'hoodie', color: '#7d2a2a', accent: '#561c1c' }, bottom: { type: 'shorts', color: '#3a3d48' },
      shoes: { type: 'sneakers', color: '#8c8a80', sole: '#c8c4b8' }, extras: { belt: false }, zombie: { on: true, decay: 0.75, torn: 0.2, blood: 0.3 } },
  };

  // ---------- proportions (art pixels; the house adult stands 57 px with a 10 px head) ----------
  SS.proportions = (cfg) => {
    const b = cfg.body, fem = b.type === 'female';
    const H = b.height / 57, W = b.build;
    const sh = b.shoulders * (fem ? 0.9 : 1), hp = b.hips * (fem ? 1.12 : 1), hd = b.head;
    const P = {
      H, W, fem,
      // legs
      hipX: 3.0 * hp * W, thigh: 11.2 * H, shin: 10.5 * H,
      thighR: [3.1 * W * (fem ? 1.04 : 1), 2.45 * W], shinR: [2.3 * W, 1.7 * W],
      ankleX: 3.05 * hp * W, ankleY: 3.2 * H, ankleZ: -0.4,
      footLen: 9.0 * H, footR: [1.6, 1.4], footW: 1.3, heelBack: 2.1 * H, splay: 8,
      // trunk: the pelvis centre, then offsets from the waist pivot along the spine
      pelvisR: [5.5 * hp * W, 3.3 * H, 4.3 * W],
      hipJointOff: -1.6 * H, waistOff: 3.4 * H,
      abdomen: { off: 1.0 * H, r: [5.55 * W * (fem ? 0.9 : 1), 4.0 * H, 4.3 * W] },
      ribs: { off: 6.6 * H, r: [6.0 * sh * W, 5.0 * H, 4.7 * W] },
      chest: fem ? 0.6 : 0,
      shoulderBar: { off: 10.5 * H, x: 4.3 * sh * W, r: 2.6 * W },
      shoulderX: 6.75 * sh * W, shoulderOff: 11.0 * H,
      neckOff: 13.1 * H, neckLen: 3.2 * H, neckR: 1.85 * W,
      // arms
      upperArm: 8.4 * H, foreArm: 7.0 * H, hand: 3.0 * H,
      upperArmR: [2.05 * W * (fem ? 0.9 : 1), 1.75 * W], foreArmR: [1.75 * W, 1.4 * W], handR: [1.5 * W, 1.3 * W],
      // head
      headR: [4.45 * hd, 4.55 * hd, 4.0 * hd], headUp: 4.4 * H * hd, headFwd: 0.35,
    };
    // stand the pelvis so the legs are all but straight at rest
    P.pelvisY = P.ankleY + (P.thigh + P.shin) * 0.997 - P.hipJointOff;
    return P;
  };

  // ---------- materials ----------
  // Every material carries a 5-shade ramp and the layer it exports into.
  const MAT_LAYERS = {
    skin: 'body', eye: 'body', mouth: 'body', stubble: 'body', wound: 'body',
    hair: 'hair', brow: 'hair',
    top: 'top', topAcc: 'top', under: 'top',
    bottom: 'bottom', bottomAcc: 'bottom', belt: 'bottom', buckle: 'bottom',
    shoe: 'shoes', sole: 'shoes',
    hat: 'hat', hatAcc: 'hat',
    pack: 'acc', strap: 'acc', glove: 'acc', scarf: 'acc', lens: 'acc',
    metal: 'weapon', wood: 'weapon', grip: 'weapon',
    blood: 'fx', smear: 'fx',
  };
  SS.LAYERS = ['body', 'hair', 'top', 'bottom', 'shoes', 'hat', 'acc', 'weapon', 'fx'];

  SS.buildMaterials = (cfg) => {
    const z = cfg.zombie.on ? cfg.zombie : null;
    const skin = z ? SS.mixHex(cfg.skin, '#8f9c80', 0.35 * z.decay) : cfg.skin;
    const base = {
      skin, eye: cfg.face.eyes, mouth: SS.mixHex(skin, '#6a2a2a', z ? 0.7 : 0.42),
      stubble: SS.mixHex(skin, cfg.hair.color, 0.38), wound: '#7a2e2e',
      hair: cfg.hair.color, brow: SS.mixHex(cfg.hair.color, '#140c08', 0.35),
      top: cfg.top.color, topAcc: cfg.top.accent, under: cfg.top.under,
      bottom: cfg.bottom.color, bottomAcc: SS.mixHex(cfg.bottom.color, '#0a0d14', 0.35),
      belt: cfg.extras.beltColor, buckle: '#b9a47a',
      shoe: cfg.shoes.color, sole: cfg.shoes.sole,
      hat: cfg.hat.color, hatAcc: SS.mixHex(cfg.hat.color, '#1e130c', 0.3),
      pack: cfg.extras.packColor, strap: SS.mixHex(cfg.extras.packColor, '#1e130c', 0.45),
      glove: cfg.extras.gloveColor, scarf: cfg.extras.scarfColor, lens: '#2a3140',
      metal: '#a4adb0', wood: '#6b4a30', grip: '#3a2c24',
      blood: '#5e1d1d', smear: '#efe9da',
    };
    const names = Object.keys(base);
    const mats = names.map((n) => {
      let ramp;
      if (n === 'eye') ramp = new Array(5).fill(SS.hex2rgb(base.eye));
      else if (n === 'smear') ramp = SS.makeRamp(base.smear, { offs: [-2.2, -1.2, -0.4, 0, 0.5] });
      else if (n === 'skin') ramp = SS.makeRamp(base.skin, { step: 0.075, hue: 0.12 });
      else ramp = SS.makeRamp(base[n]);
      const pal = SS.PALETTES[cfg.style.palette];
      if (pal && n !== 'eye') ramp = SS.snapRamp(ramp, pal);
      return { name: n, base: base[n], ramp, layer: MAT_LAYERS[n] || 'body' };
    });
    const index = {};
    names.forEach((n, i) => { index[n] = i; });
    return { list: mats, index, ink: SS.hex2rgb(cfg.style.ink) };
  };
})(window.SS);
